import type { Express, Request, Response } from 'express';
import type { DbPool } from '../../core/db.js';
import { parseMonth } from './closedMonths.js';
import { asyncHandler, currentUser } from '../../core/http.js';
import { csvFile, money, taxReader } from './taxShared.js';

/** From and to months (YYYY-MM). Defaults to the current Indian financial year up to this month. */
export function monthRange(req: Request): { from: string; to: string; start: string; end: string } {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  let from = parseMonth(req.query.from) ?? `${fyStartYear}-04`;
  let to = parseMonth(req.query.to) ?? thisMonth;
  if (from > to) [from, to] = [to, from];
  const [toYear, toMonth] = to.split('-').map(Number);
  const lastDay = new Date(Date.UTC(toYear, toMonth, 0)).getUTCDate();
  return { from, to, start: `${from}-01`, end: `${to}-${String(lastDay).padStart(2, '0')}` };
}

const INVOICE_DATE = `COALESCE(i.invoice_date, i.created_at::date)`;

function sendCsv(res: Response, filename: string, header: string[], rows: unknown[][]) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csvFile(header, rows));
}

// ---------- GST refund (zero-rated exports under LUT) ----------

export async function refundSummary(pool: DbPool, organizationId: string, start: string, end: string) {
  const result = await pool.query<{
    id: string; invoice_number: string; invoice_date: string; buyer_name: string; destination_country: string;
    total_usd: string; rate_inr: string | null; shipping_bill_no: string; shipping_bill_date: string | null; port_code: string;
    sb_value_usd: string | null; brc_number: string | null; realised_on: string | null; brc_usd: string | null;
  }>(
    `SELECT i.id, i.invoice_number, to_char(${INVOICE_DATE}, 'YYYY-MM-DD') AS invoice_date, i.buyer_name, i.destination_country,
            i.total_usd, i.data->>'exchangeRateInr' AS rate_inr,
            COALESCE(t.shipping_bill_no, '') AS shipping_bill_no, to_char(t.shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date,
            COALESCE(t.port_code, '') AS port_code, t.sb_value_usd,
            b.brc_number, to_char(b.realised_on, 'YYYY-MM-DD') AS realised_on, b.amount_usd AS brc_usd
     FROM invoices i
     LEFT JOIN invoice_tax t ON t.invoice_id = i.id
     LEFT JOIN invoice_brcs b ON b.invoice_id = i.id
     WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid')
       AND COALESCE(t.export_scheme, 'lut') = 'lut'
       AND ${INVOICE_DATE} BETWEEN $2 AND $3
     ORDER BY ${INVOICE_DATE}, i.invoice_number`,
    [organizationId, start, end],
  );
  const rows = result.rows.map((row) => {
    const rate = Number(row.rate_inr) > 0 ? Number(row.rate_inr) : null;
    const totalUsd = money(row.total_usd);
    const fobUsd = row.sb_value_usd === null ? null : money(row.sb_value_usd);
    const issues: string[] = [];
    if (!row.shipping_bill_no || !row.shipping_bill_date) issues.push('Shipping bill number or date missing');
    if (!row.port_code) issues.push('Port code missing');
    if (!rate) issues.push('Exchange rate missing on the invoice');
    if (!row.brc_number) issues.push('No BRC / e-BRC recorded yet');
    return {
      invoiceId: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      buyerName: row.buyer_name,
      destinationCountry: row.destination_country,
      totalUsd,
      exchangeRateInr: rate,
      valueInr: rate ? money(totalUsd * rate) : null,
      shippingBillNo: row.shipping_bill_no,
      shippingBillDate: row.shipping_bill_date,
      portCode: row.port_code,
      fobUsd,
      fobInr: rate && fobUsd !== null ? money(fobUsd * rate) : null,
      brcNumber: row.brc_number ?? '',
      brcDate: row.realised_on ?? '',
      brcUsd: row.brc_usd === null ? null : money(row.brc_usd),
      issues,
      ready: issues.length === 0,
    };
  });
  const ready = rows.filter((row) => row.ready);
  return {
    rows,
    totals: {
      invoices: rows.length,
      ready: ready.length,
      valueUsd: money(rows.reduce((sum, row) => sum + row.totalUsd, 0)),
      readyValueInr: money(ready.reduce((sum, row) => sum + (row.valueInr ?? 0), 0)),
      readyFobInr: money(ready.reduce((sum, row) => sum + (row.fobInr ?? row.valueInr ?? 0), 0)),
    },
  };
}

// ---------- Line items (certificates and Kimberley Process) ----------

type ItemRow = {
  id: string; invoice_number: string; invoice_date: string; buyer_name: string; destination_country: string; status: string;
  total_usd: string; total_carats: string; kpcs_number: string; items: Array<Record<string, unknown>> | null;
};

async function invoiceItems(pool: DbPool, organizationId: string, start: string, end: string) {
  const result = await pool.query<ItemRow>(
    `SELECT i.id, i.invoice_number, to_char(${INVOICE_DATE}, 'YYYY-MM-DD') AS invoice_date, i.buyer_name, i.destination_country,
            i.status, i.total_usd, i.total_carats, COALESCE(i.data->'shipment'->>'kpcsNumber', '') AS kpcs_number,
            i.data->'items' AS items
     FROM invoices i
     WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND ${INVOICE_DATE} BETWEEN $2 AND $3
     ORDER BY ${INVOICE_DATE}, i.invoice_number`,
    [organizationId, start, end],
  );
  return result.rows;
}

/** Rough and unsorted diamonds travel under a Kimberley Process certificate; polished stones do not need one. */
export function isRoughHsCode(hsCode: string): boolean {
  const digits = hsCode.replace(/\D/g, '');
  return digits.startsWith('710210') || digits.startsWith('710221') || digits.startsWith('710231');
}

export async function kpRegister(pool: DbPool, organizationId: string, start: string, end: string) {
  const invoices = await invoiceItems(pool, organizationId, start, end);
  const seen = new Map<string, string[]>();
  for (const invoice of invoices) {
    const kpc = invoice.kpcs_number.trim().toUpperCase();
    if (kpc) seen.set(kpc, [...(seen.get(kpc) ?? []), invoice.invoice_number]);
  }
  const rows = invoices.map((invoice) => {
    const items = invoice.items ?? [];
    const hsCodes = [...new Set(items.map((item) => String(item.hsCode ?? '').trim()).filter(Boolean))];
    const roughCarats = items
      .filter((item) => isRoughHsCode(String(item.hsCode ?? '')))
      .reduce((sum, item) => sum + (Number(item.carats) || 0), 0);
    const kpc = invoice.kpcs_number.trim();
    const issues: string[] = [];
    if (roughCarats > 0 && !kpc) issues.push('Rough diamonds without a KP certificate number');
    const shared = kpc ? (seen.get(kpc.toUpperCase()) ?? []).filter((number) => number !== invoice.invoice_number) : [];
    if (shared.length) issues.push(`Same KP certificate as ${shared.join(', ')}`);
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      invoiceDate: invoice.invoice_date,
      buyerName: invoice.buyer_name,
      destinationCountry: invoice.destination_country,
      kpcNumber: kpc,
      hsCodes,
      carats: Math.round(Number(invoice.total_carats) * 1000) / 1000,
      roughCarats: Math.round(roughCarats * 1000) / 1000,
      valueUsd: money(invoice.total_usd),
      issues,
    };
  });
  return {
    rows,
    totals: {
      shipments: rows.length,
      withKpc: rows.filter((row) => row.kpcNumber).length,
      roughCarats: Math.round(rows.reduce((sum, row) => sum + row.roughCarats, 0) * 1000) / 1000,
      carats: Math.round(rows.reduce((sum, row) => sum + row.carats, 0) * 1000) / 1000,
      issues: rows.filter((row) => row.issues.length).length,
    },
  };
}

export type Lab = 'GIA' | 'IGI' | 'HRD' | '';

export function guessLab(certificateNo: string, description: string): Lab {
  const text = `${certificateNo} ${description}`.toUpperCase();
  if (/\bGIA\b/.test(text)) return 'GIA';
  if (/\bIGI\b/.test(text) || /^LG\d+/.test(certificateNo.toUpperCase())) return 'IGI';
  if (/\bHRD\b/.test(text)) return 'HRD';
  if (/^\d{10}$/.test(certificateNo.replace(/\D/g, '')) && /^\d+$/.test(certificateNo.trim())) return 'GIA';
  return '';
}

export function verifyUrl(lab: Lab, certificateNo: string): string {
  const number = encodeURIComponent(certificateNo.replace(/^(GIA|IGI|HRD)[\s:#-]*/i, '').trim());
  if (!number) return '';
  if (lab === 'GIA') return `https://www.gia.edu/report-check?reportno=${number}`;
  if (lab === 'IGI') return `https://www.igi.org/verify-your-report/?r=${number}`;
  return '';
}

export async function certificateCheck(pool: DbPool, organizationId: string, start: string, end: string) {
  const invoices = await invoiceItems(pool, organizationId, start, end);
  const lines = invoices.flatMap((invoice) =>
    (invoice.items ?? []).map((item, index) => ({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      invoiceDate: invoice.invoice_date,
      line: Number(item.srNo) || index + 1,
      description: String(item.description ?? ''),
      certificateNo: String(item.certificateNo ?? '').trim(),
      hsCode: String(item.hsCode ?? ''),
      pieces: Number(item.pieces) || 0,
      carats: Number(item.carats) || 0,
      colorClarity: String(item.colorClarity ?? ''),
      shape: String(item.shape ?? ''),
    })),
  );
  const uses = new Map<string, string[]>();
  for (const line of lines) {
    if (!line.certificateNo) continue;
    const key = line.certificateNo.toUpperCase();
    uses.set(key, [...(uses.get(key) ?? []), `${line.invoiceNumber} line ${line.line}`]);
  }
  const rows = lines
    .filter((line) => !isRoughHsCode(line.hsCode))
    .map((line) => {
      const lab = line.certificateNo ? guessLab(line.certificateNo, line.description) : '';
      const issues: Array<{ tone: 'red' | 'amber'; text: string }> = [];
      if (!line.certificateNo) {
        if (line.carats >= 0.3 && line.pieces === 1) issues.push({ tone: 'amber', text: 'Single stone of 0.30 ct or more with no certificate' });
      } else {
        const others = (uses.get(line.certificateNo.toUpperCase()) ?? []).filter((use) => use !== `${line.invoiceNumber} line ${line.line}`);
        if (others.length) issues.push({ tone: 'red', text: `Certificate also used on ${others.join(', ')}` });
        if (line.pieces > 1) issues.push({ tone: 'amber', text: `One certificate for ${line.pieces} pieces; a grading report covers one stone` });
        if (!lab) issues.push({ tone: 'amber', text: 'Lab not recognised; add GIA, IGI, or HRD to the description' });
      }
      return { ...line, lab, verifyUrl: lab ? verifyUrl(lab, line.certificateNo) : '', issues };
    });
  return {
    rows,
    totals: {
      lines: rows.length,
      certified: rows.filter((row) => row.certificateNo).length,
      duplicates: rows.filter((row) => row.issues.some((issue) => issue.tone === 'red')).length,
      warnings: rows.filter((row) => row.issues.some((issue) => issue.tone === 'amber')).length,
    },
  };
}

export function registerExportReportRoutes(app: Express, pool: DbPool): void {
  app.get('/api/tax/refund-summary', taxReader, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    return res.json({ from: range.from, to: range.to, ...(await refundSummary(pool, currentUser(res).organizationId, range.start, range.end)) });
  }));

  app.get('/api/tax/refund-summary/csv', taxReader, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    const { rows } = await refundSummary(pool, currentUser(res).organizationId, range.start, range.end);
    return sendCsv(
      res,
      `gst-refund-statement-${range.from}-to-${range.to}.csv`,
      ['Invoice no', 'Invoice date', 'Buyer', 'Destination', 'Invoice value USD', 'Exchange rate', 'Invoice value INR',
        'Shipping bill no', 'Shipping bill date', 'Port code', 'FOB value USD', 'FOB value INR', 'BRC / e-BRC no', 'BRC date', 'BRC value USD', 'Ready'],
      rows.map((row) => [
        row.invoiceNumber, row.invoiceDate, row.buyerName, row.destinationCountry, row.totalUsd.toFixed(2), row.exchangeRateInr ?? '',
        row.valueInr?.toFixed(2) ?? '', row.shippingBillNo, row.shippingBillDate ?? '', row.portCode, row.fobUsd?.toFixed(2) ?? '',
        row.fobInr?.toFixed(2) ?? '', row.brcNumber, row.brcDate, row.brcUsd?.toFixed(2) ?? '', row.ready ? 'Yes' : row.issues.join('; '),
      ]),
    );
  }));

  app.get('/api/tax/kp-register', taxReader, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    return res.json({ from: range.from, to: range.to, ...(await kpRegister(pool, currentUser(res).organizationId, range.start, range.end)) });
  }));

  app.get('/api/tax/kp-register/csv', taxReader, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    const { rows } = await kpRegister(pool, currentUser(res).organizationId, range.start, range.end);
    return sendCsv(
      res,
      `kimberley-process-register-${range.from}-to-${range.to}.csv`,
      ['Invoice no', 'Date', 'Buyer', 'Destination', 'KP certificate no', 'HS codes', 'Total carats', 'Rough carats', 'Value USD', 'Issues'],
      rows.map((row) => [
        row.invoiceNumber, row.invoiceDate, row.buyerName, row.destinationCountry, row.kpcNumber, row.hsCodes.join(' '),
        row.carats.toFixed(3), row.roughCarats.toFixed(3), row.valueUsd.toFixed(2), row.issues.join('; '),
      ]),
    );
  }));

  app.get('/api/tax/certificates', taxReader, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    return res.json({ from: range.from, to: range.to, ...(await certificateCheck(pool, currentUser(res).organizationId, range.start, range.end)) });
  }));
}
