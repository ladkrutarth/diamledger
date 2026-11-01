import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { applySchema, type DbPool } from './db.js';

const port = 54329;
const databaseDir = path.join(os.tmpdir(), `diamondx-pg-${process.pid}`);
const testUrl = `postgresql://diamondx:diamondx@127.0.0.1:${port}/diamondx_test`;

const sampleInvoice = {
  exporter: { companyName: 'xyz LLC' },
  consignee: { companyName: 'Buyer BVBA' },
  shipment: { invoiceNumber: 'EXP-100' },
  items: [],
};

const pricedInvoice = {
  exporter: { companyName: 'xyz LLC' },
  consignee: { companyName: 'Antwerp Gems BVBA', country: 'Belgium' },
  shipment: { invoiceNumber: '', invoiceDate: '2026-10-15', countryOfDestination: 'Belgium' },
  items: [
    { carats: 1.5, totalAmount: 600 },
    { carats: 0.75, totalAmount: 400 },
  ],
  freightUsd: 30,
  insuranceUsd: 20,
  otherChargesUsd: 0,
};

const sentResetEmails: Array<{ to: string; link: string }> = [];

describe('auth and invoices', () => {
  let pool: DbPool;
  let app: ReturnType<typeof createApp>;
  let postgres: EmbeddedPostgres;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret';
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
    pool = new pg.Pool({ connectionString: testUrl });
    await applySchema(pool);
    app = createApp(pool, {
      sendPasswordResetEmail: async (to, link) => {
        sentResetEmails.push({ to, link });
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
      `TRUNCATE TABLE payments, invoices, buyers, invoice_counters, password_reset_tokens, session, users, organizations
       RESTART IDENTITY CASCADE`,
    );
    sentResetEmails.length = 0;
  });

  async function signUp(email: string, companyName?: string) {
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/register').send({ email, password: 'password123', companyName });
    expect(response.status).toBe(201);
    return agent;
  }

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
      invoice: {
        ...sampleInvoice,
        shipment: { invoiceNumber: 'EXP-200' },
      },
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
      invoice: { ...pricedInvoice, shipment: { invoiceNumber: first.body.invoiceNumber.toLowerCase() } },
    });
    expect(duplicate.status).toBe(409);
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
      invoice: {
        ...pricedInvoice,
        consignee: { companyName: '=Dubai Diamonds LLC' },
        shipment: { invoiceNumber: 'DXB-1', invoiceDate: '2026-09-01' },
      },
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
});
