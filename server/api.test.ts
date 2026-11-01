import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { applySchema, type DbPool } from './db';

const port = 54329;
const databaseDir = path.join(os.tmpdir(), `diamondx-pg-${process.pid}`);
const testUrl = `postgresql://diamondx:diamondx@127.0.0.1:${port}/diamondx_test`;

const sampleInvoice = {
  exporter: { companyName: 'xyz LLC' },
  consignee: { companyName: 'Buyer BVBA' },
  shipment: { invoiceNumber: 'EXP-100' },
  items: [],
};

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
    app = createApp(pool);
  }, 60000);

  afterAll(async () => {
    const store = app?.get('sessionStore') as { close?: () => void } | undefined;
    store?.close?.();
    if (pool) await pool.end();
    if (postgres) await postgres.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE invoices, session, users RESTART IDENTITY CASCADE');
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
});
