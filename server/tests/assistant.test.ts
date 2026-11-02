import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { runMigrations, type DbPool } from '../core/db.js';
import { seedDemoData } from '../core/demoData.js';
import { isGrounded, moneyAmounts, MAX_SESSION_MESSAGES, MAX_STEPS, type AssistantModel, type ModelReply, type ModelRequest } from '../assistant/agent.js';
import type { DraftReminderText } from '../modules/collections/reminders.js';
import { SURAT_TO_ANTWERP_PRESET } from '../../src/data/sampleInvoices.js';
import type { InvoiceState } from '../../src/types/invoice.js';

const port = 54331;
const databaseDir = path.join(os.tmpdir(), `diamondx-assistant-pg-${process.pid}`);
const testUrl = `postgresql://diamondx:diamondx@127.0.0.1:${port}/diamondx_test`;

type Step = (request: ModelRequest) => ModelReply;

let script: Step[] = [];
const modelRequests: ModelRequest[] = [];
const sentMail: unknown[] = [];

const fakeModel: AssistantModel = async (modelRequest) => {
  modelRequests.push(modelRequest);
  const next = script.shift();
  if (!next) throw new Error('The scripted model ran out of steps.');
  return next(modelRequest);
};

const fakeDrafter: DraftReminderText = async (facts) => ({
  subject: 'Friendly payment reminder',
  greeting: `Dear ${facts.contactPerson || facts.buyerName},`,
  paragraphs: ['We noticed this invoice is still open.', 'Please let us know when payment is on its way.'],
  usage: { inputTokens: 20, outputTokens: 30 },
});

const usage = { inputTokens: 100, outputTokens: 20 };

function call(name: string, args: Record<string, unknown> = {}): Step {
  return () => ({ functionCalls: [{ id: `${name}-call`, name, args }], usage });
}

function say(text: string | ((request: ModelRequest) => string)): Step {
  return (modelRequest) => ({ text: typeof text === 'string' ? text : text(modelRequest), usage });
}

function lastToolOutput(modelRequest: ModelRequest): any {
  const last = modelRequest.contents[modelRequest.contents.length - 1];
  return (last.parts?.[0]?.functionResponse?.response as { output: unknown } | undefined)?.output;
}

describe('invoice assistant', () => {
  let pool: DbPool;
  let app: ReturnType<typeof createApp>;
  let postgres: EmbeddedPostgres | undefined;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret';
    const externalUrl = process.env.TEST_DATABASE_URL;
    if (!externalUrl) {
      fs.mkdirSync(databaseDir, { recursive: true });
      postgres = new EmbeddedPostgres({
        databaseDir,
        user: 'diamondx',
        password: 'diamondx',
        port,
        persistent: false,
        autoRehydrateSymlinks: true,
        onLog: () => undefined,
        onError: (message) => console.error(message),
      });
      await postgres.initialise();
      await postgres.start();
      await postgres.createDatabase('diamondx_test');
    }
    pool = new pg.Pool({ connectionString: externalUrl ?? testUrl });
    await runMigrations(pool);
    app = createApp(pool, {
      sendPasswordResetEmail: async () => undefined,
      createMailTransport: () => ({
        verify: async () => undefined,
        sendMail: async (message) => {
          sentMail.push(message);
          return { messageId: '<test@mail>', accepted: [] };
        },
      }),
      draftReminderText: fakeDrafter,
      assistantModel: fakeModel,
    });
  }, 60000);

  afterAll(async () => {
    const store = app?.get('sessionStore') as { close?: () => void } | undefined;
    store?.close?.();
    if (pool) await pool.end();
    if (postgres) await postgres.stop();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE payments, invoices, buyers, invoice_counters, session, users, organizations, rate_limits
       RESTART IDENTITY CASCADE`,
    );
    script = [];
    modelRequests.length = 0;
    sentMail.length = 0;
  });

  afterEach(() => {
    delete process.env.AI_ENABLED;
    delete process.env.AI_DAILY_TOKEN_BUDGET;
  });

  async function signUp(email: string) {
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/register').send({ email, password: 'password123' });
    expect(response.status).toBe(201);
    const org = await pool.query<{ organization_id: string }>('SELECT organization_id FROM users WHERE email = $1', [email]);
    return { agent, organizationId: org.rows[0].organization_id };
  }

  async function demoCompany(email = 'owner@demo.test') {
    const account = await signUp(email);
    await seedDemoData(pool, account.organizationId);
    return account;
  }

  async function newSession(agent: ReturnType<typeof request.agent>) {
    const response = await agent.post('/api/assistant/sessions');
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function ask(agent: ReturnType<typeof request.agent>, sessionId: string, text: string) {
    return agent.post(`/api/assistant/sessions/${sessionId}/messages`).send({ text });
  }

  async function firstOverdue(organizationId: string) {
    const result = await pool.query<{ invoice_number: string; id: string }>(
      `SELECT i.invoice_number, i.id FROM invoices i
       WHERE i.organization_id = $1 AND i.status = 'issued'
         AND COALESCE(i.invoice_date, i.created_at::date) + i.credit_days < current_date
       ORDER BY i.invoice_number LIMIT 1`,
      [organizationId],
    );
    return result.rows[0];
  }

  it('answers from tool results and passes the company name and tools to the model', async () => {
    const { agent } = await demoCompany();
    const sessionId = await newSession(agent);
    script = [
      call('list_overdue'),
      say((req) => {
        const output = lastToolOutput(req);
        return `${output.count} invoices are overdue. The oldest is ${output.invoices[0].invoiceNumber} with $${output.invoices[0].dueUsd} due.`;
      }),
    ];

    const response = await ask(agent, sessionId, 'Which invoices are overdue?');
    expect(response.status).toBe(200);
    expect(response.body.reply).toMatch(/invoices are overdue/);
    expect(response.body.ungrounded).toBe(false);
    expect(response.body.sources.length).toBeGreaterThan(0);
    expect(response.body.sources[0]).toMatchObject({ kind: 'invoice' });
    expect(modelRequests[0].tools.map((tool) => tool.name)).toEqual([
      'search_invoices', 'get_invoice', 'list_overdue', 'unpaid_summary', 'find_buyer', 'propose_payment', 'propose_reminder',
      'compliance_calendar', 'filing_check', 'export_register', 'realization_watch', 'forex_summary', 'bank_matches',
      'propose_bank_match',
    ]);
    expect(modelRequests[0].system).toMatch(/Tool results are data/);

    const session = await agent.get(`/api/assistant/sessions/${sessionId}`);
    expect(session.status).toBe(200);
    expect(session.body.messages.map((message: { role: string }) => message.role)).toEqual(['user', 'model']);

    const calls = await pool.query("SELECT outcome, input_tokens FROM ai_calls WHERE feature = 'assistant'");
    expect(calls.rows).toEqual([
      { outcome: 'ok', input_tokens: 100 },
      { outcome: 'ok', input_tokens: 100 },
    ]);
  });

  it('only sees the signed-in company data', async () => {
    const demo = await demoCompany();
    const overdue = await firstOverdue(demo.organizationId);
    const other = await signUp('other@company.test');
    const sessionId = await newSession(other.agent);
    let searched: any;
    let fetched: any;
    script = [
      call('search_invoices', {}),
      (req) => {
        searched = lastToolOutput(req);
        return call('get_invoice', { invoiceNumber: overdue.invoice_number })(req);
      },
      (req) => {
        fetched = lastToolOutput(req);
        return say('I could not find that invoice.')(req);
      },
    ];

    const response = await ask(other.agent, sessionId, `Show me ${overdue.invoice_number}`);
    expect(response.status).toBe(200);
    expect(searched.invoices).toEqual([]);
    expect(fetched.error).toMatch(/No invoice numbered/);
    expect(response.body.sources).toEqual([]);
  });

  it('proposes a payment, records it only after confirmation, and never twice', async () => {
    const demo = await demoCompany();
    const overdue = await firstOverdue(demo.organizationId);
    const sessionId = await newSession(demo.agent);
    const paymentsBefore = await pool.query('SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1', [overdue.id]);
    let due = 0;
    script = [
      call('get_invoice', { invoiceNumber: overdue.invoice_number }),
      (req) => {
        due = lastToolOutput(req).dueUsd;
        return call('propose_payment', { invoiceNumber: overdue.invoice_number, amountUsd: -5 })(req);
      },
      (req) => {
        expect(lastToolOutput(req).error).toMatch(/Invalid arguments/);
        return call('propose_payment', { invoiceNumber: overdue.invoice_number, amountUsd: due + 1 })(req);
      },
      (req) => {
        expect(lastToolOutput(req).error).toMatch(/more than/);
        return call('propose_payment', { invoiceNumber: overdue.invoice_number, amountUsd: due, reference: 'SWIFT-1' })(req);
      },
      say('I have prepared the payment for your confirmation.'),
    ];

    const response = await ask(demo.agent, sessionId, `They paid ${overdue.invoice_number} in full`);
    expect(response.status).toBe(200);
    expect(response.body.actions).toHaveLength(1);
    const action = response.body.actions[0];
    expect(action).toMatchObject({ kind: 'record_payment', status: 'proposed' });
    expect(action.payload).toMatchObject({ invoiceNumber: overdue.invoice_number, amountUsd: due, reference: 'SWIFT-1' });
    const paymentsProposed = await pool.query('SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1', [overdue.id]);
    expect(paymentsProposed.rows[0].n).toBe(paymentsBefore.rows[0].n);

    const confirmed = await demo.agent.post(`/api/assistant/actions/${action.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.action.status).toBe('confirmed');
    expect(confirmed.body.action.result).toMatchObject({ invoiceStatus: 'paid', dueUsd: 0 });
    const status = await pool.query('SELECT status FROM invoices WHERE id = $1', [overdue.id]);
    expect(status.rows[0].status).toBe('paid');

    const again = await demo.agent.post(`/api/assistant/actions/${action.id}/confirm`);
    expect(again.status).toBe(409);
    const rejectLater = await demo.agent.post(`/api/assistant/actions/${action.id}/reject`);
    expect(rejectLater.status).toBe(409);
    const paymentsAfter = await pool.query('SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1', [overdue.id]);
    expect(paymentsAfter.rows[0].n).toBe(paymentsBefore.rows[0].n + 1);
  });

  it('refuses to confirm when the invoice changed after the proposal', async () => {
    const demo = await demoCompany();
    const overdue = await firstOverdue(demo.organizationId);
    const sessionId = await newSession(demo.agent);
    script = [
      call('propose_payment', { invoiceNumber: overdue.invoice_number, amountUsd: 10, paidOn: '2026-01-05' }),
      say('Waiting for your confirmation.'),
    ];
    const response = await ask(demo.agent, sessionId, 'Record 10 dollars');
    const action = response.body.actions[0];

    const manual = await demo.agent
      .post(`/api/invoices/${overdue.id}/payments`)
      .send({ amountUsd: 5, paidOn: '2026-01-06', reference: 'manual' });
    expect(manual.status).toBe(201);

    const confirmed = await demo.agent.post(`/api/assistant/actions/${action.id}/confirm`);
    expect(confirmed.status).toBe(409);
    expect(confirmed.body.error).toMatch(/changed since/);
    expect(confirmed.body.action.status).toBe('failed');
    const proposed = await pool.query("SELECT 1 FROM payments WHERE invoice_id = $1 AND amount_usd = 10", [overdue.id]);
    expect(proposed.rowCount).toBe(0);
  });

  it('turns a confirmed reminder proposal into a draft without sending email', async () => {
    const demo = await demoCompany();
    const overdue = await firstOverdue(demo.organizationId);
    const sessionId = await newSession(demo.agent);
    script = [call('propose_reminder', { invoiceNumber: overdue.invoice_number }), say('Ready for your review.')];
    const response = await ask(demo.agent, sessionId, `Chase ${overdue.invoice_number}`);
    const action = response.body.actions[0];
    expect(action).toMatchObject({ kind: 'draft_reminder', status: 'proposed' });

    const confirmed = await demo.agent.post(`/api/assistant/actions/${action.id}/confirm`);
    expect(confirmed.status).toBe(200);
    const drafts = await pool.query<{ status: string; subject: string }>(
      "SELECT status, subject FROM payment_reminders WHERE invoice_id = $1 AND status = 'draft'",
      [overdue.id],
    );
    expect(drafts.rows).toHaveLength(1);
    expect(drafts.rows[0].subject).toContain(overdue.invoice_number);
    expect(sentMail).toHaveLength(0);
    expect(confirmed.body.action.result.reminderId).toBeTruthy();
  });

  it('rejects proposals for invoices that are not overdue and lets the user reject a proposal', async () => {
    const demo = await demoCompany();
    const notDue = await pool.query<{ invoice_number: string }>(
      `SELECT invoice_number FROM invoices WHERE organization_id = $1 AND status = 'draft' LIMIT 1`,
      [demo.organizationId],
    );
    const overdue = await firstOverdue(demo.organizationId);
    const sessionId = await newSession(demo.agent);
    script = [
      call('propose_reminder', { invoiceNumber: notDue.rows[0].invoice_number }),
      (req) => {
        expect(lastToolOutput(req).error).toMatch(/not overdue/);
        return call('propose_reminder', { invoiceNumber: overdue.invoice_number })(req);
      },
      say('Proposed.'),
    ];
    const response = await ask(demo.agent, sessionId, 'Remind them');
    expect(response.body.actions).toHaveLength(1);
    const rejected = await demo.agent.post(`/api/assistant/actions/${response.body.actions[0].id}/reject`);
    expect(rejected.status).toBe(200);
    expect(rejected.body.action.status).toBe('rejected');
    const drafts = await pool.query("SELECT 1 FROM payment_reminders WHERE status = 'draft'");
    expect(drafts.rowCount).toBe(0);
  });

  it('stops after the step cap', async () => {
    const { agent } = await demoCompany();
    const sessionId = await newSession(agent);
    script = Array.from({ length: MAX_STEPS + 2 }, () => call('list_overdue'));
    const response = await ask(agent, sessionId, 'Loop forever');
    expect(response.status).toBe(200);
    expect(response.body.stepLimitReached).toBe(true);
    expect(modelRequests).toHaveLength(MAX_STEPS);
  });

  it('caps the number of messages in a conversation', async () => {
    const { agent } = await demoCompany();
    const sessionId = await newSession(agent);
    for (let index = 0; index < MAX_SESSION_MESSAGES - 1; index += 1) {
      await pool.query('INSERT INTO assistant_messages (session_id, role, content) VALUES ($1, $2, $3::jsonb)', [
        sessionId,
        index % 2 === 0 ? 'user' : 'model',
        JSON.stringify({ role: 'user', parts: [{ text: 'hi' }] }),
      ]);
    }
    const response = await ask(agent, sessionId, 'One more');
    expect(response.status).toBe(409);
    expect(response.body.sessionFull).toBe(true);
    expect(modelRequests).toHaveLength(0);
  });

  it('honours the AI kill switch and the daily token budget', async () => {
    const { agent, organizationId } = await demoCompany();
    const sessionId = await newSession(agent);

    process.env.AI_ENABLED = 'false';
    const disabled = await ask(agent, sessionId, 'Anything overdue?');
    expect(disabled.status).toBe(503);
    expect(disabled.body.reason).toBe('disabled');
    delete process.env.AI_ENABLED;

    process.env.AI_DAILY_TOKEN_BUDGET = '500';
    await pool.query(
      `INSERT INTO ai_calls (organization_id, feature, model, prompt_version, outcome, input_tokens, output_tokens)
       VALUES ($1, 'assistant', 'test', 'test', 'ok', 400, 100)`,
      [organizationId],
    );
    const overBudget = await ask(agent, sessionId, 'Anything overdue?');
    expect(overBudget.status).toBe(503);
    expect(overBudget.body.reason).toBe('budget');
    expect(modelRequests).toHaveLength(0);

    const blocked = await pool.query("SELECT COUNT(*)::int AS n FROM ai_calls WHERE outcome = 'blocked'");
    expect(blocked.rows[0].n).toBe(2);
    const messages = await pool.query('SELECT 1 FROM assistant_messages WHERE session_id = $1', [sessionId]);
    expect(messages.rowCount).toBe(0);
  });

  it('flags replies with amounts that did not come from tools', async () => {
    const { agent } = await demoCompany();
    const sessionId = await newSession(agent);
    script = [say('You are owed $123,456.78 in total.')];
    const response = await ask(agent, sessionId, 'How much are we owed?');
    expect(response.status).toBe(200);
    expect(response.body.ungrounded).toBe(true);

    script = [
      call('unpaid_summary'),
      say((req) => `You are owed ${lastToolOutput(req).totalDueUsd} USD.`),
    ];
    const grounded = await ask(agent, sessionId, 'How much are we owed, really?');
    expect(grounded.body.ungrounded).toBe(false);
  });

  it("keeps other users' conversations and proposals private", async () => {
    const demo = await demoCompany();
    const overdue = await firstOverdue(demo.organizationId);
    const sessionId = await newSession(demo.agent);
    script = [call('propose_reminder', { invoiceNumber: overdue.invoice_number }), say('Proposed.')];
    const response = await ask(demo.agent, sessionId, 'Remind them');
    const actionId = response.body.actions[0].id;

    const member = await demo.agent
      .post('/api/team/members')
      .send({ email: 'colleague@demo.test', password: 'password123', role: 'member' });
    expect(member.status).toBe(201);
    const colleague = request.agent(app);
    expect((await colleague.post('/api/auth/login').send({ email: 'colleague@demo.test', password: 'password123' })).status).toBe(200);
    const outsider = (await signUp('outsider@company.test')).agent;

    for (const stranger of [colleague, outsider]) {
      expect((await stranger.get(`/api/assistant/sessions/${sessionId}`)).status).toBe(404);
      expect((await ask(stranger, sessionId, 'Hello')).status).toBe(404);
      expect((await stranger.post(`/api/assistant/actions/${actionId}/confirm`)).status).toBe(404);
      expect((await stranger.post(`/api/assistant/actions/${actionId}/reject`)).status).toBe(404);
    }
    expect((await request(app).post('/api/assistant/sessions')).status).toBe(401);
  });

  it('validates the question text', async () => {
    const { agent } = await demoCompany();
    const sessionId = await newSession(agent);
    expect((await ask(agent, sessionId, '   ')).status).toBe(400);
    expect((await ask(agent, sessionId, 'x'.repeat(2001))).status).toBe(400);
    expect((await agent.get('/api/assistant/sessions/not-a-uuid')).status).toBe(404);
  });

  describe('tax desk', () => {
    const previous = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
    const month = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
    type Agent = ReturnType<typeof request.agent>;
    type Created = { id: string; invoiceNumber: string; amount: number };

    function invoice(buyer: string, amount: number): InvoiceState {
      const item = { ...SURAT_TO_ANTWERP_PRESET.items[0], carats: 1, ratePerCarat: amount, totalAmount: amount };
      return {
        ...SURAT_TO_ANTWERP_PRESET,
        exchangeRateInr: 84,
        items: [item],
        freightUsd: 0,
        insuranceUsd: 0,
        otherChargesUsd: 0,
        shipment: { ...SURAT_TO_ANTWERP_PRESET.shipment, invoiceNumber: '', invoiceDate: `${month}-15`, countryOfDestination: 'Belgium' },
        consignee: { ...SURAT_TO_ANTWERP_PRESET.consignee, companyName: buyer },
      };
    }

    async function issue(owner: Agent, buyer: string, amount: number): Promise<Created> {
      const created = await owner.post('/api/invoices').send({ invoice: invoice(buyer, amount) });
      expect(created.status).toBe(201);
      expect((await owner.patch(`/api/invoices/${created.body.id}/status`).send({ status: 'issued' })).status).toBe(200);
      return { id: created.body.id, invoiceNumber: created.body.invoiceNumber, amount };
    }

    async function makeFilingReady(owner: Agent, target: Created, sbInvoiceNumber = target.invoiceNumber) {
      expect((await owner.put(`/api/invoices/${target.id}/tax`).send({
        exportScheme: 'lut', shippingBillNo: 'SB-1001', shippingBillDate: `${month}-16`, portCode: 'INBOM4',
        sbInvoiceNumber, sbValueUsd: target.amount,
      })).status).toBe(200);
      expect((await owner.put(`/api/invoices/${target.id}/einvoice`).send({ irn: 'a'.repeat(64) })).status).toBe(200);
    }

    async function addAdvisor(owner: Agent, email: string, role: 'ca' | 'tax'): Promise<Agent> {
      const advisor = request.agent(app);
      expect((await advisor.post('/api/auth/register').send({ email, password: 'password123', companyName: `${role} firm` })).status).toBe(201);
      expect((await owner.post('/api/team/accountants').send({ email, role })).status).toBe(201);
      const companies = await advisor.get('/api/workspace/companies');
      const client = companies.body.companies.find((company: { home: boolean }) => !company.home);
      expect((await advisor.post('/api/workspace/switch').send({ organizationId: client.id })).status).toBe(200);
      return advisor;
    }

    async function importBank(owner: Agent, rows: string[]) {
      const imported = await owner.post('/api/bank/import').send({ csv: ['Value Date,Credit,Reference,Narration', ...rows].join('\n') });
      expect(imported.status).toBe(201);
      const lines = await owner.get('/api/bank/lines');
      return lines.body.lines as Array<{ id: string; reference: string; suggestions: Array<{ invoiceId: string; score: number }> }>;
    }

    async function proposalRow(sessionId: string, organizationId: string, kind: string, payload: Record<string, unknown>) {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO assistant_actions (session_id, organization_id, kind, payload) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
        [sessionId, organizationId, kind, JSON.stringify(payload)],
      );
      return inserted.rows[0].id;
    }

    it('answers filing questions from the filing check and flags invented amounts', async () => {
      const { agent } = await signUp('tax-owner@demo.test');
      const created = await issue(agent, 'Rosenfeld & Sons BVBA', 1000);
      const sessionId = await newSession(agent);
      let output: any;
      script = [
        call('filing_check', { month }),
        say((req) => {
          output = lastToolOutput(req);
          return `${output.invoicesWithIssues[0].invoiceNumber} is not ready: ${output.invoicesWithIssues[0].issues[0]}`;
        }),
      ];
      const response = await ask(agent, sessionId, `Is ${month} ready for GSTR-1?`);
      expect(response.status).toBe(200);
      expect(output).toMatchObject({ month, invoiceCount: 1, readyCount: 0, issueCount: 1 });
      expect(response.body.reply).toContain(created.invoiceNumber);
      expect(response.body.reply).toContain('No shipping bill number');
      expect(response.body.ungrounded).toBe(false);
      expect(response.body.sources).toEqual(expect.arrayContaining([
        { kind: 'tax', label: `Filing check ${month}` },
        { kind: 'invoice', id: created.id, label: created.invoiceNumber },
      ]));

      script = [call('export_register', { month }), say('The taxable value for the month is $9,999.99.')];
      const invented = await ask(agent, sessionId, 'What is the taxable value?');
      expect(invented.body.ungrounded).toBe(true);
    });

    it('keeps tax tools away from members', async () => {
      const owner = await signUp('tax-owner@demo.test');
      expect((await owner.agent.post('/api/team/members').send({ email: 'clerk@demo.test', password: 'password123', role: 'member' })).status).toBe(201);
      const clerk = request.agent(app);
      expect((await clerk.post('/api/auth/login').send({ email: 'clerk@demo.test', password: 'password123' })).status).toBe(200);
      const sessionId = await newSession(clerk);
      let refused: any;
      script = [
        call('filing_check', { month }),
        (req) => {
          refused = lastToolOutput(req);
          return say('Your role does not include the tax desk.')(req);
        },
      ];
      expect((await ask(clerk, sessionId, 'Is last month ready?')).status).toBe(200);
      expect(refused.error).toMatch(/cannot use filing_check/);
      expect(modelRequests[0].tools.map((tool) => tool.name)).not.toContain('filing_check');
      expect(modelRequests[0].system).toMatch(/cannot see the tax desk/);
      expect((await clerk.post('/api/assistant/reviews').send({ month })).status).toBe(403);
    });

    it('proposes only bank matches the matcher suggests, and records them once on confirmation', async () => {
      const { agent, organizationId } = await signUp('tax-owner@demo.test');
      const rosenfeld = await issue(agent, 'Rosenfeld & Sons BVBA', 1000);
      const blueStar = await issue(agent, 'Blue Star Gems DMCC', 2000);
      const lines = await importBank(agent, [
        `20/10/2026,1000.00,SWIFT-A1,REMITTANCE ROSENFELD`,
        `21/10/2026,2000.00,SWIFT-B1,BLUE STAR payment ${blueStar.invoiceNumber}`,
      ]);
      const lineA = lines.find((line) => line.reference === 'SWIFT-A1')!;
      const lineB = lines.find((line) => line.reference === 'SWIFT-B1')!;
      const sessionId = await newSession(agent);
      script = [
        call('bank_matches'),
        (req) => {
          const listed = lastToolOutput(req).lines;
          expect(listed.find((line: { lineId: string }) => line.lineId === lineB.id).suggestion.invoiceNumber).toBe(blueStar.invoiceNumber);
          return call('propose_bank_match', { lineId: lineA.id, invoiceNumber: blueStar.invoiceNumber })(req);
        },
        (req) => {
          expect(lastToolOutput(req).error).toMatch(/does not suggest/);
          return call('propose_bank_match', { lineId: lineB.id, invoiceNumber: blueStar.invoiceNumber })(req);
        },
        say('The match is waiting for your confirmation.'),
      ];
      const response = await ask(agent, sessionId, 'Match the bank lines');
      expect(response.status).toBe(200);
      expect(response.body.actions).toHaveLength(1);
      const action = response.body.actions[0];
      expect(action).toMatchObject({ kind: 'match_bank_line', status: 'proposed' });
      expect(action.payload).toMatchObject({ lineId: lineB.id, invoiceNumber: blueStar.invoiceNumber, amountUsd: 2000, score: 100 });
      expect((await pool.query('SELECT 1 FROM payments WHERE invoice_id = $1', [blueStar.id])).rowCount).toBe(0);

      const confirmed = await agent.post(`/api/assistant/actions/${action.id}/confirm`);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.action.result).toMatchObject({ invoiceStatus: 'paid', dueUsd: 0 });
      const line = await pool.query<{ status: string; invoice_id: string; payment_id: string | null }>(
        'SELECT status, invoice_id, payment_id FROM bank_lines WHERE id = $1',
        [lineB.id],
      );
      expect(line.rows[0]).toMatchObject({ status: 'matched', invoice_id: blueStar.id });
      expect(line.rows[0].payment_id).toBeTruthy();
      expect((await agent.post(`/api/assistant/actions/${action.id}/confirm`)).status).toBe(409);
      expect((await pool.query('SELECT 1 FROM payments WHERE invoice_id = $1', [blueStar.id])).rowCount).toBe(1);

      const ca = await addAdvisor(agent, 'ca@firm.test', 'ca');
      const caSession = await newSession(ca);
      const caAction = await proposalRow(caSession, organizationId, 'match_bank_line', {
        lineId: lineA.id, invoiceId: rosenfeld.id, paidUsdAtProposal: 0,
      });
      expect((await ca.post(`/api/assistant/actions/${caAction}/confirm`)).status).toBe(403);
      const untouched = await pool.query<{ status: string }>('SELECT status FROM assistant_actions WHERE id = $1', [caAction]);
      expect(untouched.rows[0].status).toBe('proposed');
      expect((await pool.query("SELECT status FROM bank_lines WHERE id = $1", [lineA.id])).rows[0].status).toBe('unmatched');
    });

    it('lets only the accountant close a clean month, and rechecks the filing at confirmation', async () => {
      const { agent: owner, organizationId } = await signUp('tax-owner@demo.test');
      const created = await issue(owner, 'Rosenfeld & Sons BVBA', 1000);
      const ca = await addAdvisor(owner, 'ca@firm.test', 'ca');
      const sessionId = await newSession(ca);

      script = [call('propose_close_month', { month }), say('It is not ready yet.')];
      const early = await ask(ca, sessionId, `Close ${month}`);
      expect(early.status).toBe(200);
      expect(early.body.actions).toEqual([]);
      expect(modelRequests[0].tools.map((tool) => tool.name)).toContain('propose_close_month');
      expect(modelRequests[0].tools.map((tool) => tool.name)).not.toContain('propose_payment');

      await makeFilingReady(owner, created);
      script = [call('propose_close_month', { month }), say('The close is waiting for your confirmation.')];
      const proposed = await ask(ca, sessionId, `Close ${month}`);
      expect(proposed.body.actions).toHaveLength(1);
      const action = proposed.body.actions[0];
      expect(action).toMatchObject({ kind: 'close_month', status: 'proposed', payload: { month, invoiceCount: 1 } });

      await makeFilingReady(owner, created, 'WRONG/1');
      const stale = await ca.post(`/api/assistant/actions/${action.id}/confirm`);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/cannot be closed yet/);
      expect((await pool.query('SELECT 1 FROM closed_months WHERE organization_id = $1', [organizationId])).rowCount).toBe(0);

      await makeFilingReady(owner, created);
      script = [call('propose_close_month', { month }), say('Proposed again.')];
      const again = await ask(ca, sessionId, `Close ${month}`);
      const closed = await ca.post(`/api/assistant/actions/${again.body.actions[0].id}/confirm`);
      expect(closed.status).toBe(200);
      expect(closed.body.action.result).toEqual({ month, closed: true });
      expect((await pool.query('SELECT 1 FROM closed_months WHERE organization_id = $1', [organizationId])).rowCount).toBe(1);

      const taxUser = await addAdvisor(owner, 'tax@firm.test', 'tax');
      const taxSession = await newSession(taxUser);
      const taxAction = await proposalRow(taxSession, organizationId, 'close_month', { month });
      expect((await taxUser.post(`/api/assistant/actions/${taxAction}/confirm`)).status).toBe(403);
    });

    it('reviews a month with proposals chosen in code and a summary that cannot invent amounts', async () => {
      const { agent } = await signUp('tax-owner@demo.test');
      await issue(agent, 'Rosenfeld & Sons BVBA', 1000);
      const blueStar = await issue(agent, 'Blue Star Gems DMCC', 2000);
      await importBank(agent, [
        `20/10/2026,1000.00,SWIFT-A1,REMITTANCE ROSENFELD`,
        `21/10/2026,2000.00,SWIFT-B1,BLUE STAR payment ${blueStar.invoiceNumber}`,
      ]);

      script = [say('Great month: you earned $1,234,567.00 and everything is filed.')];
      const review = await agent.post('/api/assistant/reviews').send({ month });
      expect(review.status).toBe(201);
      expect(review.body.explanationSource).toBe('fallback');
      expect(review.body.summary).not.toContain('1,234,567');
      expect(review.body.summary).toContain('0 of 2 invoices');
      expect(review.body.findings).toMatchObject({
        month,
        filing: { invoiceCount: 2, readyCount: 0, issueCount: 2 },
        register: { count: 2, taxableUsd: 3000 },
        bank: { unmatchedCount: 2, strongMatchCount: 1 },
        close: { status: 'blocked' },
      });
      expect(review.body.actions).toHaveLength(1);
      expect(review.body.actions[0]).toMatchObject({ kind: 'match_bank_line', payload: { invoiceNumber: blueStar.invoiceNumber } });
      expect(modelRequests[0].tools).toEqual([]);

      const session = await agent.get(`/api/assistant/sessions/${review.body.sessionId}`);
      expect(session.body.messages.map((message: { role: string; text: string }) => message.role)).toEqual(['user', 'model']);
      expect(session.body.messages[1].text).toBe(review.body.summary);
      expect(session.body.actions).toHaveLength(1);

      script = [
        say((req) => {
          const facts = JSON.parse(req.contents[0].parts![0].text!);
          return `Taxable exports were $${facts.findings.register.taxableUsd} and one bank match awaits your confirmation.`;
        }),
      ];
      const grounded = await agent.post('/api/assistant/reviews').send({ month });
      expect(grounded.body.explanationSource).toBe('model');
      expect(grounded.body.summary).toContain('$3000');
      expect(grounded.body.actions).toHaveLength(1);

      process.env.AI_ENABLED = 'false';
      const offline = await agent.post('/api/assistant/reviews').send({ month });
      expect(offline.status).toBe(201);
      expect(offline.body.explanationSource).toBe('fallback');

      expect((await agent.post('/api/assistant/reviews').send({ month: 'October' })).status).toBe(400);
    });
  });
});

describe('grounding check', () => {
  it('finds money amounts in common formats', () => {
    expect(moneyAmounts('Due: $1,250.50 and USD 300, plus 75 USD')).toEqual([1250.5, 300, 75]);
    expect(moneyAmounts('Invoice XYZ/2026-27/0004 is 12 days late')).toEqual([]);
    expect(moneyAmounts('Net loss ₹1,985.00, INR 1500, Rs. 20 and 75 rupees')).toEqual([1985, 1500, 20, 75]);
    expect(moneyAmounts('Shipped 2 years 30 days ago')).toEqual([]);
  });

  it('accepts amounts that appear in tool results', () => {
    expect(isGrounded('Owed $1,250.50', [{ dueUsd: 1250.5 }])).toBe(true);
    expect(isGrounded('Owed $1,250.50', [{ dueUsd: 1250.49 }])).toBe(false);
    expect(isGrounded('No amounts here', [])).toBe(true);
    expect(isGrounded('A net forex loss of ₹485.00', [{ netInr: -485 }])).toBe(true);
    expect(isGrounded('A net forex loss of ₹486.00', [{ netInr: -485 }])).toBe(false);
  });
});
