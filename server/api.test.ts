import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadMigrations, runMigrations, type DbPool } from './db.js';
import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_TEAM, seedDemoUser } from './seed.js';
import { DEMO_INVOICE_TARGET, seedDemoData } from './demoData.js';
import { invoiceFacts, validateInvoice } from './invoiceValidation.js';
import { createSmtpTransport, type SmtpSettings } from './emailDispatch.js';
import type { DraftReminderText, ReminderPromptFacts } from './reminders.js';
import { MUMBAI_TO_NY_PRESET, SURAT_TO_ANTWERP_PRESET, SURAT_TO_DUBAI_PRESET } from '../src/data/sampleInvoices.js';
import type { InvoiceState } from '../src/types/invoice.js';

const port = 54329;
const databaseDir = path.join(os.tmpdir(), `diamondx-pg-${process.pid}`);
const testUrl = `postgresql://diamondx:diamondx@127.0.0.1:${port}/diamondx_test`;

type InvoiceOverrides = Omit<Partial<InvoiceState>, 'shipment' | 'consignee'> & {
  shipment?: Partial<InvoiceState['shipment']>;
  consignee?: Partial<InvoiceState['consignee']>;
};

function invoiceWith(base: InvoiceState, overrides: InvoiceOverrides): InvoiceState {
  return {
    ...base,
    ...overrides,
    shipment: { ...base.shipment, ...overrides.shipment },
    consignee: { ...base.consignee, ...overrides.consignee },
  };
}

function line(carats: number, ratePerCarat: number) {
  return {
    ...SURAT_TO_ANTWERP_PRESET.items[0],
    carats,
    ratePerCarat,
    totalAmount: Math.round(carats * ratePerCarat * 100) / 100,
  };
}

const sampleInvoice = invoiceWith(SURAT_TO_ANTWERP_PRESET, {
  consignee: { companyName: 'Buyer BVBA' },
  shipment: { invoiceNumber: 'EXP-100' },
  items: [],
});

const pricedInvoice = invoiceWith(SURAT_TO_ANTWERP_PRESET, {
  consignee: { companyName: 'Antwerp Gems BVBA', country: 'Belgium' },
  shipment: { invoiceNumber: '', invoiceDate: '2026-10-15', countryOfDestination: 'Belgium' },
  items: [line(1.25, 480), line(1, 400)],
  freightUsd: 30,
  insuranceUsd: 20,
  otherChargesUsd: 0,
});

const sentResetEmails: Array<{ to: string; link: string }> = [];
const smtpCalls: Array<{ settings: SmtpSettings; message?: Record<string, any> }> = [];

const reminderPrompts: ReminderPromptFacts[] = [];
let reminderDrafter: DraftReminderText = async () => {
  throw new Error('No drafter configured for this test.');
};

const smtpConfig = { host: 'smtp.example.com', port: 587, secure: false, user: 'desk@example.com', pass: 'secret' };

function emailBody(overrides: Record<string, unknown> = {}) {
  return {
    smtpConfig,
    emailData: { recipients: ['buyer@example.com'], cc: [], subject: 'Invoice EXP-1', htmlBody: '<p>Hi</p>', invoiceNumber: 'EXP-1' },
    attachments: [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4').toString('base64'), contentType: 'application/pdf' }],
    ...overrides,
  };
}

describe('auth and invoices', () => {
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
      sendPasswordResetEmail: async (to, link) => {
        sentResetEmails.push({ to, link });
      },
      createMailTransport: (settings) => ({
        verify: async () => {
          smtpCalls.push({ settings });
        },
        sendMail: async (message) => {
          smtpCalls.push({ settings, message });
          return { messageId: '<test@mail>', accepted: [] };
        },
      }),
      draftReminderText: (facts) => {
        reminderPrompts.push(facts);
        return reminderDrafter(facts);
      },
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
      `TRUNCATE TABLE payments, invoices, buyers, invoice_counters, password_reset_tokens, session, users, organizations,
         rate_limits
       RESTART IDENTITY CASCADE`,
    );
    sentResetEmails.length = 0;
    smtpCalls.length = 0;
    reminderPrompts.length = 0;
    reminderDrafter = async () => {
      throw new Error('No drafter configured for this test.');
    };
  });

  async function daysAgo(days: number): Promise<string> {
    const result = await pool.query<{ day: string }>("SELECT to_char(current_date - $1::int, 'YYYY-MM-DD') AS day", [days]);
    return result.rows[0].day;
  }

  async function issuedInvoice(agent: ReturnType<typeof request.agent>, invoiceDate: string, creditDays: number) {
    const created = await agent.post('/api/invoices').send({
      invoice: invoiceWith(pricedInvoice, { shipment: { invoiceDate, creditDays } }),
    });
    expect(created.status).toBe(201);
    const issued = await agent.patch(`/api/invoices/${created.body.id}/status`).send({ status: 'issued' });
    expect(issued.status).toBe(200);
    return created.body as { id: string; invoiceNumber: string };
  }

  async function signUp(email: string, companyName?: string) {
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/register').send({ email, password: 'password123', companyName });
    expect(response.status).toBe(201);
    return agent;
  }

  it('records migrations once and rolls back a failed migration', async () => {
    expect(await runMigrations(pool)).toEqual([]);
    const versions = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(versions.rows.map((row) => row.version)).toEqual(loadMigrations().map((migration) => migration.version));

    const broken = { version: '999_broken', checksum: 'x', sql: 'CREATE TABLE migration_probe (id INT); SELECT nope;' };
    await expect(runMigrations(pool, [broken])).rejects.toThrow(/Migration 999_broken failed/);
    const probe = await pool.query("SELECT to_regclass('migration_probe') AS name");
    expect(probe.rows[0].name).toBeNull();
    const recorded = await pool.query("SELECT 1 FROM schema_migrations WHERE version = '999_broken'");
    expect(recorded.rowCount).toBe(0);
  });

  it('reports health from the database', async () => {
    const healthy = await request(app).get('/api/health');
    expect(healthy.status).toBe(200);
    expect(healthy.body).toEqual({ status: 'ok', database: 'ok' });
    expect(healthy.headers['cache-control']).toBe('no-store');

    const deadPool = new pg.Pool({ connectionString: 'postgresql://x:y@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const unhealthy = await request(createApp(deadPool)).get('/api/health');
      expect(unhealthy.status).toBe(503);
      expect(unhealthy.body.status).toBe('error');
    } finally {
      console.error = originalError;
      await deadPool.end();
    }
  });

  it('creates the demo account outside production and disables its public password in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      await seedDemoUser(pool);
      expect((await pool.query('SELECT 1 FROM users WHERE email = $1', [DEMO_EMAIL])).rowCount).toBe(0);

      process.env.NODE_ENV = 'development';
      await seedDemoUser(pool);
      const demoLogin = () => request(app).post('/api/auth/login').send({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
      expect((await demoLogin()).status).toBe(200);

      process.env.NODE_ENV = 'production';
      await seedDemoUser(pool);
      expect((await demoLogin()).status).toBe(401);
      expect((await pool.query('SELECT 1 FROM users WHERE email = $1', [DEMO_EMAIL])).rowCount).toBe(1);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('seeds demo data once, with overdue invoices that pass validation', async () => {
    await seedDemoUser(pool);
    await seedDemoUser(pool);
    const org = await pool.query<{ organization_id: string }>('SELECT organization_id FROM users WHERE email = $1', [DEMO_EMAIL]);
    const organizationId = org.rows[0].organization_id;
    expect((await seedDemoData(pool, organizationId)).invoices).toBe(0);

    const invoices = await pool.query<{ data: unknown; status: string; invoice_number: string; total_usd: string }>(
      'SELECT data, status, invoice_number, total_usd FROM invoices WHERE organization_id = $1',
      [organizationId],
    );
    expect(invoices.rowCount).toBe(DEMO_INVOICE_TARGET);
    expect(new Set(invoices.rows.map((row) => row.status))).toEqual(new Set(['draft', 'issued', 'paid', 'cancelled']));
    for (const row of invoices.rows) {
      const validation = validateInvoice(row.data);
      expect(validation.ok).toBe(true);
      if (validation.ok) expect(invoiceFacts(validation.invoice).totalUsd).toBe(Number(row.total_usd));
      expect(row.invoice_number).toMatch(/^XYZ\//);
    }
    const buyers = await pool.query<{ email: string }>("SELECT data->>'email' AS email FROM buyers WHERE organization_id = $1", [
      organizationId,
    ]);
    expect(buyers.rowCount).toBe(6);
    expect(buyers.rows.every((row) => row.email.endsWith('@example.com'))).toBe(true);
    const team = await pool.query<{ email: string; role: string }>(
      'SELECT email, role FROM users WHERE organization_id = $1 ORDER BY email',
      [organizationId],
    );
    expect(team.rows.filter((row) => row.role === 'admin')).toHaveLength(3);
    expect(team.rows.filter((row) => row.role === 'member')).toHaveLength(20);
    expect(team.rows.map((row) => row.email).sort()).toEqual(DEMO_TEAM.map((person) => person.email).sort());

    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').send({ email: DEMO_EMAIL, password: DEMO_PASSWORD })).status).toBe(200);
    const overdue = await agent.get('/api/reminders/overdue');
    expect(overdue.body.invoices.length).toBeGreaterThan(0);
    expect(overdue.body.invoices.some((invoice: { recentlyReminded: boolean }) => invoice.recentlyReminded)).toBe(true);
    expect(overdue.body.invoices.some((invoice: { paidUsd: number }) => invoice.paidUsd > 0)).toBe(true);
  });

  it('registers, reads the session, and logs out', async () => {
    const agent = request.agent(app);
    const registered = await agent
      .post('/api/auth/register')
      .send({ email: 'owner@example.com', password: 'password123' });

    expect(registered.status).toBe(201);
    expect(registered.body.user.email).toBe('owner@example.com');
    expect(registered.body.user.password_hash).toBeUndefined();

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('owner@example.com');

    const loggedOut = await agent.post('/api/auth/logout');
    expect(loggedOut.status).toBe(200);
    const afterLogout = await agent.get('/api/auth/me');
    expect(afterLogout.status).toBe(401);
  });

  it('rejects a wrong password', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'owner@example.com', password: 'password123' });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'not-the-password' });

    expect(login.status).toBe(401);
    expect(login.body.error).toBe('Invalid email or password.');
  });

  it('blocks repeated failed sign-ins and repeated sign-ups', async () => {
    await signUp('owner@example.com');
    const attempt = (password: string) =>
      request(app).post('/api/auth/login').send({ email: 'owner@example.com', password });

    expect((await attempt('password123')).status).toBe(200);
    for (let i = 0; i < 10; i += 1) {
      expect((await attempt('wrong-password')).status).toBe(401);
    }
    const blocked = await attempt('password123');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain('Too many failed sign-in attempts');
    expect(blocked.headers['ratelimit-policy']).toBeDefined();

    const otherAccount = await request(app).post('/api/auth/login').send({ email: 'else@example.com', password: 'x' });
    expect(otherAccount.status).toBe(401);

    for (let i = 0; i < 4; i += 1) {
      await request(app).post('/api/auth/register').send({ email: `user${i}@example.com`, password: 'password123' });
    }
    const tooMany = await request(app).post('/api/auth/register').send({ email: 'late@example.com', password: 'password123' });
    expect(tooMany.status).toBe(429);
  });

  it('sends invoice email with verified TLS and records who sent it', async () => {
    const owner = await signUp('owner@example.com', 'xyz LLC');

    const sent = await owner.post('/api/send-email').send(emailBody());
    expect(sent.status).toBe(200);
    expect(sent.body.mode).toBe('live_smtp');
    expect(smtpCalls[0].settings.allowInvalidCertificates).toBe(false);
    expect(smtpCalls[0].message).toMatchObject({ to: ['buyer@example.com'], subject: 'Invoice EXP-1' });

    const log = await pool.query('SELECT mode, recipients, subject, attachment_count, user_id FROM email_dispatches');
    expect(log.rows).toEqual([
      expect.objectContaining({ mode: 'live_smtp', recipients: ['buyer@example.com'], subject: 'Invoice EXP-1', attachment_count: 1 }),
    ]);

    await owner.post('/api/send-email').send(emailBody({ smtpConfig: { ...smtpConfig, allowInvalidCertificates: true } }));
    expect(smtpCalls[1].settings.allowInvalidCertificates).toBe(true);

    const simulated = await owner.post('/api/send-email').send(emailBody({ smtpConfig: {} }));
    expect(simulated.body.mode).toBe('preview_simulated');
    expect((await pool.query('SELECT 1 FROM email_dispatches')).rowCount).toBe(3);
  });

  it('rejects unsafe email requests', async () => {
    const owner = await signUp('owner@example.com');
    const send = (body: Record<string, unknown>) => owner.post('/api/send-email').send(body);
    const tooMany = Array.from({ length: 11 }, (_, i) => `r${i}@example.com`);

    expect((await request(app).post('/api/send-email').send(emailBody())).status).toBe(401);
    expect((await send(emailBody({ emailData: { ...emailBody().emailData, recipients: tooMany } }))).status).toBe(400);
    expect((await send(emailBody({ emailData: { ...emailBody().emailData, recipients: ['not-an-email'] } }))).status).toBe(400);
    expect((await send(emailBody({ emailData: { ...emailBody().emailData, subject: 'a\r\nBcc: x@y.z' } }))).status).toBe(400);
    expect((await send(emailBody({ smtpConfig: { ...smtpConfig, port: 6379 } }))).status).toBe(400);
    expect((await send(emailBody({ smtpConfig: { ...smtpConfig, host: '127.0.0.1:6379' } }))).status).toBe(400);
    expect(
      (await send(emailBody({ attachments: [{ filename: 'x.html', content: 'PGI+', contentType: 'text/html' }] }))).status,
    ).toBe(400);
    expect(smtpCalls).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM email_dispatches')).rowCount).toBe(0);
  });

  it('verifies SMTP certificates unless the sender opts out', () => {
    const settings = { ...smtpConfig, allowInvalidCertificates: false };
    const verified = createSmtpTransport(settings) as unknown as { options: { tls: { rejectUnauthorized: boolean } } };
    const optedOut = createSmtpTransport({ ...settings, allowInvalidCertificates: true }) as unknown as typeof verified;
    expect(verified.options.tls.rejectUnauthorized).toBe(true);
    expect(optedOut.options.tls.rejectUnauthorized).toBe(false);
  });

  it('requires a session for manifest parsing', async () => {
    const response = await request(app).post('/api/parse-manifest').send({ manifestText: '1.20 ct' });
    expect(response.status).toBe(401);
  });

  it('creates, lists, updates, and deletes only the signed-in user invoices', async () => {
    const owner = request.agent(app);
    const other = request.agent(app);

    await owner.post('/api/auth/register').send({ email: 'owner@example.com', password: 'password123' });
    await other.post('/api/auth/register').send({ email: 'other@example.com', password: 'password123' });

    const unauthenticated = await request(app).post('/api/invoices').send({ invoice: sampleInvoice });
    expect(unauthenticated.status).toBe(401);

    const created = await owner.post('/api/invoices').send({ invoice: sampleInvoice });
    expect(created.status).toBe(201);
    expect(created.body.invoiceNumber).toBe('EXP-100');

    const listed = await owner.get('/api/invoices');
    expect(listed.status).toBe(200);
    expect(listed.body.invoices).toEqual([
      expect.objectContaining({ id: created.body.id, invoiceNumber: 'EXP-100' }),
    ]);

    const hidden = await other.get(`/api/invoices/${created.body.id}`);
    expect(hidden.status).toBe(404);

    const updated = await owner.put(`/api/invoices/${created.body.id}`).send({
      invoice: invoiceWith(sampleInvoice, { shipment: { invoiceNumber: 'EXP-200' } }),
    });
    expect(updated.status).toBe(200);
    expect(updated.body.invoiceNumber).toBe('EXP-200');
    expect(updated.body.invoice.shipment.invoiceNumber).toBe('EXP-200');

    const removed = await owner.delete(`/api/invoices/${created.body.id}`);
    expect(removed.status).toBe(204);

    const missing = await owner.get(`/api/invoices/${created.body.id}`);
    expect(missing.status).toBe(404);
  });

  it('numbers invoices automatically, stores totals, and rejects duplicate numbers', async () => {
    const owner = await signUp('owner@example.com', 'xyz LLC');

    const first = await owner.post('/api/invoices').send({ invoice: pricedInvoice });
    const second = await owner.post('/api/invoices').send({ invoice: pricedInvoice });
    expect(first.status).toBe(201);
    expect(first.body.invoiceNumber).toMatch(/^EXP\/\d{4}-\d{2}\/0001$/);
    expect(second.body.invoiceNumber).toMatch(/\/0002$/);
    expect(first.body.invoice.shipment.invoiceNumber).toBe(first.body.invoiceNumber);
    expect(first.body).toMatchObject({
      status: 'draft',
      buyerName: 'Antwerp Gems BVBA',
      destinationCountry: 'Belgium',
      invoiceDate: '2026-10-15',
      totalUsd: 1050,
      totalCarats: 2.25,
      dueUsd: 1050,
    });

    const duplicate = await owner.post('/api/invoices').send({
      invoice: invoiceWith(pricedInvoice, { shipment: { invoiceNumber: first.body.invoiceNumber.toLowerCase() } }),
    });
    expect(duplicate.status).toBe(409);
  });

  it('accepts every sample invoice and rejects malformed invoices', async () => {
    const owner = await signUp('owner@example.com');
    for (const preset of [SURAT_TO_ANTWERP_PRESET, MUMBAI_TO_NY_PRESET, SURAT_TO_DUBAI_PRESET]) {
      const saved = await owner.post('/api/invoices').send({ invoice: preset });
      expect(saved.status).toBe(201);
      expect(saved.body.invoice).toEqual(preset);
    }

    const reject = async (invoice: unknown, message: string) => {
      const response = await owner.post('/api/invoices').send({ invoice });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain(message);
    };

    await reject({ ...sampleInvoice, bank: undefined }, 'bank');
    await reject({ ...pricedInvoice, items: [{ ...line(1, 100), totalAmount: 999 }] }, 'items › line 1 › totalAmount');
    await reject({ ...pricedInvoice, items: [{ ...line(1, 100), carats: -1, totalAmount: -100 }] }, 'carats');
    await reject({ ...pricedInvoice, currency: 'EUR' }, 'currency');
    await reject(invoiceWith(pricedInvoice, { shipment: { incoterms: 'XYZ' as 'CIF' } }), 'incoterms');
    await reject({ ...pricedInvoice, freightUsd: 'lots' }, 'freightUsd');
    await reject(invoiceWith(pricedInvoice, { consignee: { companyName: 'x'.repeat(201) } }), 'companyName');

    const extra = await owner.post('/api/invoices').send({ invoice: { ...pricedInvoice, injected: '<script>' } });
    expect(extra.status).toBe(201);
    expect(extra.body.invoice.injected).toBeUndefined();
  });

  it('uses the company invoice prefix and locks issued invoices', async () => {
    const owner = await signUp('owner@example.com', 'xyz LLC');
    const saved = await owner.put('/api/company').send({
      name: 'xyz LLC',
      profile: { invoicePrefix: 'XYZ', exporter: { companyName: 'xyz LLC', city: 'Surat' }, bank: { bankName: 'HDFC' } },
    });
    expect(saved.status).toBe(200);
    expect((await owner.get('/api/company')).body.profile.exporter.city).toBe('Surat');

    const created = await owner.post('/api/invoices').send({ invoice: pricedInvoice });
    expect(created.body.invoiceNumber).toMatch(/^XYZ\//);

    const issued = await owner.patch(`/api/invoices/${created.body.id}/status`).send({ status: 'issued' });
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('issued');

    const edit = await owner.put(`/api/invoices/${created.body.id}`).send({ invoice: pricedInvoice });
    expect(edit.status).toBe(409);

    const backToDraft = await owner.patch(`/api/invoices/${created.body.id}/status`).send({ status: 'draft' });
    expect(backToDraft.status).toBe(400);

    const cancelled = await owner.patch(`/api/invoices/${created.body.id}/status`).send({ status: 'cancelled' });
    expect(cancelled.body.status).toBe('cancelled');
  });

  it('tracks payments and moves invoices between issued and paid', async () => {
    const owner = await signUp('owner@example.com');
    const created = await owner.post('/api/invoices').send({ invoice: pricedInvoice });
    const id = created.body.id;

    const tooEarly = await owner.post(`/api/invoices/${id}/payments`).send({ amountUsd: 100, paidOn: '2026-10-20' });
    expect(tooEarly.status).toBe(409);

    await owner.patch(`/api/invoices/${id}/status`).send({ status: 'issued' });

    const invalid = await owner.post(`/api/invoices/${id}/payments`).send({ amountUsd: -5, paidOn: '2026-10-20' });
    expect(invalid.status).toBe(400);

    const partial = await owner
      .post(`/api/invoices/${id}/payments`)
      .send({ amountUsd: 400, paidOn: '2026-10-20', reference: 'SWIFT 1' });
    expect(partial.status).toBe(201);
    expect(partial.body).toMatchObject({ status: 'issued', paidUsd: 400, dueUsd: 650 });

    const rest = await owner.post(`/api/invoices/${id}/payments`).send({ amountUsd: 650, paidOn: '2026-10-25' });
    expect(rest.body).toMatchObject({ status: 'paid', paidUsd: 1050, dueUsd: 0 });

    const removed = await owner.delete(`/api/invoices/${id}/payments/${rest.body.payments[1].id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ status: 'issued', paidUsd: 400 });

    const dashboard = await owner.get('/api/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.unpaid).toMatchObject({ count: 1, dueUsd: 650 });
    expect(dashboard.body.byCountry).toEqual([{ country: 'Belgium', count: 1, totalUsd: 1050 }]);
    expect(dashboard.body.statusCounts).toMatchObject({ issued: 1, draft: 0 });
  });

  it('searches, filters, and exports invoices as CSV', async () => {
    const owner = await signUp('owner@example.com');
    await owner.post('/api/invoices').send({ invoice: pricedInvoice });
    const dubai = await owner.post('/api/invoices').send({
      invoice: invoiceWith(pricedInvoice, {
        consignee: { companyName: '=Dubai Diamonds LLC', country: '' },
        shipment: { invoiceNumber: 'DXB-1', invoiceDate: '2026-09-01', countryOfDestination: '' },
      }),
    });
    await owner.patch(`/api/invoices/${dubai.body.id}/status`).send({ status: 'issued' });

    const byText = await owner.get('/api/invoices').query({ q: 'dubai' });
    expect(byText.body.invoices.map((row: any) => row.invoiceNumber)).toEqual(['DXB-1']);

    const byStatus = await owner.get('/api/invoices').query({ status: 'draft' });
    expect(byStatus.body.invoices).toHaveLength(1);

    const byDate = await owner.get('/api/invoices').query({ from: '2026-10-01', to: '2026-10-31' });
    expect(byDate.body.invoices).toHaveLength(1);
    expect(byDate.body.invoices[0].buyerName).toBe('Antwerp Gems BVBA');

    const csv = await owner.get('/api/invoices/export').query({ status: 'issued' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    const lines = csv.text.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("DXB-1,2026-09-01,issued,'=Dubai Diamonds LLC,,2.250,1050.00,0.00,1050.00");
  });

  it('keeps a buyer address book per company', async () => {
    const owner = await signUp('owner@example.com');
    const other = await signUp('other@example.com');

    const created = await owner
      .post('/api/buyers')
      .send({ consignee: { companyName: 'Antwerp Gems BVBA', country: 'Belgium', taxIdVat: 'BE0123' } });
    expect(created.status).toBe(201);
    expect(created.body.consignee.taxIdVat).toBe('BE0123');

    expect((await owner.post('/api/buyers').send({ consignee: { companyName: ' ' } })).status).toBe(400);

    const updated = await owner
      .put(`/api/buyers/${created.body.id}`)
      .send({ consignee: { ...created.body.consignee, city: 'Antwerp' } });
    expect(updated.body.consignee.city).toBe('Antwerp');

    expect((await other.get('/api/buyers')).body.buyers).toEqual([]);
    expect((await other.delete(`/api/buyers/${created.body.id}`)).status).toBe(404);

    expect((await owner.delete(`/api/buyers/${created.body.id}`)).status).toBe(204);
    expect((await owner.get('/api/buyers')).body.buyers).toEqual([]);
  });

  it('lets admins manage team members with roles', async () => {
    const admin = await signUp('owner@example.com', 'xyz LLC');
    const invoice = await admin.post('/api/invoices').send({ invoice: pricedInvoice });

    const added = await admin
      .post('/api/team/members')
      .send({ email: 'clerk@example.com', password: 'temporary1', role: 'member' });
    expect(added.status).toBe(201);
    expect(added.body.role).toBe('member');

    const clerk = request.agent(app);
    const login = await clerk.post('/api/auth/login').send({ email: 'clerk@example.com', password: 'temporary1' });
    expect(login.body.user).toMatchObject({ role: 'member', organizationName: 'xyz LLC' });

    expect((await clerk.get(`/api/invoices/${invoice.body.id}`)).status).toBe(200);
    expect((await clerk.get('/api/team/members')).status).toBe(403);
    expect((await clerk.put('/api/company').send({ name: 'Hacked', profile: {} })).status).toBe(403);
    expect((await clerk.delete(`/api/invoices/${invoice.body.id}`)).status).toBe(403);

    const me = (await admin.get('/api/auth/me')).body.user;
    expect((await admin.patch(`/api/team/members/${me.id}`).send({ role: 'member' })).status).toBe(409);
    expect((await admin.delete(`/api/team/members/${me.id}`)).status).toBe(409);

    expect((await admin.delete(`/api/team/members/${added.body.id}`)).status).toBe(204);
    expect((await clerk.get('/api/auth/me')).status).toBe(401);
    expect((await admin.get(`/api/invoices/${invoice.body.id}`)).status).toBe(200);
  });

  it('changes a password', async () => {
    const owner = await signUp('owner@example.com');

    const wrong = await owner
      .post('/api/auth/change-password')
      .send({ currentPassword: 'nope-nope', newPassword: 'new-password-1' });
    expect(wrong.status).toBe(400);

    const changed = await owner
      .post('/api/auth/change-password')
      .send({ currentPassword: 'password123', newPassword: 'new-password-1' });
    expect(changed.status).toBe(200);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'new-password-1' });
    expect(login.status).toBe(200);
  });

  it('resets a forgotten password with a one-time emailed link', async () => {
    const owner = await signUp('owner@example.com');

    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(unknown.status).toBe(200);
    expect(sentResetEmails).toHaveLength(0);

    const forgot = await request(app).post('/api/auth/forgot-password').send({ email: 'Owner@Example.com' });
    expect(forgot.status).toBe(200);
    expect(sentResetEmails).toHaveLength(1);
    expect(sentResetEmails[0].to).toBe('owner@example.com');
    const token = new URL(sentResetEmails[0].link).searchParams.get('reset');
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const reset = await request(app).post('/api/auth/reset-password').send({ token, password: 'brand-new-pass' });
    expect(reset.status).toBe(200);
    expect((await owner.get('/api/auth/me')).status).toBe(401);

    const reused = await request(app).post('/api/auth/reset-password').send({ token, password: 'another-pass-1' });
    expect(reused.status).toBe(400);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'brand-new-pass' });
    expect(login.status).toBe(200);
  });

  it('defaults credit days to 30 for invoices saved before the field existed', async () => {
    const owner = await signUp('owner@example.com');
    const { creditDays: _omitted, ...oldShipment } = pricedInvoice.shipment;
    const saved = await owner.post('/api/invoices').send({ invoice: { ...pricedInvoice, shipment: oldShipment } });
    expect(saved.status).toBe(201);
    expect(saved.body.invoice.shipment.creditDays).toBe(30);
    const row = await pool.query('SELECT credit_days FROM invoices WHERE id = $1', [saved.body.id]);
    expect(row.rows[0].credit_days).toBe(30);

    const rejected = await owner.post('/api/invoices').send({
      invoice: invoiceWith(pricedInvoice, { shipment: { creditDays: 400 } }),
    });
    expect(rejected.status).toBe(400);
  });

  it('lists only issued invoices past their credit days with a balance due, per company', async () => {
    const owner = await signUp('owner@example.com');
    const other = await signUp('other@example.com');
    const longAgo = await daysAgo(45);

    const overdue = await issuedInvoice(owner, longAgo, 30);
    await issuedInvoice(owner, await daysAgo(10), 30);
    await issuedInvoice(owner, longAgo, 45);

    await owner.post('/api/invoices').send({ invoice: invoiceWith(pricedInvoice, { shipment: { invoiceDate: longAgo, creditDays: 0 } }) });

    const paid = await issuedInvoice(owner, longAgo, 0);
    await owner.post(`/api/invoices/${paid.id}/payments`).send({ amountUsd: 1050, paidOn: await daysAgo(1) });

    const cancelled = await issuedInvoice(owner, longAgo, 0);
    await owner.patch(`/api/invoices/${cancelled.id}/status`).send({ status: 'cancelled' });

    const otherCompany = await issuedInvoice(other, longAgo, 0);

    const listed = await owner.get('/api/reminders/overdue');
    expect(listed.status).toBe(200);
    expect(listed.body.invoices).toEqual([
      expect.objectContaining({
        id: overdue.id,
        invoiceNumber: overdue.invoiceNumber,
        buyerEmail: 'procurement@rosenfeld-diamonds.be',
        invoiceDate: longAgo,
        dueDate: await daysAgo(15),
        daysOverdue: 15,
        dueUsd: 1050,
        remindersSent: 0,
        recentlyReminded: false,
      }),
    ]);
    expect((await other.get('/api/reminders/overdue')).body.invoices.map((row: any) => row.id)).toEqual([otherCompany.id]);
    expect((await other.post('/api/reminders/draft').send({ invoiceId: overdue.id })).status).toBe(404);

    const dashboard = await owner.get('/api/dashboard');
    const flags = Object.fromEntries(dashboard.body.unpaid.invoices.map((row: any) => [row.id, row.overdue]));
    expect(flags[overdue.id]).toBe(true);
    expect(Object.values(flags).filter(Boolean)).toHaveLength(1);
  });

  it('drafts reminder wording with the model but takes every figure from the database', async () => {
    const owner = await signUp('owner@example.com');
    const invoice = await issuedInvoice(owner, await daysAgo(40), 30);
    await owner.post(`/api/invoices/${invoice.id}/payments`).send({ amountUsd: 50, paidOn: await daysAgo(5) });

    reminderDrafter = async () => ({
      subject: 'Friendly payment reminder',
      greeting: 'Dear Mr. Rosenfeld,',
      paragraphs: ['Please settle the outstanding balance <b>soon</b>.'],
    });
    const drafted = await owner.post('/api/reminders/draft').send({ invoiceId: invoice.id });
    expect(drafted.status).toBe(201);
    expect(drafted.body).toMatchObject({
      source: 'model',
      tone: 'gentle',
      fullSubject: `Friendly payment reminder - Invoice ${invoice.invoiceNumber}`,
      recipients: ['procurement@rosenfeld-diamonds.be'],
      figures: { dueUsd: 1000, paidUsd: 50, totalUsd: 1050, daysOverdue: 10 },
    });
    expect(drafted.body.html).toContain('$1,000.00');
    expect(drafted.body.html).toContain('STATE BANK OF INDIA');
    expect(drafted.body.html).toContain('&lt;b&gt;soon&lt;/b&gt;');
    expect(reminderPrompts).toEqual([
      { buyerName: 'Antwerp Gems BVBA', contactPerson: 'Marc Rosenfeld', exporterName: 'Meridian Diamond Exports', tone: 'gentle' },
    ]);

    reminderDrafter = async () => ({
      subject: 'Payment reminder',
      greeting: 'Dear Mr. Rosenfeld,',
      paragraphs: ['Please pay USD 9,999 today.'],
    });
    const invented = await owner.post('/api/reminders/draft').send({ invoiceId: invoice.id });
    expect(invented.body.source).toBe('template');
    expect(invented.body.html).not.toContain('9,999');
    expect(invented.body.html).toContain('$1,000.00');

    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      reminderDrafter = async () => {
        throw new Error('Gemini is down');
      };
      const fallback = await owner.post('/api/reminders/draft').send({ invoiceId: invoice.id });
      expect(fallback.status).toBe(201);
      expect(fallback.body.source).toBe('template');
      expect(fallback.body.greeting).toBe('Dear Marc Rosenfeld,');
    } finally {
      console.warn = originalWarn;
    }

    const rows = await pool.query('SELECT model, prompt_version, status FROM payment_reminders ORDER BY created_at');
    expect(rows.rows.map((row) => row.model)).toEqual(['gemini-3.8-flash', 'template', 'template']);
    expect(rows.rows.every((row) => row.status === 'draft' && row.prompt_version === 'reminder-v1')).toBe(true);
  });

  it('sends an approved reminder once, logs it, and refuses once the invoice is paid', async () => {
    const owner = await signUp('owner@example.com');
    const invoice = await issuedInvoice(owner, await daysAgo(40), 30);
    reminderDrafter = async () => ({
      subject: 'Payment reminder',
      greeting: 'Dear Mr. Rosenfeld,',
      paragraphs: ['The balance below is now past due.'],
    });

    const draft = await owner.post('/api/reminders/draft').send({ invoiceId: invoice.id });
    const sendBody = {
      subject: 'Edited reminder',
      greeting: 'Dear Marc,',
      paragraphs: ['Could you confirm the payment date?', ''],
      recipients: ['buyer@example.com'],
      smtpConfig,
    };

    expect((await owner.post(`/api/reminders/${draft.body.id}/send`).send({ ...sendBody, recipients: [] })).status).toBe(400);
    expect(smtpCalls).toHaveLength(0);

    const sent = await owner.post(`/api/reminders/${draft.body.id}/send`).send(sendBody);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'sent', mode: 'live_smtp' });
    expect(smtpCalls).toHaveLength(1);
    expect(smtpCalls[0].message).toMatchObject({
      to: ['buyer@example.com'],
      subject: `Edited reminder - Invoice ${invoice.invoiceNumber}`,
    });
    expect(smtpCalls[0].message?.html).toContain('Could you confirm the payment date?');
    expect(smtpCalls[0].message?.html).toContain('$1,050.00');

    const logged = await pool.query('SELECT invoice_number, mode FROM email_dispatches');
    expect(logged.rows).toEqual([{ invoice_number: invoice.invoiceNumber, mode: 'live_smtp' }]);
    const stored = await pool.query('SELECT status, message_id, sent_at FROM payment_reminders WHERE id = $1', [draft.body.id]);
    expect(stored.rows[0]).toMatchObject({ status: 'sent', message_id: '<test@mail>' });
    expect(stored.rows[0].sent_at).not.toBeNull();

    expect((await owner.post(`/api/reminders/${draft.body.id}/send`).send(sendBody)).status).toBe(409);
    expect((await owner.post(`/api/reminders/${draft.body.id}/discard`)).status).toBe(409);

    const listed = await owner.get('/api/reminders/overdue');
    expect(listed.body.invoices[0]).toMatchObject({ remindersSent: 1, recentlyReminded: true });

    const repeat = await owner.post('/api/reminders/draft').send({ invoiceId: invoice.id });
    expect(repeat.status).toBe(409);
    expect(repeat.body.recentlyReminded).toBe(true);

    const second = await owner.post('/api/reminders/draft').send({ invoiceId: invoice.id, confirmRepeat: true });
    expect(second.status).toBe(201);
    expect(second.body.tone).toBe('firm');

    await owner.post(`/api/invoices/${invoice.id}/payments`).send({ amountUsd: 1050, paidOn: await daysAgo(0) });
    const afterPayment = await owner.post(`/api/reminders/${second.body.id}/send`).send(sendBody);
    expect(afterPayment.status).toBe(409);
    expect(smtpCalls).toHaveLength(1);
    expect((await owner.get('/api/reminders/overdue')).body.invoices).toEqual([]);

    expect((await owner.post(`/api/reminders/${second.body.id}/discard`)).status).toBe(200);
  });
});
