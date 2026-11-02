import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { closedMonthMessage, parseMonth } from './closedMonths.js';
import { asyncHandler, currentUser, isUuid } from '../../core/http.js';
import type { StoredInvoice } from '../invoices/invoiceValidation.js';
import {
  DIAMOND_GST_RATE,
  currentMonth,
  invoiceDateOf,
  money,
  sendDownload,
  taxReader,
  taxSettings,
  taxWriter,
} from './taxShared.js';

export type FilingIssue = { code: string; message: string };

type FilingSource = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  status: string;
  total_usd: string;
  data: StoredInvoice;
  export_scheme: 'lut' | 'igst';
  shipping_bill_no: string;
  shipping_bill_date: string | null;
  port_code: string;
  sb_invoice_number: string;
  sb_value_usd: string | null;
  igst_usd: string;
  irn: string | null;
};

const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DOCUMENT_NUMBER_PATTERN = /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/;

const COUNTRY_CODES: Record<string, string> = {
  BELGIUM: 'BE', 'UNITED STATES': 'US', USA: 'US', 'UNITED STATES OF AMERICA': 'US', 'HONG KONG': 'HK',
  'UNITED ARAB EMIRATES': 'AE', UAE: 'AE', ISRAEL: 'IL', SWITZERLAND: 'CH', 'UNITED KINGDOM': 'GB', UK: 'GB',
  SINGAPORE: 'SG', JAPAN: 'JP', THAILAND: 'TH', CHINA: 'CN', ITALY: 'IT', FRANCE: 'FR', GERMANY: 'DE',
  CANADA: 'CA', AUSTRALIA: 'AU', NETHERLANDS: 'NL', 'SOUTH AFRICA': 'ZA',
};

const FILING_SQL = `
  SELECT i.id, i.invoice_number,
         to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
         i.status, i.total_usd, i.data,
         COALESCE(t.export_scheme, 'lut') AS export_scheme,
         COALESCE(t.shipping_bill_no, '') AS shipping_bill_no,
         to_char(t.shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date,
         COALESCE(t.port_code, '') AS port_code,
         COALESCE(t.sb_invoice_number, '') AS sb_invoice_number,
         t.sb_value_usd,
         COALESCE(t.igst_usd, 0) AS igst_usd,
         e.irn
  FROM invoices i
  LEFT JOIN invoice_tax t ON t.invoice_id = i.id
  LEFT JOIN invoice_einvoices e ON e.invoice_id = i.id
`;

async function filingSources(pool: DbPool, organizationId: string, month: string): Promise<FilingSource[]> {
  const result = await pool.query<FilingSource>(
    `${FILING_SQL}
     WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid')
       AND to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM') = $2
     ORDER BY invoice_date, i.invoice_number`,
    [organizationId, month],
  );
  return result.rows;
}

function fobUsd(source: FilingSource): number {
  const invoice = source.data;
  return money(Number(source.total_usd) - (invoice.freightUsd || 0) - (invoice.insuranceUsd || 0));
}

function exchangeRate(source: FilingSource): number {
  const rate = Number(source.data.exchangeRateInr);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

export function filingIssues(source: FilingSource, einvoiceRequired: boolean): FilingIssue[] {
  const issues: FilingIssue[] = [];
  const number = source.invoice_number.trim();
  if (!DOCUMENT_NUMBER_PATTERN.test(number)) {
    issues.push({
      code: 'invoice_number_format',
      message: 'GSTR-1 and the e-invoice portal need an invoice number of at most 16 letters, digits, / or -, not starting with 0, / or -.',
    });
  }
  if (!exchangeRate(source)) issues.push({ code: 'exchange_rate', message: 'The invoice has no customs exchange rate, so the rupee value cannot be worked out.' });
  if (!source.shipping_bill_no) {
    issues.push({ code: 'shipping_bill_missing', message: 'No shipping bill number. Table 6A and the IGST refund need it.' });
  } else {
    if (!source.shipping_bill_date) {
      issues.push({ code: 'shipping_bill_date', message: 'No shipping bill date.' });
    } else if (source.shipping_bill_date < source.invoice_date) {
      issues.push({ code: 'shipping_bill_before_invoice', message: 'The shipping bill is dated before the invoice.' });
    }
    if (!/^[A-Z0-9]{6}$/.test(source.port_code)) {
      issues.push({ code: 'port_code', message: 'No six-character port code (for example INBOM4).' });
    }
    if (!source.sb_invoice_number) {
      issues.push({ code: 'sb_invoice_missing', message: 'Enter the invoice number exactly as printed on the shipping bill.' });
    } else if (source.sb_invoice_number.trim().toUpperCase() !== number.toUpperCase()) {
      issues.push({
        code: 'sb_invoice_mismatch',
        message: `The shipping bill shows invoice ${source.sb_invoice_number}, but GSTR-1 will report ${number}. Customs will hold the refund.`,
      });
    }
    if (source.sb_value_usd === null) {
      issues.push({ code: 'sb_value_missing', message: 'Enter the FOB value from the shipping bill.' });
    } else {
      const fob = fobUsd(source);
      const difference = Math.abs(Number(source.sb_value_usd) - fob);
      if (difference > Math.max(1, fob * 0.01)) {
        issues.push({
          code: 'sb_value_mismatch',
          message: `The shipping bill FOB is $${Number(source.sb_value_usd).toFixed(2)} but the invoice FOB is $${fob.toFixed(2)}.`,
        });
      }
    }
  }
  if (source.export_scheme === 'igst') {
    const expected = money(Number(source.total_usd) * DIAMOND_GST_RATE / 100);
    if (Math.abs(Number(source.igst_usd) - expected) > 1) {
      issues.push({
        code: 'igst_amount',
        message: `IGST at ${DIAMOND_GST_RATE}% should be about $${expected.toFixed(2)}, but $${Number(source.igst_usd).toFixed(2)} is recorded.`,
      });
    }
  }
  if (einvoiceRequired && !source.irn) {
    issues.push({ code: 'irn_missing', message: 'No e-invoice IRN recorded. Generate it on the portal and enter it here.' });
  }
  return issues;
}

function gstDate(date: string, separator: '-' | '/'): string {
  const [year, month, day] = date.split('-');
  return [day, month, year].join(separator);
}

function inr(usd: number, rate: number): number {
  return money(usd * rate);
}

export function gstr1Invoice(source: FilingSource) {
  const rate = exchangeRate(source);
  return {
    inum: source.invoice_number,
    idt: gstDate(source.invoice_date, '-'),
    val: inr(Number(source.total_usd), rate),
    sbpcode: source.port_code,
    sbnum: source.shipping_bill_no,
    sbdt: source.shipping_bill_date ? gstDate(source.shipping_bill_date, '-') : '',
    itms: [
      {
        txval: inr(Number(source.total_usd), rate),
        rt: DIAMOND_GST_RATE,
        iamt: source.export_scheme === 'igst' ? inr(Number(source.igst_usd), rate) : 0,
        csamt: 0,
      },
    ],
  };
}

function pinOf(value: string): number | null {
  const digits = value.replace(/\D/g, '');
  return digits.length === 6 ? Number(digits) : null;
}

export function einvoicePayload(source: FilingSource) {
  const invoice = source.data;
  const rate = exchangeRate(source);
  const withIgst = source.export_scheme === 'igst';
  const items = invoice.items.map((item, index) => {
    const amount = inr(item.totalAmount, rate);
    const share = Number(source.total_usd) > 0 ? item.totalAmount / Number(source.total_usd) : 0;
    const igst = withIgst ? inr(Number(source.igst_usd) * share, rate) : 0;
    return {
      SlNo: String(index + 1),
      PrdDesc: item.description.slice(0, 300),
      IsServc: 'N',
      HsnCd: item.hsCode.replace(/\D/g, '').slice(0, 8),
      Qty: Number(item.carats.toFixed(3)),
      Unit: 'OTH',
      UnitPrice: inr(item.ratePerCarat, rate),
      TotAmt: amount,
      AssAmt: amount,
      GstRt: DIAMOND_GST_RATE,
      IgstAmt: igst,
      TotItemVal: money(amount + igst),
    };
  });
  const assessable = money(items.reduce((sum, item) => sum + item.AssAmt, 0));
  const igstTotal = money(items.reduce((sum, item) => sum + item.IgstAmt, 0));
  const otherCharges = inr((invoice.freightUsd || 0) + (invoice.insuranceUsd || 0) + (invoice.otherChargesUsd || 0), rate);
  const country = (invoice.shipment.countryOfDestination || invoice.consignee.country).trim().toUpperCase();
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: withIgst ? 'EXPWP' : 'EXPWOP', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: 'INV', No: source.invoice_number, Dt: gstDate(source.invoice_date, '/') },
    SellerDtls: {
      Gstin: invoice.exporter.gstin,
      LglNm: invoice.exporter.companyName,
      Addr1: invoice.exporter.addressLine1.slice(0, 100),
      Addr2: invoice.exporter.addressLine2.slice(0, 100) || undefined,
      Loc: invoice.exporter.city,
      Pin: pinOf(invoice.exporter.pincode),
      Stcd: invoice.exporter.stateCode,
      Em: invoice.exporter.email || undefined,
    },
    BuyerDtls: {
      Gstin: 'URP',
      LglNm: invoice.consignee.companyName,
      Pos: '96',
      Addr1: invoice.consignee.addressLine1.slice(0, 100),
      Loc: invoice.consignee.city || country,
      Pin: 999999,
      Stcd: '96',
    },
    ItemList: items,
    ValDtls: {
      AssVal: assessable,
      IgstVal: igstTotal,
      OthChrg: otherCharges,
      TotInvVal: money(assessable + igstTotal + otherCharges),
      TotInvValFc: money(Number(source.total_usd)),
    },
    ExpDtls: {
      ShipBNo: source.shipping_bill_no || undefined,
      ShipBDt: source.shipping_bill_date ? gstDate(source.shipping_bill_date, '/') : undefined,
      Port: source.port_code || undefined,
      RefClm: withIgst ? 'Y' : 'N',
      ForCur: 'USD',
      CntCode: COUNTRY_CODES[country] ?? undefined,
    },
  };
}

function organizationIssues(sources: FilingSource[]): FilingIssue[] {
  const gstin = sources[0]?.data.exporter.gstin?.trim() ?? '';
  if (sources.length && !GSTIN_PATTERN.test(gstin)) {
    return [{ code: 'gstin', message: `The company GSTIN "${gstin}" is not a valid 15-character GSTIN.` }];
  }
  return [];
}

export async function filingSummary(pool: DbPool, organizationId: string, month: string) {
  const settings = await taxSettings(pool, organizationId);
  const sources = await filingSources(pool, organizationId, month);
  const rows = sources.map((source) => {
    const issues = filingIssues(source, settings.einvoiceRequired);
    return {
      id: source.id,
      invoiceNumber: source.invoice_number,
      invoiceDate: source.invoice_date,
      exportScheme: source.export_scheme,
      shippingBillNo: source.shipping_bill_no,
      irn: source.irn ?? '',
      issues,
      ready: issues.length === 0,
    };
  });
  return { sources, rows, settings, companyIssues: organizationIssues(sources) };
}

export function registerFilingRoutes(app: Express, pool: DbPool): void {
  app.get('/api/tax/filing-check', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month) ?? currentMonth();
    const { rows, companyIssues, settings } = await filingSummary(pool, currentUser(res).organizationId, month);
    return res.json({
      month,
      einvoiceRequired: settings.einvoiceRequired,
      companyIssues,
      rows,
      readyCount: rows.filter((row) => row.ready).length,
      issueCount: rows.filter((row) => !row.ready).length,
    });
  }));

  app.get('/api/tax/gstr1-6a', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month) ?? currentMonth();
    const { sources, rows } = await filingSummary(pool, currentUser(res).organizationId, month);
    const ready = new Set(rows.filter((row) => row.ready).map((row) => row.id));
    const included = sources.filter((source) => ready.has(source.id));
    const [year, monthNumber] = month.split('-');
    const body = {
      gstin: sources[0]?.data.exporter.gstin ?? '',
      fp: `${monthNumber}${year}`,
      exp: [
        { exp_typ: 'WPAY', inv: included.filter((source) => source.export_scheme === 'igst').map(gstr1Invoice) },
        { exp_typ: 'WOPAY', inv: included.filter((source) => source.export_scheme === 'lut').map(gstr1Invoice) },
      ].filter((group) => group.inv.length > 0),
    };
    res.setHeader('X-Left-Out', String(sources.length - included.length));
    return sendDownload(res, `gstr1-6a-${month}.json`, 'application/json', JSON.stringify(body, null, 2));
  }));

  app.get('/api/tax/einvoice-batch', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month) ?? currentMonth();
    const { sources } = await filingSummary(pool, currentUser(res).organizationId, month);
    const pending = sources.filter((source) => !source.irn && DOCUMENT_NUMBER_PATTERN.test(source.invoice_number.trim()));
    return sendDownload(res, `einvoice-${month}.json`, 'application/json', JSON.stringify(pending.map(einvoicePayload), null, 2));
  }));

  app.get('/api/invoices/:id/einvoice.json', taxReader, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Invoice not found.' });
    const result = await pool.query<FilingSource>(
      `${FILING_SQL} WHERE i.id = $1 AND i.organization_id = $2 AND i.status <> 'draft'`,
      [req.params.id, currentUser(res).organizationId],
    );
    const source = result.rows[0];
    if (!source) return res.status(404).json({ error: 'Issue the invoice before generating its e-invoice.' });
    const safeName = source.invoice_number.replace(/[^\w-]+/g, '-');
    return sendDownload(res, `einvoice-${safeName}.json`, 'application/json', JSON.stringify(einvoicePayload(source), null, 2));
  }));

  app.put('/api/invoices/:id/einvoice', taxWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Invoice not found.' });
    const user = currentUser(res);
    const invoiceDate = await invoiceDateOf(pool, user.organizationId, req.params.id);
    if (invoiceDate === undefined) return res.status(404).json({ error: 'Invoice not found.' });
    const closed = await closedMonthMessage(pool, user.organizationId, invoiceDate);
    if (closed) return res.status(409).json({ error: closed });
    const irn = typeof req.body?.irn === 'string' ? req.body.irn.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(irn)) return res.status(400).json({ error: 'The IRN is the 64-character code the portal returns.' });
    const ackNo = typeof req.body?.ackNo === 'string' ? req.body.ackNo.trim().slice(0, 20) : '';
    if (ackNo && !/^\d{1,20}$/.test(ackNo)) return res.status(400).json({ error: 'The acknowledgement number is digits only.' });
    const ackDate = typeof req.body?.ackDate === 'string' && req.body.ackDate ? req.body.ackDate : null;
    if (ackDate && !/^\d{4}-\d{2}-\d{2}$/.test(ackDate)) return res.status(400).json({ error: 'Enter the acknowledgement date as YYYY-MM-DD.' });
    await pool.query(
      `INSERT INTO invoice_einvoices (invoice_id, organization_id, irn, ack_no, ack_date, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (invoice_id) DO UPDATE SET
         irn = EXCLUDED.irn, ack_no = EXCLUDED.ack_no, ack_date = EXCLUDED.ack_date,
         recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
      [req.params.id, user.organizationId, irn, ackNo, ackDate, user.id],
    );
    return res.json({ irn, ackNo, ackDate: ackDate ?? '' });
  }));
}
