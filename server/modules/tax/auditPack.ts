import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { auditChecks, findingsCsv, summarizeFindings } from './auditChecks.js';
import { forexSummary } from './forex.js';
import { foreignPaymentTotals, foreignPaymentsBetween } from './foreignPayments.js';
import { currentFinancialYear, financialYearDates } from '../../core/formInput.js';
import { asyncHandler, currentUser } from '../../core/http.js';
import { purchaseCsv, purchaseSummary } from './purchases.js';
import { stockCsv, stockRegister } from '../stock/stock.js';
import { csvFile, money, sendZip, taxReader, taxSettings } from './taxShared.js';

function monthsOf(start: string): string[] {
  const [year] = start.split('-').map(Number);
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(year, 3 + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

/**
 * Figures a tax auditor needs for Form 3CD, collected from the books in the app. Each section names the
 * clause it helps with. The auditor still checks and signs; this saves gathering the numbers.
 */
export async function auditPack(pool: DbPool, organizationId: string, year: string) {
  const range = financialYearDates(year);
  if (!range) throw Object.assign(new Error('Financial year should look like 2026-27.'), { status: 400 });
  const { start, end } = range;
  const settings = await taxSettings(pool, organizationId);

  const sales = await pool.query<{
    scheme: string; count: string; usd: string; inr: string; missing_rate: string; cancelled: string; carats: string;
  }>(
    `SELECT COALESCE(t.export_scheme, 'lut') AS scheme,
            COUNT(*) FILTER (WHERE i.status IN ('issued', 'paid')) AS count,
            COALESCE(SUM(i.total_usd) FILTER (WHERE i.status IN ('issued', 'paid')), 0) AS usd,
            COALESCE(SUM(i.total_usd * NULLIF(i.data->>'exchangeRateInr', '')::numeric)
              FILTER (WHERE i.status IN ('issued', 'paid') AND COALESCE(NULLIF(i.data->>'exchangeRateInr', '')::numeric, 0) > 0), 0) AS inr,
            COUNT(*) FILTER (WHERE i.status IN ('issued', 'paid') AND COALESCE(NULLIF(i.data->>'exchangeRateInr', '')::numeric, 0) <= 0) AS missing_rate,
            COUNT(*) FILTER (WHERE i.status = 'cancelled') AS cancelled,
            COALESCE(SUM(i.total_carats) FILTER (WHERE i.status IN ('issued', 'paid')), 0) AS carats
     FROM invoices i LEFT JOIN invoice_tax t ON t.invoice_id = i.id
     WHERE i.organization_id = $1 AND i.status <> 'draft' AND COALESCE(i.invoice_date, i.created_at::date) BETWEEN $2 AND $3
     GROUP BY 1`,
    [organizationId, start, end],
  );
  const scheme = (name: string) => {
    const row = sales.rows.find((entry) => entry.scheme === name);
    return {
      invoices: Number(row?.count ?? 0),
      valueUsd: money(row?.usd ?? 0),
      valueInr: money(row?.inr ?? 0),
      missingRate: Number(row?.missing_rate ?? 0),
      carats: Math.round(Number(row?.carats ?? 0) * 1000) / 1000,
    };
  };
  const lut = scheme('lut');
  const igst = scheme('igst');
  const turnover = {
    lut,
    igst,
    totalUsd: money(lut.valueUsd + igst.valueUsd),
    totalInr: money(lut.valueInr + igst.valueInr),
    missingRate: lut.missingRate + igst.missingRate,
    cancelled: sales.rows.reduce((sum, row) => sum + Number(row.cancelled), 0),
  };

  // Receivables outstanding at the year end, and those past the FEMA realization period at that date.
  const receivables = await pool.query<{
    id: string; invoice_number: string; buyer_name: string; invoice_date: string; shipped_on: string; total_usd: string; paid_usd: string;
    past_deadline: boolean;
  }>(
    `SELECT i.id, i.invoice_number, i.buyer_name, to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
            to_char(COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS shipped_on,
            i.total_usd, COALESCE((SELECT SUM(amount_usd) FROM payments p WHERE p.invoice_id = i.id AND p.paid_on <= $2), 0) AS paid_usd,
            (COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date) + make_interval(months => $3))::date < $2::date AS past_deadline
     FROM invoices i LEFT JOIN invoice_tax t ON t.invoice_id = i.id
     WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND COALESCE(i.invoice_date, i.created_at::date) <= $2
     ORDER BY 5`,
    [organizationId, end, settings.realizationMonths],
  );
  const outstanding = receivables.rows
    .map((row) => ({
      invoiceId: row.id,
      invoiceNumber: row.invoice_number,
      buyerName: row.buyer_name,
      invoiceDate: row.invoice_date,
      shippedOn: row.shipped_on,
      dueUsd: money(Number(row.total_usd) - Number(row.paid_usd)),
      pastRealizationPeriod: row.past_deadline,
    }))
    .filter((row) => row.dueUsd > 0.009);

  const forexMonths = await Promise.all(monthsOf(start).map((month) => forexSummary(pool, organizationId, month)));
  const forex = {
    gainInr: money(forexMonths.reduce((sum, month) => sum + month.totals.gainInr, 0)),
    lossInr: money(forexMonths.reduce((sum, month) => sum + month.totals.lossInr, 0)),
    netInr: money(forexMonths.reduce((sum, month) => sum + month.totals.netInr, 0)),
    paymentsWithoutRate: forexMonths.reduce((sum, month) => sum + month.missingRateCount, 0),
    byMonth: forexMonths.map((month) => ({ month: month.month, netInr: month.totals.netInr, missing: month.missingRateCount })),
  };

  const [purchases, stock, foreignPayments, findings] = await Promise.all([
    purchaseSummary(pool, organizationId, start, end),
    stockRegister(pool, organizationId, year),
    foreignPaymentsBetween(pool, organizationId, start, end),
    auditChecks(pool, organizationId, start, end),
  ]);
  const relatedForeign = foreignPayments.filter((payment) => payment.relatedParty);

  return {
    year,
    start,
    end,
    turnover,
    receivables: {
      rows: outstanding,
      totalUsd: money(outstanding.reduce((sum, row) => sum + row.dueUsd, 0)),
      pastRealizationUsd: money(outstanding.filter((row) => row.pastRealizationPeriod).reduce((sum, row) => sum + row.dueUsd, 0)),
      realizationMonths: settings.realizationMonths,
    },
    forex,
    purchases: {
      imports: purchases.imports,
      registered: purchases.registered,
      unregistered: purchases.unregistered,
      total: purchases.total,
    },
    stock: {
      rough: stock.rough,
      polished: stock.polished,
      yieldPercent: stock.yieldPercent,
      processLossCarats: stock.processLossCarats,
      negativeParcels: stock.negativeParcels,
    },
    tds: foreignPaymentTotals(foreignPayments),
    relatedParty: {
      purchases: purchases.relatedParty,
      foreignPayments: { count: relatedForeign.length, amountInr: money(relatedForeign.reduce((sum, payment) => sum + payment.amountInr, 0)) },
    },
    checks: summarizeFindings(findings),
    _detail: { purchases: purchases.purchases, stock, foreignPayments, findings },
  };
}

/** One row per figure, with the Form 3CD clause it supports. */
export function auditPackSummaryRows(pack: Awaited<ReturnType<typeof auditPack>>): unknown[][] {
  const ct = (value: number) => value.toFixed(3);
  return [
    ['Turnover', 'Exports under LUT (zero rated)', `${pack.turnover.lut.invoices} invoices`, pack.turnover.lut.valueUsd.toFixed(2), pack.turnover.lut.valueInr.toFixed(2)],
    ['Turnover', 'Exports with IGST paid', `${pack.turnover.igst.invoices} invoices`, pack.turnover.igst.valueUsd.toFixed(2), pack.turnover.igst.valueInr.toFixed(2)],
    ['Turnover', 'Invoices with no exchange rate (INR not counted)', String(pack.turnover.missingRate), '', ''],
    ['Turnover', 'Cancelled invoices', String(pack.turnover.cancelled), '', ''],
    ['Clause 35', 'Rough: opening / purchased / used in manufacture / sold / closing (ct)',
      [pack.stock.rough.opening, pack.stock.rough.purchased, pack.stock.rough.consumed, pack.stock.rough.sold, pack.stock.rough.closing].map(ct).join(' / '), '', pack.stock.rough.closingValueInr.toFixed(2)],
    ['Clause 35', 'Polished: opening / purchased / produced / sold / closing (ct)',
      [pack.stock.polished.opening, pack.stock.polished.purchased, pack.stock.polished.produced, pack.stock.polished.sold, pack.stock.polished.closing].map(ct).join(' / '), '', pack.stock.polished.closingValueInr.toFixed(2)],
    ['Clause 35', 'Yield from rough to polished', pack.stock.yieldPercent === null ? 'No manufacturing recorded' : `${pack.stock.yieldPercent}%`, '', ''],
    ['Clause 35', 'Process loss (ct)', ct(pack.stock.processLossCarats), '', ''],
    ['Clause 44', 'Imports (Bill of Entry)', `${pack.purchases.imports.count} entries`, '', pack.purchases.imports.taxableInr.toFixed(2)],
    ['Clause 44', 'Purchases from GST-registered suppliers', `${pack.purchases.registered.count} invoices`, '', pack.purchases.registered.taxableInr.toFixed(2)],
    ['Clause 44', 'Purchases from unregistered suppliers', `${pack.purchases.unregistered.count} invoices`, '', pack.purchases.unregistered.taxableInr.toFixed(2)],
    ['Clause 44', 'GST paid on purchases', '', '', pack.purchases.total.taxInr.toFixed(2)],
    ['Clause 34', 'Payments outside India / TDS deducted', `${pack.tds.count} payments`, '', `${pack.tds.amountInr.toFixed(2)} / ${pack.tds.tdsInr.toFixed(2)}`],
    ['Clause 34 / 21', 'Taxable foreign payments with no TDS (possible disallowance u/s 40(a)(i))', `${pack.tds.withoutTds} payments`, '', pack.tds.withoutTdsInr.toFixed(2)],
    ['Clause 34', 'Form 15CA / 15CB not recorded', `${pack.tds.missing15ca} / ${pack.tds.missing15cb}`, '', ''],
    ['Clause 23', 'Purchases from related parties', `${pack.relatedParty.purchases.count} invoices`, '', pack.relatedParty.purchases.taxableInr.toFixed(2)],
    ['Clause 23', 'Payments abroad to related parties', `${pack.relatedParty.foreignPayments.count} payments`, '', pack.relatedParty.foreignPayments.amountInr.toFixed(2)],
    ['Forex', 'Exchange gain / loss / net on realization', '', '', `${pack.forex.gainInr.toFixed(2)} / ${pack.forex.lossInr.toFixed(2)} / ${pack.forex.netInr.toFixed(2)}`],
    ['Forex', 'Receipts without a bank rate (not counted)', String(pack.forex.paymentsWithoutRate), '', ''],
    ['FEMA', `Receivables at year end / past the ${pack.receivables.realizationMonths}-month realization period (USD)`, '', `${pack.receivables.totalUsd.toFixed(2)} / ${pack.receivables.pastRealizationUsd.toFixed(2)}`, ''],
    ['Checks', 'Audit check findings (high / medium / low)', `${pack.checks.high} / ${pack.checks.medium} / ${pack.checks.low}`, '', ''],
  ];
}

export function registerAuditPackRoutes(app: Express, pool: DbPool): void {
  app.get('/api/tax/audit-pack', taxReader, asyncHandler(async (req, res) => {
    const year = typeof req.query.year === 'string' && req.query.year ? req.query.year : currentFinancialYear();
    const { _detail, ...pack } = await auditPack(pool, currentUser(res).organizationId, year);
    return res.json({ ...pack, summary: auditPackSummaryRows({ ...pack, _detail }) });
  }));

  app.get('/api/tax/audit-pack/zip', taxReader, asyncHandler(async (req, res) => {
    const year = typeof req.query.year === 'string' && req.query.year ? req.query.year : currentFinancialYear();
    const pack = await auditPack(pool, currentUser(res).organizationId, year);
    const header = ['Area / clause', 'Item', 'Count or quantity', 'USD', 'INR'];
    return sendZip(res, `tax-audit-pack-${year}.zip`, [
      { name: 'summary.csv', data: csvFile(header, auditPackSummaryRows(pack)) },
      { name: 'stock-register-clause-35.csv', data: stockCsv(pack._detail.stock) },
      { name: 'purchase-register.csv', data: purchaseCsv(pack._detail.purchases) },
      {
        name: 'foreign-payments-tds.csv',
        data: csvFile(
          ['Paid on', 'Payee', 'Country', 'Nature', 'Amount INR', 'TDS INR', 'Form 15CA part', '15CA ack', '15CB no', 'Related party', 'Issues'],
          pack._detail.foreignPayments.map((payment) => [
            payment.paidOn, payment.payeeName, payment.payeeCountry, payment.nature, payment.amountInr.toFixed(2), payment.tdsInr.toFixed(2),
            payment.form15caPart, payment.form15caAck, payment.form15cbNo, payment.relatedParty ? 'Yes' : 'No',
            payment.issues.map((issue) => issue.text).join('; '),
          ]),
        ),
      },
      {
        name: 'receivables-at-year-end.csv',
        data: csvFile(
          ['Invoice', 'Buyer', 'Invoice date', 'Shipped on', 'Due USD', 'Past realization period'],
          pack.receivables.rows.map((row) => [row.invoiceNumber, row.buyerName, row.invoiceDate, row.shippedOn, row.dueUsd.toFixed(2), row.pastRealizationPeriod ? 'Yes' : 'No']),
        ),
      },
      {
        name: 'forex-by-month.csv',
        data: csvFile(['Month', 'Net gain (loss) INR', 'Receipts without bank rate'], pack.forex.byMonth.map((month) => [month.month, month.netInr.toFixed(2), month.missing])),
      },
      { name: 'audit-checks.csv', data: findingsCsv(pack._detail.findings) },
    ]);
  }));
}
