import crypto from 'node:crypto';
import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { monthRange } from '../tax/exportReports.js';
import { daysBetween, documentKey } from '../../core/formInput.js';
import { asyncHandler, currentUser } from '../../core/http.js';
import { csvFile, findColumn, money, parseCsv, parseLooseDate, taxManager, taxReader, taxWriter } from '../tax/taxShared.js';

export const MAX_TALLY_VOUCHERS = 5000;

export type VoucherKind = 'sales' | 'receipt' | 'purchase' | 'other';

export type TallyVoucher = {
  date: string;
  voucherType: string;
  kind: VoucherKind;
  number: string;
  party: string;
  reference: string;
  amountInr: number;
  amountUsd: number | null;
  narration: string;
};

export function voucherKind(voucherType: string): VoucherKind {
  const type = voucherType.toLowerCase();
  if (type.includes('sales') || type.includes('export')) return 'sales';
  if (type.includes('receipt')) return 'receipt';
  if (type.includes('purchase') || type.includes('import')) return 'purchase';
  return 'other';
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(xml: string, name: string): string {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return match ? decodeXml(match[1]) : '';
}

/**
 * Reads a Tally amount. Foreign currency entries look like "-$ 1,250.00 @ ₹ 86.50/$ = -₹ 1,08,125.00";
 * plain ones are "-108125.00". Returns the rupee amount and, when present, the dollar amount (both positive).
 */
export function parseTallyAmount(raw: string): { inr: number; usd: number | null } | null {
  const text = raw.replace(/,/g, '').trim();
  if (!text) return null;
  const number = (value: string) => {
    const match = /-?\d+(?:\.\d+)?/.exec(value);
    return match ? Math.abs(Number(match[0])) : null;
  };
  if (text.includes('=')) {
    const [foreign, base] = text.split('=');
    const inr = number(base);
    if (inr === null) return null;
    return { inr: money(inr), usd: foreign.includes('$') ? money(number(foreign.split('@')[0]) ?? 0) : null };
  }
  if (text.includes('$')) {
    const usd = number(text);
    return usd === null ? null : { inr: 0, usd: money(usd) };
  }
  const inr = number(text);
  return inr === null ? null : { inr: money(inr), usd: null };
}

function parseTallyDate(raw: string): string | null {
  const digits = raw.trim();
  if (/^\d{8}$/.test(digits)) return parseLooseDate(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`);
  const named = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(digits);
  if (named) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(named[2].toLowerCase()) + 1;
    const year = named[3].length === 2 ? 2000 + Number(named[3]) : Number(named[3]);
    if (month > 0) return parseLooseDate(`${year}-${month}-${named[1]}`);
  }
  return parseLooseDate(digits);
}

/** Vouchers from a Tally XML export (Day Book or Vouchers, exported as XML). */
export function parseTallyXml(xml: string): TallyVoucher[] {
  const vouchers: TallyVoucher[] = [];
  for (const match of xml.matchAll(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi)) {
    const [, attributes, body] = match;
    const date = parseTallyDate(tag(body, 'DATE'));
    if (!date) continue;
    const voucherType = tag(body, 'VOUCHERTYPENAME') || /VCHTYPE="([^"]*)"/i.exec(attributes)?.[1] || '';
    const party = tag(body, 'PARTYLEDGERNAME') || tag(body, 'PARTYNAME');
    const entries = [...body.matchAll(/<(ALLLEDGERENTRIES|LEDGERENTRIES)\.LIST>([\s\S]*?)<\/\1\.LIST>/gi)].map((entry) => {
      const amount = parseTallyAmount(tag(entry[2], 'AMOUNT'));
      const base = parseTallyAmount(tag(entry[2], 'BASEAMOUNT'));
      // Foreign currency entries can carry the rupee value separately in BASEAMOUNT.
      if (amount && amount.inr === 0 && base) amount.inr = base.inr;
      return { ledger: tag(entry[2], 'LEDGERNAME'), amount: amount ?? base };
    });
    const partyEntry = entries.find((entry) => party && entry.ledger.toLowerCase() === party.toLowerCase());
    const largest = entries.reduce<{ inr: number; usd: number | null } | null>(
      (best, entry) => (entry.amount && (!best || entry.amount.inr > best.inr) ? entry.amount : best),
      null,
    );
    const amount = partyEntry?.amount ?? largest;
    vouchers.push({
      date,
      voucherType,
      kind: voucherKind(voucherType),
      number: tag(body, 'VOUCHERNUMBER'),
      party,
      reference: tag(body, 'REFERENCE'),
      amountInr: amount?.inr ?? 0,
      amountUsd: amount?.usd ?? null,
      narration: tag(body, 'NARRATION').slice(0, 1000),
    });
  }
  return vouchers;
}

/** Vouchers from a Day Book exported to Excel and saved as CSV. */
export function parseTallyCsv(text: string): TallyVoucher[] | string {
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex((row) => findColumn(row, ['date']) >= 0 && findColumn(row, ['vch type', 'voucher type']) >= 0);
  if (headerIndex < 0) return 'The CSV needs Date and Vch Type columns, as in the Tally Day Book export.';
  const header = rows[headerIndex];
  const col = (names: string[]) => findColumn(header, names);
  const date = col(['date']);
  const type = col(['vch type', 'voucher type']);
  const number = col(['vch no', 'voucher no', 'voucher number', 'vch no.']);
  const party = col(['particulars', 'party', 'party name', 'ledger']);
  const debit = col(['debit', 'debit amount', 'debit amt']);
  const credit = col(['credit', 'credit amount', 'credit amt']);
  const amountCol = col(['amount', 'value']);
  const reference = col(['reference', 'ref', 'reference no']);
  const narration = col(['narration', 'remarks']);
  const vouchers: TallyVoucher[] = [];
  for (const cells of rows.slice(headerIndex + 1)) {
    const cell = (index: number) => (index >= 0 ? (cells[index] ?? '').trim() : '');
    const parsedDate = parseTallyDate(cell(date));
    if (!parsedDate) continue;
    const amounts = [cell(debit), cell(credit), cell(amountCol)].map((value) => parseTallyAmount(value)?.inr ?? 0);
    const voucherType = cell(type);
    vouchers.push({
      date: parsedDate,
      voucherType,
      kind: voucherKind(voucherType),
      number: cell(number),
      party: cell(party),
      reference: cell(reference),
      amountInr: Math.max(...amounts),
      amountUsd: null,
      narration: cell(narration).slice(0, 1000),
    });
  }
  return vouchers;
}

function fingerprint(voucher: TallyVoucher): string {
  return crypto
    .createHash('sha256')
    .update([voucher.date, voucher.voucherType.toLowerCase(), voucher.number.toUpperCase(), voucher.party.toLowerCase(), voucher.amountInr.toFixed(2)].join('|'))
    .digest('hex');
}

const closeEnough = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.005);

export type ReconcileStatus = 'matched' | 'amount_differs' | 'date_differs' | 'missing_in_tally' | 'missing_in_app';

/** Compares the app with the vouchers imported from Tally, for sales, receipts, and purchases. */
export async function tallyReconcile(pool: DbPool, organizationId: string, start: string, end: string) {
  const [voucherResult, invoiceResult, paymentResult, purchaseResult] = await Promise.all([
    pool.query<{ id: string; voucher_date: string; voucher_type: string; voucher_kind: VoucherKind; voucher_number: string; party: string; reference: string; amount_inr: string; amount_usd: string | null; narration: string }>(
      `SELECT id, to_char(voucher_date, 'YYYY-MM-DD') AS voucher_date, voucher_type, voucher_kind, voucher_number, party, reference, amount_inr,
              amount_usd, narration
       FROM tally_vouchers WHERE organization_id = $1 AND voucher_date BETWEEN ($2::date - 31) AND ($3::date + 31)`,
      [organizationId, start, end],
    ),
    pool.query<{ id: string; invoice_number: string; invoice_date: string; buyer_name: string; total_usd: string; rate: string | null }>(
      `SELECT id, invoice_number, to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date, buyer_name, total_usd,
              data->>'exchangeRateInr' AS rate
       FROM invoices WHERE organization_id = $1 AND status IN ('issued', 'paid') AND COALESCE(invoice_date, created_at::date) BETWEEN $2 AND $3`,
      [organizationId, start, end],
    ),
    pool.query<{ id: string; invoice_id: string; invoice_number: string; buyer_name: string; paid_on: string; amount_usd: string; bank_rate_inr: string | null }>(
      `SELECT p.id, p.invoice_id, i.invoice_number, i.buyer_name, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd, p.bank_rate_inr
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE p.organization_id = $1 AND p.paid_on BETWEEN $2 AND $3`,
      [organizationId, start, end],
    ),
    pool.query<{ id: string; document_no: string; supplier_name: string; document_date: string; total_inr: string; taxable_inr: string }>(
      `SELECT id, document_no, supplier_name, to_char(document_date, 'YYYY-MM-DD') AS document_date,
              taxable_inr + igst_inr + cgst_inr + sgst_inr AS total_inr, taxable_inr
       FROM purchases WHERE organization_id = $1 AND document_date BETWEEN $2 AND $3`,
      [organizationId, start, end],
    ),
  ]);

  const vouchers = voucherResult.rows.map((row) => ({
    id: row.id,
    date: row.voucher_date,
    kind: row.voucher_kind,
    voucherType: row.voucher_type,
    number: row.voucher_number,
    party: row.party,
    reference: row.reference,
    amountInr: money(row.amount_inr),
    amountUsd: row.amount_usd === null ? null : money(row.amount_usd),
    narration: row.narration,
  }));
  const used = new Set<string>();
  const inRange = (date: string) => date >= start && date <= end;

  type Row = {
    area: 'sales' | 'receipts' | 'purchases';
    status: ReconcileStatus;
    reference: string;
    party: string;
    appDate: string | null;
    tallyDate: string | null;
    appAmount: string;
    tallyAmount: string;
    invoiceId: string | null;
    detail: string;
  };
  const rows: Row[] = [];
  const inr = (value: number) => `₹${value.toFixed(2)}`;

  // Sales: voucher number is the invoice number.
  const sales = vouchers.filter((voucher) => voucher.kind === 'sales');
  for (const invoice of invoiceResult.rows) {
    const key = documentKey(invoice.invoice_number);
    const voucher = sales.find((entry) => !used.has(entry.id) && documentKey(entry.number) === key);
    const totalUsd = money(invoice.total_usd);
    const rate = Number(invoice.rate) > 0 ? Number(invoice.rate) : null;
    const appInr = rate ? money(totalUsd * rate) : null;
    const base = { area: 'sales' as const, reference: invoice.invoice_number, party: invoice.buyer_name, appDate: invoice.invoice_date, invoiceId: invoice.id, appAmount: `USD ${totalUsd.toFixed(2)}${appInr ? ` (${inr(appInr)})` : ''}` };
    if (!voucher) {
      rows.push({ ...base, status: 'missing_in_tally', tallyDate: null, tallyAmount: '', detail: 'Issued in the app but no sales voucher with this number in Tally.' });
      continue;
    }
    used.add(voucher.id);
    const tallyAmount = voucher.amountUsd !== null ? `USD ${voucher.amountUsd.toFixed(2)} (${inr(voucher.amountInr)})` : inr(voucher.amountInr);
    const amountOk = voucher.amountUsd !== null && voucher.amountUsd > 0 ? closeEnough(voucher.amountUsd, totalUsd) : appInr !== null && closeEnough(voucher.amountInr, appInr);
    const status: ReconcileStatus = !amountOk ? 'amount_differs' : voucher.date !== invoice.invoice_date ? 'date_differs' : 'matched';
    rows.push({
      ...base,
      status,
      tallyDate: voucher.date,
      tallyAmount,
      detail: status === 'amount_differs' ? (appInr === null && voucher.amountUsd === null ? 'The invoice has no exchange rate, so the rupee value cannot be compared.' : 'Amounts differ.') : status === 'date_differs' ? 'Dates differ; this can move the sale into another month or return.' : '',
    });
  }

  // Receipts: same date (within 3 days), and the dollar or rupee amount agrees.
  const receipts = vouchers.filter((voucher) => voucher.kind === 'receipt');
  for (const payment of paymentResult.rows) {
    const amountUsd = money(payment.amount_usd);
    const bankInr = payment.bank_rate_inr ? money(amountUsd * Number(payment.bank_rate_inr)) : null;
    const key = documentKey(payment.invoice_number);
    const candidates = receipts.filter((voucher) => !used.has(voucher.id) && Math.abs(daysBetween(payment.paid_on, voucher.date)) <= 3);
    const amountMatches = (voucher: (typeof receipts)[number]) =>
      (voucher.amountUsd !== null && closeEnough(voucher.amountUsd, amountUsd)) || (bankInr !== null && closeEnough(voucher.amountInr, bankInr));
    const voucher =
      candidates.find((entry) => amountMatches(entry) && (documentKey(entry.reference) === key || documentKey(entry.narration).includes(key))) ??
      candidates.find((entry) => amountMatches(entry) && entry.party.toLowerCase() === payment.buyer_name.toLowerCase()) ??
      candidates.find(amountMatches);
    const base = { area: 'receipts' as const, reference: payment.invoice_number, party: payment.buyer_name, appDate: payment.paid_on, invoiceId: payment.invoice_id, appAmount: `USD ${amountUsd.toFixed(2)}${bankInr ? ` (${inr(bankInr)})` : ''}` };
    if (!voucher) {
      rows.push({ ...base, status: 'missing_in_tally', tallyDate: null, tallyAmount: '', detail: 'Payment recorded in the app but no matching receipt voucher in Tally.' });
      continue;
    }
    used.add(voucher.id);
    rows.push({ ...base, status: voucher.date === payment.paid_on ? 'matched' : 'date_differs', tallyDate: voucher.date, tallyAmount: voucher.amountUsd !== null ? `USD ${voucher.amountUsd.toFixed(2)}` : inr(voucher.amountInr), detail: '' });
  }

  // Purchases: voucher number or reference is the supplier invoice / Bill of Entry number.
  const purchaseVouchers = vouchers.filter((voucher) => voucher.kind === 'purchase');
  for (const purchase of purchaseResult.rows) {
    const key = documentKey(purchase.document_no);
    const voucher = purchaseVouchers.find((entry) => !used.has(entry.id) && (documentKey(entry.reference) === key || documentKey(entry.number) === key));
    const total = money(purchase.total_inr);
    const taxable = money(purchase.taxable_inr);
    const base = { area: 'purchases' as const, reference: purchase.document_no, party: purchase.supplier_name, appDate: purchase.document_date, invoiceId: null, appAmount: inr(total) };
    if (!voucher) {
      rows.push({ ...base, status: 'missing_in_tally', tallyDate: null, tallyAmount: '', detail: 'Purchase recorded in the app but not in Tally.' });
      continue;
    }
    used.add(voucher.id);
    const amountOk = closeEnough(voucher.amountInr, total) || closeEnough(voucher.amountInr, taxable);
    rows.push({ ...base, status: amountOk ? (voucher.date === purchase.document_date ? 'matched' : 'date_differs') : 'amount_differs', tallyDate: voucher.date, tallyAmount: inr(voucher.amountInr), detail: amountOk ? '' : 'Amounts differ.' });
  }

  for (const voucher of vouchers) {
    if (used.has(voucher.id) || voucher.kind === 'other' || !inRange(voucher.date)) continue;
    rows.push({
      area: voucher.kind === 'sales' ? 'sales' : voucher.kind === 'receipt' ? 'receipts' : 'purchases',
      status: 'missing_in_app',
      reference: voucher.number || voucher.reference,
      party: voucher.party,
      appDate: null,
      tallyDate: voucher.date,
      appAmount: '',
      tallyAmount: voucher.amountUsd !== null ? `USD ${voucher.amountUsd.toFixed(2)}` : inr(voucher.amountInr),
      invoiceId: null,
      detail: `${voucher.voucherType} voucher in Tally with nothing matching in the app.`,
    });
  }

  const order: Record<ReconcileStatus, number> = { amount_differs: 0, missing_in_tally: 1, missing_in_app: 2, date_differs: 3, matched: 4 };
  rows.sort((a, b) => a.area.localeCompare(b.area) || order[a.status] - order[b.status] || (a.appDate ?? a.tallyDate ?? '').localeCompare(b.appDate ?? b.tallyDate ?? ''));
  const count = (status: ReconcileStatus) => rows.filter((row) => row.status === status).length;
  return {
    rows,
    vouchersImported: vouchers.filter((voucher) => inRange(voucher.date)).length,
    totals: {
      matched: count('matched'),
      amountDiffers: count('amount_differs'),
      dateDiffers: count('date_differs'),
      missingInTally: count('missing_in_tally'),
      missingInApp: count('missing_in_app'),
    },
  };
}

export function registerTallySyncRoutes(app: Express, pool: DbPool): void {
  app.post('/api/tally/import', taxWriter, asyncHandler(async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!content.trim()) return res.status(400).json({ error: 'Choose a Tally export file (XML or CSV).' });
    const parsed = /<ENVELOPE|<VOUCHER/i.test(content) ? parseTallyXml(content) : parseTallyCsv(content);
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
    if (!parsed.length) return res.status(400).json({ error: 'No vouchers were found in that file.' });
    if (parsed.length > MAX_TALLY_VOUCHERS) return res.status(400).json({ error: `Import at most ${MAX_TALLY_VOUCHERS} vouchers at a time.` });
    const organizationId = currentUser(res).organizationId;
    let imported = 0;
    for (const voucher of parsed) {
      const inserted = await pool.query(
        `INSERT INTO tally_vouchers (organization_id, voucher_date, voucher_type, voucher_kind, voucher_number, party, reference, amount_inr,
           amount_usd, narration, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (organization_id, fingerprint) DO NOTHING`,
        [organizationId, voucher.date, voucher.voucherType.slice(0, 100), voucher.kind, voucher.number.slice(0, 100), voucher.party.slice(0, 200),
          voucher.reference.slice(0, 100), voucher.amountInr, voucher.amountUsd, voucher.narration, fingerprint(voucher)],
      );
      if (inserted.rowCount) imported += 1;
    }
    return res.status(201).json({ read: parsed.length, imported, duplicates: parsed.length - imported });
  }));

  app.get('/api/tally/reconcile', taxReader, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    return res.json({ from: range.from, to: range.to, ...(await tallyReconcile(pool, currentUser(res).organizationId, range.start, range.end)) });
  }));

  app.get('/api/tally/reconcile/csv', taxReader, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    const report = await tallyReconcile(pool, currentUser(res).organizationId, range.start, range.end);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tally-reconciliation-${range.from}-to-${range.to}.csv"`);
    return res.send(
      csvFile(
        ['Area', 'Status', 'Reference', 'Party', 'App date', 'Tally date', 'App amount', 'Tally amount', 'Detail'],
        report.rows.map((row) => [row.area, row.status.replace(/_/g, ' '), row.reference, row.party, row.appDate ?? '', row.tallyDate ?? '', row.appAmount, row.tallyAmount, row.detail]),
      ),
    );
  }));

  app.delete('/api/tally/vouchers', taxManager, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    const deleted = await pool.query('DELETE FROM tally_vouchers WHERE organization_id = $1 AND voucher_date BETWEEN $2 AND $3', [
      currentUser(res).organizationId,
      range.start,
      range.end,
    ]);
    return res.json({ deleted: deleted.rowCount ?? 0 });
  }));
}
