import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { monthRange } from './exportReports.js';
import { foreignPaymentsBetween } from './foreignPayments.js';
import { asyncHandler, currentUser } from '../../core/http.js';
import { csvFile, money, taxReader } from './taxShared.js';

export type Severity = 'high' | 'medium' | 'low';

export type AuditFinding = {
  id: string;
  check: string;
  severity: Severity;
  title: string;
  detail: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
};

export const CHECK_LABELS: Record<string, string> = {
  numbering_gap: 'Gap in invoice numbers',
  numbering_duplicate: 'Same invoice number twice',
  edited_while_reopened: 'Changed while a closed month was reopened',
  rate_outlier: 'Rate per carat far from normal',
  payment_unmatched: 'Payment with no bank credit',
  overpaid: 'Received more than the invoice total',
  payment_before_invoice: 'Payment dated before the invoice',
  round_amount: 'Round-figure amount',
  sunday_invoice: 'Invoice dated on a Sunday',
  no_shipping_bill: 'Issued over 30 days ago with no shipping bill',
  foreign_no_tds: 'Foreign payment without TDS',
  foreign_no_15ca: 'Foreign payment without Form 15CA',
};

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const MAX_GAPS_LISTED = 25;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Splits EXP/2026-27/0012 into its series (EXP/2026-27/) and number (12). */
export function invoiceSeries(invoiceNumber: string): { prefix: string; series: string; number: number; width: number } | null {
  const match = /^(.*?)(\d+)$/.exec(invoiceNumber.trim());
  if (!match) return null;
  return { prefix: match[1], series: match[1].toUpperCase(), number: Number(match[2]), width: match[2].length };
}

/** Finds missing numbers in each invoice series. Drafts hold numbers too, so they count as used. */
export function numberingGaps(numbers: string[]): Array<{ series: string; missing: string[] }> {
  const bySeries = new Map<string, { numbers: Set<number>; width: number; prefix: string }>();
  for (const invoiceNumber of numbers) {
    const parsed = invoiceSeries(invoiceNumber);
    if (!parsed) continue;
    const entry = bySeries.get(parsed.series) ?? { numbers: new Set<number>(), width: parsed.width, prefix: parsed.prefix };
    entry.numbers.add(parsed.number);
    bySeries.set(parsed.series, entry);
  }
  const gaps: Array<{ series: string; missing: string[] }> = [];
  for (const [series, entry] of bySeries) {
    if (entry.numbers.size < 2) continue;
    const sorted = [...entry.numbers].sort((a, b) => a - b);
    const missing: string[] = [];
    for (let n = sorted[0] + 1; n < sorted[sorted.length - 1]; n += 1) {
      if (!entry.numbers.has(n)) missing.push(`${entry.prefix}${String(n).padStart(entry.width, '0')}`);
    }
    if (missing.length) gaps.push({ series, missing });
  }
  return gaps;
}

/** Checks a tax auditor would otherwise sample by hand, over invoices dated between start and end. */
export async function auditChecks(pool: DbPool, organizationId: string, start: string, end: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const add = (finding: Omit<AuditFinding, 'title'> & { title?: string }) =>
    findings.push({ ...finding, title: finding.title ?? CHECK_LABELS[finding.check] ?? finding.check });
  const INVOICE_DATE = 'COALESCE(i.invoice_date, i.created_at::date)';

  const invoices = await pool.query<{
    id: string; invoice_number: string; status: string; invoice_date: string; total_usd: string; dow: number;
    shipping_bill_no: string | null; items: Array<Record<string, unknown>> | null; paid_usd: string; first_paid: string | null;
  }>(
    `SELECT i.id, i.invoice_number, i.status, to_char(${INVOICE_DATE}, 'YYYY-MM-DD') AS invoice_date, i.total_usd,
            EXTRACT(DOW FROM ${INVOICE_DATE})::int AS dow, t.shipping_bill_no, i.data->'items' AS items,
            COALESCE((SELECT SUM(amount_usd) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_usd,
            (SELECT to_char(MIN(paid_on), 'YYYY-MM-DD') FROM payments p WHERE p.invoice_id = i.id) AS first_paid
     FROM invoices i LEFT JOIN invoice_tax t ON t.invoice_id = i.id
     WHERE i.organization_id = $1 AND ${INVOICE_DATE} BETWEEN $2 AND $3
     ORDER BY ${INVOICE_DATE}, i.invoice_number`,
    [organizationId, start, end],
  );

  // Numbering: every number in a series between the lowest and highest should exist.
  for (const gap of numberingGaps(invoices.rows.map((row) => row.invoice_number))) {
    const listed = gap.missing.slice(0, MAX_GAPS_LISTED).join(', ');
    add({
      id: `numbering_gap:${gap.series}`,
      check: 'numbering_gap',
      severity: 'high',
      detail: `${gap.missing.length} number${gap.missing.length === 1 ? '' : 's'} missing in ${gap.series}…: ${listed}${gap.missing.length > MAX_GAPS_LISTED ? ', …' : ''}. Keep a note of why (deleted draft, typing error) for the auditor.`,
      invoiceId: null,
      invoiceNumber: null,
    });
  }
  const seen = new Map<string, string[]>();
  for (const row of invoices.rows) {
    const normalized = row.invoice_number.trim().toUpperCase();
    seen.set(normalized, [...(seen.get(normalized) ?? []), row.invoice_number]);
  }
  for (const [normalized, list] of seen) {
    if (list.length > 1) {
      add({ id: `numbering_duplicate:${normalized}`, check: 'numbering_duplicate', severity: 'high', detail: `${list.join(' and ')} differ only in capitals or spaces.`, invoiceId: null, invoiceNumber: list[0] });
    }
  }

  const issued = invoices.rows.filter((row) => row.status === 'issued' || row.status === 'paid');
  const today = new Date().toISOString().slice(0, 10);
  for (const row of issued) {
    const totalUsd = money(row.total_usd);
    const paidUsd = money(row.paid_usd);
    const base = { invoiceId: row.id, invoiceNumber: row.invoice_number };
    if (paidUsd > totalUsd + 0.01) {
      add({ ...base, id: `overpaid:${row.id}`, check: 'overpaid', severity: 'medium', detail: `Received USD ${paidUsd.toFixed(2)} against a total of USD ${totalUsd.toFixed(2)}. Refund, adjust against another invoice, or record it as an advance.` });
    }
    if (row.first_paid && row.first_paid < row.invoice_date) {
      add({ ...base, id: `payment_before_invoice:${row.id}`, check: 'payment_before_invoice', severity: 'low', detail: `First payment on ${row.first_paid}, invoice dated ${row.invoice_date}. Fine for an advance; keep the bank advice (FIRC) on file.` });
    }
    if (totalUsd >= 5000 && totalUsd % 1000 === 0) {
      add({ ...base, id: `round_amount:${row.id}`, check: 'round_amount', severity: 'low', detail: `Invoice total is exactly USD ${totalUsd.toFixed(2)}.` });
    }
    if (row.dow === 0) {
      add({ ...base, id: `sunday_invoice:${row.id}`, check: 'sunday_invoice', severity: 'low', detail: `Dated ${row.invoice_date}, a Sunday. Check the date against the shipping bill and airway bill.` });
    }
    const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.invoice_date}T00:00:00Z`)) / 86_400_000;
    if (!row.shipping_bill_no && ageDays > 30) {
      add({ ...base, id: `no_shipping_bill:${row.id}`, check: 'no_shipping_bill', severity: 'medium', detail: `Issued ${row.invoice_date} and no shipping bill number recorded. Without it the export cannot be shown in GSTR-1 table 6A.` });
    }
  }

  // Rate per carat: compare each line with lines of the same HS code and shape.
  const groups = new Map<string, Array<{ rate: number; invoiceId: string; invoiceNumber: string; line: number; description: string }>>();
  for (const row of issued) {
    (row.items ?? []).forEach((item, index) => {
      const rate = Number(item.ratePerCarat);
      if (!(rate > 0)) return;
      const groupKey = `${String(item.hsCode ?? '').replace(/\D/g, '')}|${String(item.shape ?? '').trim().toLowerCase()}`;
      groups.set(groupKey, [
        ...(groups.get(groupKey) ?? []),
        { rate, invoiceId: row.id, invoiceNumber: row.invoice_number, line: Number(item.srNo) || index + 1, description: String(item.description ?? '') },
      ]);
    });
  }
  for (const [groupKey, lines] of groups) {
    if (lines.length < 5) continue;
    const middle = median(lines.map((line) => line.rate));
    for (const line of lines) {
      if (line.rate > middle * 3 || line.rate < middle / 3) {
        add({
          id: `rate_outlier:${line.invoiceId}:${line.line}`,
          check: 'rate_outlier',
          severity: 'medium',
          detail: `Line ${line.line} (${line.description || groupKey}) at USD ${line.rate.toFixed(2)}/ct; similar lines are around USD ${middle.toFixed(2)}/ct. Keep the reason (quality, size) for valuation queries.`,
          invoiceId: line.invoiceId,
          invoiceNumber: line.invoiceNumber,
        });
      }
    }
  }

  // Payments with no bank credit, once a statement covering that date has been imported.
  const payments = await pool.query<{ id: string; invoice_id: string; invoice_number: string; paid_on: string; amount_usd: string; covered: boolean; matched: boolean }>(
    `SELECT p.id, p.invoice_id, i.invoice_number, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd,
            EXISTS (SELECT 1 FROM bank_lines b WHERE b.organization_id = p.organization_id
                      AND b.line_date BETWEEN p.paid_on - 15 AND p.paid_on + 15) AS covered,
            EXISTS (SELECT 1 FROM bank_lines b WHERE b.payment_id = p.id) AS matched
     FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE p.organization_id = $1 AND p.paid_on BETWEEN $2 AND $3`,
    [organizationId, start, end],
  );
  for (const payment of payments.rows) {
    if (!payment.matched && payment.covered) {
      add({
        id: `payment_unmatched:${payment.id}`,
        check: 'payment_unmatched',
        severity: 'medium',
        detail: `USD ${money(payment.amount_usd).toFixed(2)} recorded on ${payment.paid_on} is not matched to any imported bank credit.`,
        invoiceId: payment.invoice_id,
        invoiceNumber: payment.invoice_number,
      });
    }
  }

  // Changes made while a closed month was open again.
  const reopened = await pool.query<{ id: string; entity_id: string; invoice_number: string; summary: string; user_email: string; created_at: Date; month: string }>(
    `SELECT e.id, e.entity_id, i.invoice_number, e.summary, e.user_email, e.created_at, to_char(${INVOICE_DATE}, 'YYYY-MM') AS month
     FROM audit_events e
     JOIN invoices i ON i.id::text = e.entity_id AND i.organization_id = e.organization_id
     WHERE e.organization_id = $1 AND e.entity_type = 'invoice' AND ${INVOICE_DATE} BETWEEN $2 AND $3
       AND (SELECT m.action FROM audit_events m
            WHERE m.organization_id = e.organization_id AND m.entity_type = 'month'
              AND m.entity_id = to_char(${INVOICE_DATE}, 'YYYY-MM') AND m.created_at < e.created_at
            ORDER BY m.created_at DESC LIMIT 1) = 'month.open'
     ORDER BY e.created_at`,
    [organizationId, start, end],
  );
  for (const event of reopened.rows) {
    add({
      id: `edited_while_reopened:${event.id}`,
      check: 'edited_while_reopened',
      severity: 'high',
      detail: `${event.summary} by ${event.user_email || 'someone'} on ${event.created_at.toISOString().slice(0, 10)}, after ${event.month} had been closed and reopened.`,
      invoiceId: event.entity_id,
      invoiceNumber: event.invoice_number,
    });
  }

  for (const payment of await foreignPaymentsBetween(pool, organizationId, start, end)) {
    if (payment.taxableInIndia && payment.tdsInr === 0) {
      add({ id: `foreign_no_tds:${payment.id}`, check: 'foreign_no_tds', severity: 'high', detail: `₹${payment.amountInr.toFixed(2)} to ${payment.payeeName} on ${payment.paidOn} (${payment.nature}) with no TDS.`, invoiceId: null, invoiceNumber: null });
    }
    if (!payment.form15caAck) {
      add({ id: `foreign_no_15ca:${payment.id}`, check: 'foreign_no_15ca', severity: 'medium', detail: `${payment.payeeName}, ${payment.paidOn}: no Form 15CA acknowledgement recorded.`, invoiceId: null, invoiceNumber: null });
    }
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.check.localeCompare(b.check));
}

export function summarizeFindings(findings: AuditFinding[]) {
  const byCheck: Record<string, number> = {};
  for (const finding of findings) byCheck[finding.check] = (byCheck[finding.check] ?? 0) + 1;
  return {
    high: findings.filter((finding) => finding.severity === 'high').length,
    medium: findings.filter((finding) => finding.severity === 'medium').length,
    low: findings.filter((finding) => finding.severity === 'low').length,
    byCheck,
  };
}

export function findingsCsv(findings: AuditFinding[]): Buffer {
  return csvFile(
    ['Severity', 'Check', 'Invoice', 'Detail'],
    findings.map((finding) => [finding.severity, finding.title, finding.invoiceNumber ?? '', finding.detail]),
  );
}

export function registerAuditCheckRoutes(app: Express, pool: DbPool): void {
  app.get('/api/tax/audit-checks', taxReader, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    const findings = await auditChecks(pool, currentUser(res).organizationId, range.start, range.end);
    return res.json({ from: range.from, to: range.to, findings, summary: summarizeFindings(findings), labels: CHECK_LABELS });
  }));

  app.get('/api/tax/audit-checks/csv', taxReader, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    const findings = await auditChecks(pool, currentUser(res).organizationId, range.start, range.end);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-checks-${range.from}-to-${range.to}.csv"`);
    return res.send(findingsCsv(findings));
  }));
}
