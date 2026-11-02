import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { suggestMatches } from '../modules/banking/bank.js';
import { runMigrations, type DbPool } from '../core/db.js';
import { parseCsv, parseLooseDate } from '../modules/tax/taxShared.js';
import { SURAT_TO_ANTWERP_PRESET } from '../../src/data/sampleInvoices.js';
import type { InvoiceState } from '../../src/types/invoice.js';

const port = 54332;
const databaseDir = path.join(os.tmpdir(), `diamondx-advanced-${process.pid}`);
const testUrl = `postgresql://diamondx:diamondx@127.0.0.1:${port}/diamondx_test`;

function invoice(buyer: string, amount: number): InvoiceState {
  const item = { ...SURAT_TO_ANTWERP_PRESET.items[0], carats: 1, ratePerCarat: amount, totalAmount: amount };
  return {
    ...SURAT_TO_ANTWERP_PRESET,
    exchangeRateInr: 84,
    items: [item],
    freightUsd: 0,
    insuranceUsd: 0,
    otherChargesUsd: 0,
    shipment: { ...SURAT_TO_ANTWERP_PRESET.shipment, invoiceNumber: '', invoiceDate: '2026-10-15', countryOfDestination: 'Belgium' },
    consignee: { ...SURAT_TO_ANTWERP_PRESET.consignee, companyName: buyer },
  };
}

describe('helpers', () => {
  it('parses quoted CSV and Indian date formats', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    expect(parseLooseDate('20/10/2026')).toBe('2026-10-20');
    expect(parseLooseDate('2026-02-30')).toBeNull();
  });

  it('ranks the invoice named in the narration first and spots bank charges', () => {
    const suggestions = suggestMatches(
      { amountUsd: 1985, reference: 'FT123', narration: 'BLUE STAR GEMS INV XYZ/2026-27/0002' },
      [
        { id: 'a', invoiceNumber: 'XYZ/2026-27/0001', buyerName: 'Rosenfeld', dueUsd: 1985 },
        { id: 'b', invoiceNumber: 'XYZ/2026-27/0002', buyerName: 'Blue Star Gems DMCC', dueUsd: 2000 },
      ],
    );
    expect(suggestions[0].invoiceId).toBe('b');
    expect(suggestions[0].reasons.join(' ')).toContain('Short by $15.00');
  });
});

describe('filing check, bank matching, realization, forex, and the accountant workspace', () => {
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

  it('runs the six advanced features end to end', async () => {
    const owner = request.agent(app);
    expect((await owner.post('/api/auth/register').send({
      email: 'owner@example.com', password: 'password123', companyName: 'Meridian Diamond Exports',
    })).status).toBe(201);

    const first = await owner.post('/api/invoices').send({ invoice: invoice('Rosenfeld & Sons BVBA', 1000) });
    const second = await owner.post('/api/invoices').send({ invoice: invoice('Blue Star Gems DMCC', 2000) });
    for (const created of [first, second]) {
      expect(created.status).toBe(201);
      expect((await owner.patch(`/api/invoices/${created.body.id}/status`).send({ status: 'issued' })).status).toBe(200);
    }
    const a = first.body as { id: string; invoiceNumber: string };
    const b = second.body as { id: string; invoiceNumber: string };

    // 1. Shipping bill against GSTR-1 check
    let check = await owner.get('/api/tax/filing-check?month=2026-10');
    expect(check.status).toBe(200);
    const codes = check.body.rows.find((row: { id: string }) => row.id === a.id).issues.map((issue: { code: string }) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['shipping_bill_missing', 'irn_missing']));

    expect((await owner.put(`/api/invoices/${a.id}/tax`).send({
      exportScheme: 'lut', shippingBillNo: 'SB-1001', shippingBillDate: '2026-10-16', portCode: 'inbom4',
      sbInvoiceNumber: a.invoiceNumber, sbValueUsd: 1000,
    })).status).toBe(200);
    expect((await owner.put(`/api/invoices/${b.id}/tax`).send({
      exportScheme: 'lut', shippingBillNo: 'SB-1002', shippingBillDate: '2026-10-16', portCode: 'INBOM4',
      sbInvoiceNumber: 'WRONG/1', sbValueUsd: 1500,
    })).status).toBe(200);
    expect((await owner.put(`/api/invoices/${a.id}/einvoice`).send({ irn: 'xyz' })).status).toBe(400);
    expect((await owner.put(`/api/invoices/${a.id}/einvoice`).send({ irn: 'a'.repeat(64), ackNo: '112610000000001', ackDate: '2026-10-15' })).status).toBe(200);

    check = await owner.get('/api/tax/filing-check?month=2026-10');
    expect(check.body.readyCount).toBe(1);
    const secondCodes = check.body.rows.find((row: { id: string }) => row.id === b.id).issues.map((issue: { code: string }) => issue.code);
    expect(secondCodes).toEqual(expect.arrayContaining(['sb_invoice_mismatch', 'sb_value_mismatch', 'irn_missing']));

    // 2. GSTR-1 table 6A and e-invoice JSON
    const gstr1 = await owner.get('/api/tax/gstr1-6a?month=2026-10');
    expect(gstr1.status).toBe(200);
    expect(gstr1.headers['x-left-out']).toBe('1');
    const gstr1Body = JSON.parse(gstr1.text);
    expect(gstr1Body.fp).toBe('102026');
    expect(gstr1Body.exp).toEqual([
      expect.objectContaining({
        exp_typ: 'WOPAY',
        inv: [expect.objectContaining({ inum: a.invoiceNumber, idt: '15-10-2026', val: 84000, sbpcode: 'INBOM4', sbnum: 'SB-1001', sbdt: '16-10-2026' })],
      }),
    ]);
    const einvoice = await owner.get(`/api/invoices/${b.id}/einvoice.json`);
    expect(einvoice.status).toBe(200);
    const payload = JSON.parse(einvoice.text);
    expect(payload.TranDtls.SupTyp).toBe('EXPWOP');
    expect(payload.DocDtls).toEqual({ Typ: 'INV', No: b.invoiceNumber, Dt: '15/10/2026' });
    expect(payload.BuyerDtls).toEqual(expect.objectContaining({ Gstin: 'URP', Pos: '96', Stcd: '96' }));
    expect(payload.ValDtls).toEqual(expect.objectContaining({ AssVal: 168000, TotInvValFc: 2000 }));
    expect(payload.ExpDtls).toEqual(expect.objectContaining({ ForCur: 'USD', CntCode: 'BE', Port: 'INBOM4' }));

    // 3. Bank statement matching
    const csv = [
      'Value Date,Credit,Reference,Narration,Rate',
      '20/10/2026,"1,000.00",SWIFT-A1,REMITTANCE ROSENFELD,85.50',
      `21/10/2026,1985.00,SWIFT-B1,BLUE STAR payment ${b.invoiceNumber},83.00`,
      '21/10/2026,,CHQ-9,Debit card,',
    ].join('\n');
    const imported = await owner.post('/api/bank/import').send({ csv });
    expect(imported.body).toEqual({ imported: 2, duplicates: 0, skipped: 1 });
    expect((await owner.post('/api/bank/import').send({ csv })).body).toEqual({ imported: 0, duplicates: 2, skipped: 1 });
    const lines = await owner.get('/api/bank/lines');
    const lineA = lines.body.lines.find((line: { reference: string }) => line.reference === 'SWIFT-A1');
    const lineB = lines.body.lines.find((line: { reference: string }) => line.reference === 'SWIFT-B1');
    expect(lineA.suggestions[0].invoiceId).toBe(a.id);
    expect(lineB.suggestions[0]).toEqual(expect.objectContaining({ invoiceId: b.id, shortByUsd: 15 }));
    expect((await owner.post(`/api/bank/lines/${lineA.id}/match`).send({ invoiceId: a.id })).body).toEqual({ matched: true, dueUsd: 0, status: 'paid' });
    expect((await owner.post(`/api/bank/lines/${lineB.id}/match`).send({ invoiceId: b.id })).body).toEqual(expect.objectContaining({ dueUsd: 15 }));
    expect((await owner.post(`/api/bank/lines/${lineB.id}/match`).send({ invoiceId: b.id })).status).toBe(409);

    // 5. Exchange gain and loss
    let forex = await owner.get('/api/tax/forex?month=2026-10');
    expect(forex.body.totals).toEqual({ gainInr: 1500, lossInr: -1985, netInr: -485 });
    const firstPayment = forex.body.rows.find((row: { invoiceId: string }) => row.invoiceId === a.id);
    expect((await owner.patch(`/api/invoices/${a.id}/payments/${firstPayment.paymentId}`).send({ bankRateInr: 86 })).status).toBe(200);
    forex = await owner.get('/api/tax/forex?month=2026-10');
    expect(forex.body.totals.gainInr).toBe(2000);
    const tally = await owner.get('/api/tax/forex/tally?month=2026-10').buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    const xml = (tally.body as Buffer).toString('utf8');
    expect(xml).toContain('VCHTYPE="Receipt"');
    expect(xml).toContain('<LEDGERNAME>Foreign Exchange Gain / Loss</LEDGERNAME>');
    expect(xml).toContain('<AMOUNT>-86000.00</AMOUNT>');
    expect(xml).toContain('<AMOUNT>84000.00</AMOUNT>');
    expect(xml).toContain('<AMOUNT>2000.00</AMOUNT>');

    // 4. FEMA realization deadlines and e-BRC
    let realization = await owner.get('/api/tax/realization');
    expect(realization.body.realizationMonths).toBe(9);
    const rowA = realization.body.rows.find((row: { id: string }) => row.id === a.id);
    expect(rowA).toEqual(expect.objectContaining({ deadline: '2027-07-16', flag: 'needs_brc' }));
    const brc = await owner.post('/api/tax/ebrc/import').send({
      csv: `e-BRC Number,Shipping Bill No,Realisation Date,Realised Value\nBRC0001,SB-1001,20-10-2026,1000\nBRC0002,SB-404,20-10-2026,5`,
    });
    expect(brc.body).toEqual({ matched: 1, unmatched: ['SB-404'] });
    expect((await owner.put('/api/tax/settings').send({ realizationMonths: 1, lutValidUntil: '2027-03-31' })).status).toBe(200);
    realization = await owner.get('/api/tax/realization');
    expect(realization.body.rows.find((row: { id: string }) => row.id === a.id)).toEqual(expect.objectContaining({ flag: 'done', brcNumber: 'BRC0001' }));
    expect(realization.body.rows.find((row: { id: string }) => row.id === b.id)).toEqual(expect.objectContaining({ deadline: '2026-11-16', dueUsd: 15 }));

    // 6. One chartered accountant, several companies
    const firm = request.agent(app);
    expect((await firm.post('/api/auth/register').send({ email: 'shah@example.com', password: 'password123', companyName: 'Shah & Co' })).status).toBe(201);
    expect((await owner.post('/api/team/accountants').send({ email: 'nobody@example.com' })).status).toBe(404);
    expect((await owner.post('/api/team/accountants').send({ email: 'shah@example.com', role: 'ca' })).status).toBe(201);
    const companies = await firm.get('/api/workspace/companies');
    expect(companies.body.companies.map((company: { name: string }) => company.name)).toEqual(['Shah & Co', 'Meridian Diamond Exports']);
    const meridian = companies.body.companies[1].id;
    const switched = await firm.post('/api/workspace/switch').send({ organizationId: meridian });
    expect(switched.body.user).toEqual(expect.objectContaining({ role: 'ca', organizationName: 'Meridian Diamond Exports' }));
    expect((await firm.get('/api/tax/register?month=2026-10')).body.rows).toHaveLength(2);
    expect((await firm.post('/api/invoices').send({ invoice: invoice('Blocked', 1) })).status).toBe(403);
    const calendar = await firm.get('/api/workspace/calendar');
    expect(calendar.status).toBe(200);
    const meridianItems = calendar.body.items.filter((item: { organizationName: string }) => item.organizationName === 'Meridian Diamond Exports');
    expect(meridianItems.map((item: { kind: string }) => item.kind)).toEqual(expect.arrayContaining(['gstr1', 'gstr3b', 'lut']));
    expect(calendar.body.items.some((item: { organizationName: string; kind: string; status: string }) =>
      item.organizationName === 'Shah & Co' && item.kind === 'lut' && item.status === 'action')).toBe(true);

    const accountants = await owner.get('/api/team/accountants');
    expect(accountants.body.accountants).toEqual([expect.objectContaining({ email: 'shah@example.com', firm: 'Shah & Co', role: 'ca' })]);
    const firmUserId = accountants.body.accountants[0].userId;
    expect((await owner.delete(`/api/team/accountants/${firmUserId}`)).status).toBe(204);
    const me = await firm.get('/api/auth/me');
    expect(me.body.user).toEqual(expect.objectContaining({ organizationName: 'Shah & Co', role: 'admin' }));
  });
});
