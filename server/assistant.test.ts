import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { runMigrations, type DbPool } from './db.js';
import { seedDemoData } from './demoData.js';
import { isGrounded, moneyAmounts, MAX_SESSION_MESSAGES, MAX_STEPS, type AssistantModel, type ModelReply, type ModelRequest } from './assistant/agent.js';
import type { DraftReminderText } from './reminders.js';

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
});

describe('grounding check', () => {
  it('finds money amounts in common formats', () => {
    expect(moneyAmounts('Due: $1,250.50 and USD 300, plus 75 USD')).toEqual([1250.5, 300, 75]);
    expect(moneyAmounts('Invoice XYZ/2026-27/0004 is 12 days late')).toEqual([]);
  });

  it('accepts amounts that appear in tool results', () => {
    expect(isGrounded('Owed $1,250.50', [{ dueUsd: 1250.5 }])).toBe(true);
    expect(isGrounded('Owed $1,250.50', [{ dueUsd: 1250.49 }])).toBe(false);
    expect(isGrounded('No amounts here', [])).toBe(true);
  });
});
