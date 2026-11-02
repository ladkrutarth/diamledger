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
import { invoiceSeries, numberingGaps } from '../modules/tax/auditChecks.js';
import { riskGrade } from '../modules/company/buyerRisk.js';
import { form15caPart } from '../modules/tax/foreignPayments.js';
import { documentKey } from '../core/formInput.js';
import type { DraftNoticeReply } from '../modules/tax/notices.js';
import { healthScore } from '../modules/accountant/practice.js';
import { parseGstr2bCsv } from '../modules/tax/purchases.js';
import { parseTallyAmount, parseTallyCsv, parseTallyXml } from '../modules/banking/tallySync.js';
import { SURAT_TO_ANTWERP_PRESET } from '../../src/data/sampleInvoices.js';
import type { InvoiceState } from '../../src/types/invoice.js';
import { generateTallyPrimeXML } from '../../src/utils/tallyGenerator.js';

const port = 54335;
const databaseDir = path.join(os.tmpdir(), `diamondx-features-${process.pid}`);
const testUrl = `postgresql://diamondx:diamondx@127.0.0.1:${port}/diamondx_test`;

function invoice(overrides: { parcelId?: string; carats?: number; rate?: number; date?: string } = {}): InvoiceState {
  const carats = overrides.carats ?? 1;
  const rate = overrides.rate ?? 1000;
  const item = {
    ...SURAT_TO_ANTWERP_PRESET.items[0],
    parcelId: overrides.parcelId ?? '',
    carats,
    ratePerCarat: rate,
    totalAmount: Math.round(carats * rate * 100) / 100,
  };
  return {
    ...SURAT_TO_ANTWERP_PRESET,
    items: [item],
    freightUsd: 0,
    insuranceUsd: 0,
    otherChargesUsd: 0,
    shipment: { ...SURAT_TO_ANTWERP_PRESET.shipment, invoiceNumber: '', invoiceDate: overrides.date ?? '2026-10-15', countryOfDestination: 'Belgium', creditDays: 30 },
    consignee: { ...SURAT_TO_ANTWERP_PRESET.consignee, companyName: 'Rosenfeld & Sons BVBA' },
  };
}

// Collects a download as bytes; supertest's types expect its own Response, which is a readable stream here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function binary(res: any, callback: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('helpers for the new desks', () => {
  it('normalizes document numbers so small formatting differences still match', () => {
    expect(documentKey('INV/007')).toBe(documentKey('inv-7'));
    expect(documentKey('INV-077')).toBe('INV77');
    expect(documentKey('1234567')).toBe('1234567');
    expect(documentKey('INV-10')).not.toBe(documentKey('INV-1'));
  });

  it('finds gaps in each invoice series', () => {
    expect(invoiceSeries('EXP/2026-27/0012')).toEqual({ prefix: 'EXP/2026-27/', series: 'EXP/2026-27/', number: 12, width: 4 });
    expect(numberingGaps(['EXP/2026-27/0001', 'EXP/2026-27/0004', 'EXP/2026-27/0002', 'OTHER-9'])).toEqual([
      { series: 'EXP/2026-27/', missing: ['EXP/2026-27/0003'] },
    ]);
  });

  it('reads Tally amounts in rupees and foreign currency', () => {
    expect(parseTallyAmount('-108125.00')).toEqual({ inr: 108125, usd: null });
    expect(parseTallyAmount('-$ 1,250.00 @ ₹ 86.50/$ = -₹ 1,08,125.00')).toEqual({ inr: 108125, usd: 1250 });
    expect(parseTallyAmount('$ 1000.00')).toEqual({ inr: 0, usd: 1000 });
    expect(parseTallyAmount('')).toBeNull();
  });

  it('reads a Tally day book saved as CSV', () => {
    const csv = 'Day Book\nDate,Particulars,Vch Type,Vch No.,Debit Amount,Credit Amount\n1-Oct-26,Rosenfeld,Sales,EXP/1,"86,650.00",\n2-Oct-26,HDFC Bank,Receipt,R-1,,"50,000.00"\n';
    const vouchers = parseTallyCsv(csv);
    expect(vouchers).toEqual([
      expect.objectContaining({ date: '2026-10-01', kind: 'sales', number: 'EXP/1', amountInr: 86650 }),
      expect.objectContaining({ date: '2026-10-02', kind: 'receipt', amountInr: 50000 }),
    ]);
    expect(parseTallyCsv('a,b\n1,2')).toEqual(expect.stringContaining('Date and Vch Type'));
  });

  it('reads the B2B and import tables of GSTR-2B', () => {
    const parsed = parseGstr2bCsv(
      'GSTIN of supplier,Trade/Legal name,Invoice number,Invoice date,Taxable Value (₹),Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹),ITC Availability\n'
        + '24ABCDE1234F1Z5,Gem Traders,INV-077,05-10-2026,"1,00,000.00",250.00,0,0,Yes\n'
        + ',,,,,,,,\n'
        + '27ABCDE1234F1Z5,Blocked Co,B-1,06-10-2026,1000,0,10,10,No\n',
    );
    expect(parsed).toEqual({
      skipped: 0,
      lines: [
        expect.objectContaining({ section: 'b2b', documentNo: 'INV-077', documentDate: '2026-10-05', taxableInr: 100000, igstInr: 250, itcAvailable: true }),
        expect.objectContaining({ section: 'b2b', supplierName: 'Blocked Co', cgstInr: 10, itcAvailable: false }),
      ],
    });
  });

  it('picks the Form 15CA part from taxability and the yearly total', () => {
    expect(form15caPart(false, 900000)).toBe('D');
    expect(form15caPart(true, 400000)).toBe('A');
    expect(form15caPart(true, 500001)).toBe('C');
  });

  it('grades buyers from their payment history', () => {
    const base = { invoices: 4, paidInvoices: 3, outstandingUsd: 1000, overdueUsd: 0, maxDaysOverdue: 0, avgDaysLate: 0, onTimePercent: 100 };
    expect(riskGrade(base)).toBe('A');
    expect(riskGrade({ ...base, avgDaysLate: 10 })).toBe('B');
    expect(riskGrade({ ...base, overdueUsd: 200, maxDaysOverdue: 45 })).toBe('C');
    expect(riskGrade({ ...base, overdueUsd: 800, maxDaysOverdue: 95 })).toBe('D');
    expect(riskGrade({ ...base, invoices: 0, paidInvoices: 0 })).toBe('new');
  });

  it('scores client health', () => {
    expect(healthScore({ overdue: 0, dueSoon: 0, actions: 0, noticesOverdue: 0, noticesDueSoon: 0, requestsOverdue: 0 })).toEqual({ score: 100, grade: 'good' });
    expect(healthScore({ overdue: 2, dueSoon: 1, actions: 0, noticesOverdue: 0, noticesDueSoon: 0, requestsOverdue: 0 }).grade).toBe('watch');
    expect(healthScore({ overdue: 1, dueSoon: 0, actions: 0, noticesOverdue: 2, noticesDueSoon: 0, requestsOverdue: 0 }).grade).toBe('at_risk');
  });
});

describe('purchases, stock, audit, notices, requests, Tally, practice, and buyer risk', () => {
  let pool: DbPool;
  let app: ReturnType<typeof createApp>;
  let postgres: EmbeddedPostgres | undefined;
  let draftReply: DraftNoticeReply = async () => ({ paragraphs: ['Placeholder.'] });

  let owner: ReturnType<typeof request.agent>;
  let tax: ReturnType<typeof request.agent>;
  let ca: ReturnType<typeof request.agent>;
  let member: ReturnType<typeof request.agent>;
  let firstInvoice: { id: string; invoiceNumber: string };

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
    app = createApp(pool, { draftNoticeReply: (facts, signal) => draftReply(facts, signal) });

    owner = request.agent(app);
    expect((await owner.post('/api/auth/register').send({ email: 'owner@example.com', password: 'password123', companyName: 'Meridian Diamond Exports' })).status).toBe(201);
    for (const [email, role] of [['tax@example.com', 'tax'], ['ca@example.com', 'ca'], ['member@example.com', 'member']]) {
      expect((await owner.post('/api/team/members').send({ email, password: 'password123', role })).status).toBe(201);
    }
    tax = request.agent(app);
    await tax.post('/api/auth/login').send({ email: 'tax@example.com', password: 'password123' });
    ca = request.agent(app);
    await ca.post('/api/auth/login').send({ email: 'ca@example.com', password: 'password123' });
    member = request.agent(app);
    await member.post('/api/auth/login').send({ email: 'member@example.com', password: 'password123' });
  }, 60000);

  afterAll(async () => {
    const store = app?.get('sessionStore') as { close?: () => void } | undefined;
    store?.close?.();
    if (pool) await pool.end();
    if (postgres) await postgres.stop();
  });

  it('matches purchases with GSTR-2B and shows credit at risk and credit not claimed', async () => {
    const local = await member.post('/api/purchases').send({
      kind: 'local', supplierName: 'Gem Traders', supplierGstin: '24ABCDE1234F1Z5', documentNo: 'INV-77', documentDate: '2026-10-05',
      taxableInr: 100000, igstInr: 250, carats: 120,
    });
    expect(local.status).toBe(201);
    expect((await member.post('/api/purchases').send({ kind: 'local', supplierName: 'Gem Traders', supplierGstin: '24ABCDE1234F1Z5', documentNo: 'INV-77', documentDate: '2026-10-05', taxableInr: 1 })).status).toBe(409);
    expect((await member.post('/api/purchases').send({ kind: 'import', supplierName: 'Antwerp Rough NV', supplierCountry: 'Belgium', documentNo: '1234567', documentDate: '2026-10-08', portCode: 'INBOM4', taxableInr: 500000, igstInr: 1250, carats: 300, relatedParty: true })).status).toBe(201);
    expect((await member.post('/api/purchases').send({ kind: 'local', supplierName: 'Late Filer', supplierGstin: '24LATEF1234F1Z5', documentNo: 'LF-80', documentDate: '2026-10-09', taxableInr: 40000, igstInr: 100 })).status).toBe(201);
    expect((await member.post('/api/purchases').send({ kind: 'local', supplierName: 'Bad GSTIN', supplierGstin: 'XYZ', documentNo: 'B-1', documentDate: '2026-10-09', taxableInr: 1 })).status).toBe(400);

    const csv = 'Section,GSTIN of supplier,Trade/Legal name,Invoice number,Bill of entry number,Invoice date,Taxable value,Integrated tax,Central tax,State/UT tax,ITC availability\n'
      + 'B2B,24ABCDE1234F1Z5,Gem Traders,INV-077,,05-10-2026,100000,250,0,0,Yes\n'
      + 'IMPG,,,,1234567,08-10-2026,500000,1000,0,0,Yes\n'
      + 'B2B,24NEWSU1234F1Z5,New Supplier,NS-99,,10-10-2026,120000,300,0,0,Yes\n';
    const imported = await tax.post('/api/purchases/gstr2b').send({ month: '2026-10', csv });
    expect(imported.status).toBe(201);
    expect(imported.body.imported).toBe(3);

    expect((await member.get('/api/purchases/itc-match?month=2026-10')).status).toBe(403);
    const match = await tax.get('/api/purchases/itc-match?month=2026-10');
    expect(match.status).toBe(200);
    const status = (documentNo: string) => match.body.rows.find((row: { documentNo: string }) => row.documentNo === documentNo)?.status;
    expect(status('INV-77')).toBe('matched');
    expect(status('1234567')).toBe('mismatch');
    expect(status('LF-80')).toBe('missing_in_2b');
    expect(status('NS-99')).toBe('not_in_books');
    expect(match.body.totals).toEqual(expect.objectContaining({ booksItcInr: 1600, matchedItcInr: 250, atRiskItcInr: 100, unclaimedItcInr: 300, mismatches: 1 }));

    // A closed month blocks purchase entries dated in it.
    expect((await ca.post('/api/tax/months/2026-09/close')).status).toBe(200);
    const blocked = await member.post('/api/purchases').send({ kind: 'local', supplierName: 'Gem Traders', documentNo: 'OLD-1', documentDate: '2026-09-10', taxableInr: 10 });
    expect(blocked.status).toBe(409);
    expect((await ca.post('/api/purchases').send({ kind: 'local', supplierName: 'X', documentNo: 'CA-1', documentDate: '2026-10-10', taxableInr: 10 })).status).toBe(403);
  });

  it('builds the stock register with rough used, yield, and closing value at cost', async () => {
    expect((await owner.post('/api/parcels').send({ parcelId: 'R-1', stockKind: 'rough', caratsIn: 100, costInr: 1000000, receivedOn: '2026-05-01' })).status).toBe(201);
    expect((await owner.post('/api/parcels').send({ parcelId: 'P-1', stockKind: 'polished', caratsIn: 24, madeFrom: 'R-9', roughCaratsUsed: 60, receivedOn: '2026-06-01' })).status).toBe(400);
    expect((await owner.post('/api/parcels').send({ parcelId: 'P-1', stockKind: 'polished', caratsIn: 24, madeFrom: 'R-1', roughCaratsUsed: 20, receivedOn: '2026-06-01' })).status).toBe(400);
    expect((await owner.post('/api/parcels').send({ parcelId: 'P-1', stockKind: 'polished', caratsIn: 24, madeFrom: 'R-1', roughCaratsUsed: 60, receivedOn: '2026-06-01' })).status).toBe(201);

    const created = await owner.post('/api/invoices').send({ invoice: invoice({ parcelId: 'P-1', carats: 10, rate: 100 }) });
    expect(created.status).toBe(201);
    expect((await owner.patch(`/api/invoices/${created.body.id}/status`).send({ status: 'issued' })).status).toBe(200);
    firstInvoice = { id: created.body.id, invoiceNumber: created.body.invoiceNumber };

    const parcels = await owner.get('/api/parcels');
    expect(parcels.body.parcels.find((parcel: { parcelId: string }) => parcel.parcelId === 'R-1')).toEqual(
      expect.objectContaining({ stockKind: 'rough', consumedCarats: 60, balanceCarats: 40, status: 'partial' }),
    );

    const stock = await owner.get('/api/stock/register?year=2026-27');
    expect(stock.status).toBe(200);
    expect(stock.body.rough).toEqual(expect.objectContaining({ opening: 0, purchased: 100, consumed: 60, sold: 0, closing: 40, closingValueInr: 400000 }));
    expect(stock.body.polished).toEqual(expect.objectContaining({ produced: 24, sold: 10, closing: 14, closingValueInr: 350000 }));
    expect(stock.body.yieldPercent).toBe(40);
    expect(stock.body.processLossCarats).toBe(36);
    expect(stock.body.purchaseRegisterCarats).toBe(420);
    expect((await owner.get('/api/stock/register?year=2026')).status).toBe(400);
  });

  it('flags foreign payments that need TDS, Form 15CA, or Form 15CB', async () => {
    const commission = await tax.post('/api/foreign-payments').send({
      payeeName: 'Antwerp Brokers BV', payeeCountry: 'Belgium', nature: 'commission', paidOn: '2026-10-20', amountFc: 7000, rateInr: 85, relatedParty: true,
    });
    expect(commission.status).toBe(201);
    expect((await tax.post('/api/foreign-payments').send({ payeeName: 'Malca-Amit', nature: 'freight', paidOn: '2026-10-21', amountFc: 500, rateInr: 85, taxableInIndia: false, form15caAck: 'ACK123' })).status).toBe(201);
    expect((await tax.post('/api/foreign-payments').send({ payeeName: 'Lab', nature: 'professional', paidOn: '2026-10-22', amountFc: 100, rateInr: 85, tdsRate: 10, dtaaApplied: true })).status).toBe(201);

    const list = await tax.get('/api/foreign-payments?year=2026-27');
    expect(list.status).toBe(200);
    const byPayee = (name: string) => list.body.payments.find((payment: { payeeName: string }) => payment.payeeName === name);
    expect(byPayee('Antwerp Brokers BV')).toEqual(expect.objectContaining({ amountInr: 595000, form15caPart: 'C' }));
    expect(byPayee('Antwerp Brokers BV').issues.map((issue: { text: string }) => issue.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('no TDS'), expect.stringContaining('Form 15CB')]),
    );
    expect(byPayee('Malca-Amit')).toEqual(expect.objectContaining({ form15caPart: 'D', issues: [] }));
    expect(byPayee('Lab')).toEqual(expect.objectContaining({ tdsInr: 850, form15caPart: 'A' }));
    expect(byPayee('Lab').issues.map((issue: { text: string }) => issue.text)).toEqual(expect.arrayContaining([expect.stringContaining('Tax Residency Certificate')]));
    expect(list.body.totals).toEqual(expect.objectContaining({ count: 3, withoutTds: 1, missing15cb: 1, relatedParty: 1 }));
    expect((await member.get('/api/foreign-payments')).status).toBe(403);
  });

  it('runs audit checks: numbering gaps, edits after a reopened month, and foreign payments without TDS', async () => {
    const second = await owner.post('/api/invoices').send({ invoice: invoice() });
    const third = await owner.post('/api/invoices').send({ invoice: invoice() });
    expect((await owner.delete(`/api/invoices/${second.body.id}`)).status).toBe(204);
    expect((await owner.patch(`/api/invoices/${third.body.id}/status`).send({ status: 'issued' })).status).toBe(200);

    expect((await ca.post('/api/tax/months/2026-10/close')).status).toBe(200);
    expect((await ca.post('/api/tax/months/2026-10/open')).status).toBe(200);
    expect((await tax.put(`/api/invoices/${third.body.id}/tax`).send({ exportScheme: 'lut', shippingBillNo: 'SB-77', shippingBillDate: '2026-10-16' })).status).toBe(200);

    const checks = await ca.get('/api/tax/audit-checks?from=2026-04&to=2027-03');
    expect(checks.status).toBe(200);
    const kinds = checks.body.findings.map((finding: { check: string }) => finding.check);
    expect(kinds).toEqual(expect.arrayContaining(['numbering_gap', 'edited_while_reopened', 'foreign_no_tds', 'foreign_no_15ca']));
    const gap = checks.body.findings.find((finding: { check: string }) => finding.check === 'numbering_gap');
    expect(gap.detail).toContain(second.body.invoiceNumber);
    expect(checks.body.findings[0].severity).toBe('high');
    expect((await member.get('/api/tax/audit-checks')).status).toBe(403);

    const csv = await ca.get('/api/tax/audit-checks/csv?from=2026-04&to=2027-03');
    expect(csv.text).toContain('Gap in invoice numbers');
  });

  it('collects the Form 3CD figures into one tax audit pack', async () => {
    const pack = await ca.get('/api/tax/audit-pack?year=2026-27');
    expect(pack.status).toBe(200);
    expect(pack.body.turnover.lut.invoices).toBe(2);
    expect(pack.body.stock.yieldPercent).toBe(40);
    expect(pack.body.purchases.imports).toEqual(expect.objectContaining({ count: 1, taxableInr: 500000 }));
    expect(pack.body.tds).toEqual(expect.objectContaining({ withoutTds: 1, withoutTdsInr: 595000 }));
    expect(pack.body.relatedParty.purchases.count).toBe(1);
    expect(pack.body.relatedParty.foreignPayments.count).toBe(1);
    expect(pack.body.checks.high).toBeGreaterThan(0);
    expect(pack.body.summary.length).toBeGreaterThan(10);
    expect(pack.body._detail).toBeUndefined();

    const zip = await ca.get('/api/tax/audit-pack/zip?year=2026-27').buffer(true).parse(binary);
    expect(zip.status).toBe(200);
    const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pack-')), 'pack.zip');
    fs.writeFileSync(zipPath, zip.body as Buffer);
    const listing = execFileSync('python3', ['-c', `import zipfile; z=zipfile.ZipFile(${JSON.stringify(zipPath)}); print('\\n'.join(z.namelist())); print(z.read('summary.csv').decode())`], { encoding: 'utf8' });
    for (const name of ['summary.csv', 'stock-register-clause-35.csv', 'purchase-register.csv', 'foreign-payments-tds.csv', 'receivables-at-year-end.csv', 'audit-checks.csv']) {
      expect(listing).toContain(name);
    }
    expect(listing).toContain('Clause 35');
  });

  it('reconciles Tally vouchers with invoices, receipts, and purchases', async () => {
    const stored = await owner.get(`/api/invoices/${firstInvoice.id}`);
    const salesXml = generateTallyPrimeXML(stored.body.invoice as InvoiceState);
    const extraXml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>
      <VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20261018</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>EXP/OLD/9</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Unknown Buyer</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Unknown Buyer</LEDGERNAME><AMOUNT>-50000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
      <VOUCHER VCHTYPE="Purchase" ACTION="Create"><DATE>20261005</DATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>P-1</VOUCHERNUMBER>
        <REFERENCE>INV-077</REFERENCE><PARTYLEDGERNAME>Gem Traders</PARTYLEDGERNAME>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Gem Traders</LEDGERNAME><AMOUNT>100250.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
    </TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    expect(parseTallyXml(salesXml)).toEqual([expect.objectContaining({ kind: 'sales', number: firstInvoice.invoiceNumber, amountUsd: 1000 })]);

    const first = await tax.post('/api/tally/import').send({ content: salesXml });
    expect(first.status).toBe(201);
    expect(first.body.imported).toBe(1);
    expect((await tax.post('/api/tally/import').send({ content: salesXml })).body.duplicates).toBe(1);
    expect((await tax.post('/api/tally/import').send({ content: extraXml })).body.imported).toBe(2);

    const report = await ca.get('/api/tally/reconcile?from=2026-10&to=2026-10');
    expect(report.status).toBe(200);
    const find = (reference: string, area: string) => report.body.rows.find((row: { reference: string; area: string }) => row.reference === reference && row.area === area);
    expect(find(firstInvoice.invoiceNumber, 'sales').status).toBe('matched');
    expect(find('EXP/OLD/9', 'sales').status).toBe('missing_in_app');
    expect(find('INV-77', 'purchases').status).toBe('matched');
    expect(find('LF-80', 'purchases').status).toBe('missing_in_tally');
    expect(report.body.totals.missingInTally).toBeGreaterThan(0);
    expect((await member.post('/api/tally/import').send({ content: 'nothing' })).status).toBe(400);
  });

  it('lets the accountant ask for documents and the company answer with a file', async () => {
    const asked = await ca.post('/api/requests').send({ title: 'Bank statement for October', detail: 'PDF from the bank, all accounts.', dueDate: '2026-11-05', invoiceId: firstInvoice.id });
    expect(asked.status).toBe(201);
    expect((await ca.post('/api/requests').send({ title: '' })).status).toBe(400);

    const pdf = Buffer.from('%PDF-1.4 statement').toString('base64');
    const answered = await owner.post(`/api/requests/${asked.body.id}/messages`).send({ body: 'Attached.', file: { name: 'october.pdf', type: 'application/pdf', base64: pdf } });
    expect(answered.status).toBe(201);
    expect((await owner.post(`/api/requests/${asked.body.id}/messages`).send({ file: { name: 'x.exe', type: 'application/x-msdownload', base64: pdf } })).status).toBe(400);

    const list = await ca.get('/api/requests');
    expect(list.body.requests[0]).toEqual(expect.objectContaining({ title: 'Bank statement for October', status: 'answered', messages: 1, invoiceNumber: firstInvoice.invoiceNumber }));
    const messages = await ca.get(`/api/requests/${asked.body.id}/messages`);
    expect(messages.body.messages[0].file).toEqual(expect.objectContaining({ name: 'october.pdf' }));
    const file = await ca.get(`/api/requests/${asked.body.id}/messages/${messages.body.messages[0].id}/file`).buffer(true).parse(binary);
    expect((file.body as Buffer).toString()).toBe('%PDF-1.4 statement');

    expect((await member.post(`/api/requests/${asked.body.id}/status`).send({ status: 'closed' })).status).toBe(403);
    expect((await ca.post(`/api/requests/${asked.body.id}/status`).send({ status: 'closed' })).status).toBe(200);
    expect((await owner.post(`/api/requests/${asked.body.id}/messages`).send({ body: 'More' })).status).toBe(409);
    expect((await ca.get('/api/requests')).body.requests).toEqual([]);
  });

  it('tracks notices and drafts replies only from figures in the records', async () => {
    expect((await tax.post('/api/notices').send({ authority: 'gst', formType: 'ASMT-10', invoiceNumbers: ['NOPE-1'] })).status).toBe(400);
    const notice = await ca.post('/api/notices').send({
      authority: 'gst', formType: 'ASMT-10', referenceNo: 'ZA2410260001', period: '2026-10', issuedOn: '2026-10-25', replyDue: '2026-11-05',
      amountInr: 25000, summary: 'Difference between GSTR-1 and the e-way bill data.', invoiceNumbers: [firstInvoice.invoiceNumber],
    });
    expect(notice.status).toBe(201);

    draftReply = async (facts) => ({ paragraphs: [`Invoice ${facts.invoices[0].invoiceNumber} for USD 1000.00 was exported under LUT.`] });
    const grounded = await ca.post(`/api/notices/${notice.body.id}/draft-reply`);
    expect(grounded.status).toBe(200);
    expect(grounded.body.source).toBe('model');
    expect(grounded.body.reply).toContain('USD 1000.00');

    draftReply = async () => ({ paragraphs: ['We paid USD 77777.00 in tax already.'] });
    const invented = await ca.post(`/api/notices/${notice.body.id}/draft-reply`);
    expect(invented.body.source).toBe('template');
    expect(invented.body.note).toContain('not in your records');
    expect(invented.body.reply).toContain(firstInvoice.invoiceNumber);
    expect(invented.body.reply).not.toContain('77777');

    draftReply = async () => {
      throw new Error('model offline');
    };
    expect((await ca.post(`/api/notices/${notice.body.id}/draft-reply`)).body.source).toBe('template');

    const list = await tax.get('/api/notices');
    expect(list.body.notices[0]).toEqual(expect.objectContaining({ formType: 'ASMT-10', status: 'open', invoiceNumbers: [firstInvoice.invoiceNumber], replySource: 'template' }));
    expect((await ca.delete(`/api/notices/${notice.body.id}`)).status).toBe(403);
    expect((await member.get('/api/notices')).status).toBe(403);
  });

  it('warns before shipping more to a buyer over the credit limit', async () => {
    const buyer = await owner.post('/api/buyers').send({ consignee: { companyName: 'Rosenfeld & Sons BVBA', country: 'Belgium' } });
    expect(buyer.status).toBe(201);
    expect((await member.put(`/api/buyers/${buyer.body.id}/credit-limit`).send({ creditLimitUsd: 1500 })).status).toBe(403);
    expect((await owner.put(`/api/buyers/${buyer.body.id}/credit-limit`).send({ creditLimitUsd: 1500 })).status).toBe(200);

    const risk = await member.get('/api/buyers/risk');
    expect(risk.body.buyers[0]).toEqual(expect.objectContaining({ buyerName: 'Rosenfeld & Sons BVBA', invoices: 2, outstandingUsd: 2000, creditLimitUsd: 1500, headroomUsd: -500 }));
    const check = await member.get(`/api/buyers/risk/check?buyer=${encodeURIComponent('rosenfeld & sons bvba')}&amountUsd=500`);
    expect(check.body.warnings).toEqual([expect.stringContaining('over the credit limit')]);
    expect((await member.get('/api/buyers/risk/check?buyer=Brand%20New&amountUsd=10')).body).toEqual(expect.objectContaining({ grade: 'new', warnings: [] }));
  });

  it('gives an outside accountant firm practice tools across its clients', async () => {
    const firm = request.agent(app);
    expect((await firm.post('/api/auth/register').send({ email: 'partner@shahco.example', password: 'password123', companyName: 'Shah & Co' })).status).toBe(201);
    expect((await firm.get('/api/practice/clients')).status).toBe(403);
    expect((await owner.post('/api/team/accountants').send({ email: 'partner@shahco.example', role: 'ca' })).status).toBe(201);

    const clients = await firm.get('/api/practice/clients');
    expect(clients.status).toBe(200);
    const client = clients.body.clients[0];
    expect(client).toEqual(expect.objectContaining({ name: 'Meridian Diamond Exports', engagement: null }));
    expect(client.health.openNotices).toBe(1);
    expect(client.health.score).toBeLessThanOrEqual(100);

    expect((await firm.put(`/api/practice/clients/${client.id}/engagement`).send({ feeInr: 15000, billing: 'monthly' })).status).toBe(200);
    expect((await firm.post('/api/practice/time').send({ clientId: client.id, minutes: 90, task: 'GSTR-1 review', workDate: new Date().toISOString().slice(0, 10) })).status).toBe(201);
    expect((await firm.post('/api/practice/time').send({ clientId: '00000000-0000-4000-8000-000000000000', minutes: 5, task: 'x' })).status).toBe(400);
    const bill = await firm.post('/api/practice/bills').send({ clientId: client.id, billNo: 'SC/26/101', amountInr: 15000 });
    expect(bill.status).toBe(201);
    expect((await firm.post('/api/practice/bills').send({ clientId: client.id, billNo: 'SC/26/101', amountInr: 1 })).status).toBe(409);

    let after = (await firm.get('/api/practice/clients')).body;
    expect(after.clients[0]).toEqual(expect.objectContaining({ engagement: expect.objectContaining({ feeInr: 15000 }), fees: expect.objectContaining({ unpaidInr: 15000, unpaidBills: 1 }) }));
    expect(after.clients[0].time.monthMinutes).toBe(90);
    expect((await firm.post(`/api/practice/bills/${bill.body.id}/paid`).send({})).status).toBe(200);
    after = (await firm.get('/api/practice/clients')).body;
    expect(after.totals.unpaidInr).toBe(0);

    // Inside the client's workspace the CA guard still lets practice records through.
    expect((await firm.post('/api/workspace/switch').send({ organizationId: client.id })).status).toBe(200);
    expect((await firm.post('/api/practice/time').send({ clientId: client.id, minutes: 15, task: 'Call about notice' })).status).toBe(201);
    expect((await firm.post('/api/purchases').send({ kind: 'local', supplierName: 'X', documentNo: 'Z', documentDate: '2026-10-10', taxableInr: 1 })).status).toBe(403);
    expect((await owner.get('/api/practice/clients')).status).toBe(403);
  });

  it('records the new changes in the activity history', async () => {
    const audit = await owner.get('/api/audit?limit=500');
    const actions = new Set(audit.body.events.map((event: { action: string }) => event.action));
    for (const action of ['purchase.create', 'gstr2b.import', 'foreign_payment.create', 'tally.import', 'request.create', 'request.reply', 'notice.create', 'notice.draft', 'buyer.credit_limit']) {
      expect(actions).toContain(action);
    }
  });
});
