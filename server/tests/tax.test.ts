import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { runMigrations, type DbPool } from '../core/db.js';
import { SURAT_TO_ANTWERP_PRESET } from '../../src/data/sampleInvoices.js';
import type { InvoiceState } from '../../src/types/invoice.js';

const port = 54331;
const databaseDir = path.join(os.tmpdir(), `diamondx-tax-${process.pid}`);
const testUrl = `postgresql://diamondx:diamondx@127.0.0.1:${port}/diamondx_test`;

function invoice(): InvoiceState {
  const item = {
    ...SURAT_TO_ANTWERP_PRESET.items[0],
    carats: 1,
    ratePerCarat: 1000,
    totalAmount: 1000,
  };
  return {
    ...SURAT_TO_ANTWERP_PRESET,
    items: [item],
    freightUsd: 0,
    insuranceUsd: 0,
    otherChargesUsd: 0,
    shipment: {
      ...SURAT_TO_ANTWERP_PRESET.shipment,
      invoiceNumber: '',
      invoiceDate: '2026-10-15',
      countryOfDestination: 'Belgium',
    },
    consignee: { ...SURAT_TO_ANTWERP_PRESET.consignee, companyName: 'Rosenfeld & Sons BVBA' },
  };
}

describe('tax desk and chartered accountant', () => {
  let pool: DbPool;
  let app: ReturnType<typeof createApp>;
  let postgres: EmbeddedPostgres | undefined;

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
    await runMigrations(pool);
    app = createApp(pool);
  }, 60000);

  afterAll(async () => {
    const store = app?.get('sessionStore') as { close?: () => void } | undefined;
    store?.close?.();
    if (pool) await pool.end();
    if (postgres) await postgres.stop();
  });

  it('keeps the tax and chartered accountant roles, and closes a month against edits', async () => {
    const owner = request.agent(app);
    const registered = await owner.post('/api/auth/register').send({
      email: 'owner@example.com',
      password: 'password123',
      companyName: 'Meridian Diamond Exports',
    });
    expect(registered.status).toBe(201);

    expect((await owner.post('/api/team/members').send({ email: 'tax.desk@example.com', password: 'password123', role: 'tax' })).status).toBe(201);
    expect((await owner.post('/api/team/members').send({ email: 'ca.review@example.com', password: 'password123', role: 'ca' })).status).toBe(201);
    expect((await owner.post('/api/team/members').send({ email: 'desk@example.com', password: 'password123', role: 'member' })).status).toBe(201);

    const created = await owner.post('/api/invoices').send({ invoice: invoice() });
    expect(created.status).toBe(201);
    const issued = await owner.patch(`/api/invoices/${created.body.id}/status`).send({ status: 'issued' });
    expect(issued.status).toBe(200);

    const tax = request.agent(app);
    const taxLogin = await tax.post('/api/auth/login').send({ email: 'tax.desk@example.com', password: 'password123' });
    expect(taxLogin.body.user.role).toBe('tax');
    const saved = await tax.put(`/api/invoices/${created.body.id}/tax`).send({
      exportScheme: 'igst',
      shippingBillNo: 'SB-1001',
      shippingBillDate: '2026-10-16',
      igstUsd: 18,
    });
    expect(saved.status).toBe(200);
    const attached = await tax.post(`/api/invoices/${created.body.id}/documents`).send({
      kind: 'shipping_bill',
      fileName: 'sb-1001.pdf',
      contentType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 shipping bill').toString('base64'),
    });
    expect(attached.status).toBe(201);

    const register = await tax.get('/api/tax/register?month=2026-10');
    expect(register.status).toBe(200);
    expect(register.body.rows).toEqual([
      expect.objectContaining({
        invoiceNumber: created.body.invoiceNumber,
        exportScheme: 'igst',
        shippingBillNo: 'SB-1001',
        taxableUsd: 1000,
      }),
    ]);
    const realization = await tax.get('/api/tax/realization');
    expect(realization.body.rows[0]).toEqual(expect.objectContaining({ open: true, dueUsd: 1000, missingReference: false }));

    const member = request.agent(app);
    await member.post('/api/auth/login').send({ email: 'desk@example.com', password: 'password123' });
    expect((await member.get('/api/tax/register')).status).toBe(403);

    const ca = request.agent(app);
    const caLogin = await ca.post('/api/auth/login').send({ email: 'ca.review@example.com', password: 'password123' });
    expect(caLogin.body.user.role).toBe('ca');
    expect((await ca.post('/api/invoices').send({ invoice: invoice() })).status).toBe(403);
    expect((await ca.post('/api/buyers').send({ consignee: { companyName: 'Blocked' } })).status).toBe(403);
    const review = await ca.put(`/api/invoices/${created.body.id}/review`).send({ status: 'query', comment: 'Shipping bill date does not match the invoice.' });
    expect(review.status).toBe(200);

    expect((await ca.post('/api/tax/months/2026-10/close')).status).toBe(200);
    const blockedPayment = await owner.post(`/api/invoices/${created.body.id}/payments`).send({
      amountUsd: 1000,
      paidOn: '2026-10-20',
      reference: 'SWIFT-1',
    });
    expect(blockedPayment.status).toBe(409);
    expect((await tax.put(`/api/invoices/${created.body.id}/tax`).send({ exportScheme: 'lut', shippingBillNo: 'SB-2' })).status).toBe(409);

    const pack = await ca
      .get('/api/tax/gst-pack?month=2026-10')
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(pack.status).toBe(200);
    expect(pack.headers['content-type']).toContain('application/zip');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gst-pack-'));
    const zipPath = path.join(dir, 'pack.zip');
    fs.writeFileSync(zipPath, pack.body as Buffer);
    const listing = execFileSync(
      'python3',
      ['-c', `import zipfile; z=zipfile.ZipFile(${JSON.stringify(zipPath)}); print('\\n'.join(z.namelist())); print(z.read('export-register.csv').decode())`],
      { encoding: 'utf8' },
    );
    expect(listing).toContain('export-register.csv');
    expect(listing).toContain('payments.csv');
    expect(listing).toContain('SB-1001');

    const year = await ca
      .get('/api/tax/year-pack?year=2026-27')
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(year.status).toBe(200);
    const yearPath = path.join(dir, 'year.zip');
    fs.writeFileSync(yearPath, year.body as Buffer);
    const yearList = execFileSync('python3', ['-c', `import zipfile; print('\\n'.join(zipfile.ZipFile(${JSON.stringify(yearPath)}).namelist()))`], {
      encoding: 'utf8',
    });
    expect(yearList).toContain('sales-register.csv');
    expect(yearList).toContain('receipts.csv');
    expect(yearList).toContain('outstanding.csv');
    expect(yearList).toContain('cancelled.csv');

    expect((await ca.post('/api/tax/months/2026-10/open')).status).toBe(200);
    const paid = await owner.post(`/api/invoices/${created.body.id}/payments`).send({
      amountUsd: 1000,
      paidOn: '2026-10-20',
      reference: 'SWIFT-1',
    });
    expect(paid.status).toBe(201);
    const after = await tax.get('/api/tax/realization');
    expect(after.body.rows[0]).toEqual(expect.objectContaining({ open: false, bankReferences: 'SWIFT-1' }));
  });
});
