import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { asyncHandler, currentUser, isUuid, requireAdmin, requireUser } from '../../core/http.js';
import { money } from '../tax/taxShared.js';

export type RiskGrade = 'A' | 'B' | 'C' | 'D' | 'new';

export const GRADE_LABELS: Record<RiskGrade, string> = {
  A: 'Pays on time',
  B: 'Sometimes late',
  C: 'Often late',
  D: 'High risk',
  new: 'No payment history',
};

export type BuyerHistory = {
  invoices: number;
  paidInvoices: number;
  outstandingUsd: number;
  overdueUsd: number;
  maxDaysOverdue: number;
  avgDaysLate: number | null;
  onTimePercent: number | null;
};

/** Grades a buyer from how they have paid so far. */
export function riskGrade(history: BuyerHistory): RiskGrade {
  if (history.invoices === 0) return 'new';
  if (history.maxDaysOverdue > 90 || (history.overdueUsd > 0 && history.overdueUsd >= history.outstandingUsd * 0.5 && history.maxDaysOverdue > 60)) return 'D';
  if (history.maxDaysOverdue > 30 || (history.avgDaysLate ?? 0) > 30) return 'C';
  if (history.overdueUsd > 0 || (history.avgDaysLate ?? 0) > 7 || (history.onTimePercent !== null && history.onTimePercent < 80)) return 'B';
  if (history.paidInvoices === 0) return 'new';
  return 'A';
}

export async function buyerRisk(pool: DbPool, organizationId: string, buyerName?: string) {
  const result = await pool.query<{
    buyer_key: string; buyer_name: string; invoices: string; paid_invoices: string; total_usd: string; outstanding_usd: string;
    overdue_usd: string; max_days_overdue: string | null; late_weighted: string | null; paid_value: string; on_time: string;
    credit_limit_usd: string | null; buyer_id: string | null; last_invoice: string | null;
  }>(
    `WITH inv AS (
       SELECT i.id, LOWER(TRIM(i.buyer_name)) AS buyer_key, i.buyer_name, i.status, i.total_usd,
              COALESCE(i.invoice_date, i.created_at::date) AS invoice_date,
              COALESCE(i.invoice_date, i.created_at::date) + i.credit_days AS due_date,
              COALESCE(p.paid, 0) AS paid, p.last_paid
       FROM invoices i
       LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid, MAX(paid_on) AS last_paid FROM payments WHERE invoice_id = i.id) p ON true
       WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND TRIM(i.buyer_name) <> ''
         AND ($2::text IS NULL OR LOWER(TRIM(i.buyer_name)) = LOWER(TRIM($2)))
     )
     SELECT inv.buyer_key, MIN(inv.buyer_name) AS buyer_name, COUNT(*) AS invoices,
            COUNT(*) FILTER (WHERE inv.status = 'paid') AS paid_invoices,
            SUM(inv.total_usd) AS total_usd,
            SUM(GREATEST(inv.total_usd - inv.paid, 0)) FILTER (WHERE inv.status = 'issued') AS outstanding_usd,
            COALESCE(SUM(GREATEST(inv.total_usd - inv.paid, 0)) FILTER (WHERE inv.status = 'issued' AND inv.due_date < current_date), 0) AS overdue_usd,
            MAX(current_date - inv.due_date) FILTER (WHERE inv.status = 'issued' AND inv.due_date < current_date AND inv.total_usd > inv.paid) AS max_days_overdue,
            SUM(GREATEST(inv.last_paid - inv.due_date, 0) * inv.total_usd) FILTER (WHERE inv.status = 'paid') AS late_weighted,
            COALESCE(SUM(inv.total_usd) FILTER (WHERE inv.status = 'paid'), 0) AS paid_value,
            COUNT(*) FILTER (WHERE inv.status = 'paid' AND inv.last_paid <= inv.due_date) AS on_time,
            MAX(to_char(inv.invoice_date, 'YYYY-MM-DD')) AS last_invoice,
            (SELECT b.credit_limit_usd FROM buyers b WHERE b.organization_id = $1 AND LOWER(TRIM(b.name)) = inv.buyer_key LIMIT 1) AS credit_limit_usd,
            (SELECT b.id FROM buyers b WHERE b.organization_id = $1 AND LOWER(TRIM(b.name)) = inv.buyer_key LIMIT 1) AS buyer_id
     FROM inv GROUP BY inv.buyer_key
     ORDER BY overdue_usd DESC, outstanding_usd DESC NULLS LAST, buyer_name`,
    [organizationId, buyerName ?? null],
  );
  return result.rows.map((row) => {
    const paidInvoices = Number(row.paid_invoices);
    const paidValue = Number(row.paid_value);
    const history: BuyerHistory = {
      invoices: Number(row.invoices),
      paidInvoices,
      outstandingUsd: money(row.outstanding_usd ?? 0),
      overdueUsd: money(row.overdue_usd),
      maxDaysOverdue: Number(row.max_days_overdue ?? 0),
      avgDaysLate: paidValue > 0 ? Math.round(Number(row.late_weighted ?? 0) / paidValue) : null,
      onTimePercent: paidInvoices > 0 ? Math.round((Number(row.on_time) / paidInvoices) * 100) : null,
    };
    const grade = riskGrade(history);
    const creditLimitUsd = row.credit_limit_usd === null ? null : money(row.credit_limit_usd);
    return {
      buyerName: row.buyer_name,
      buyerId: row.buyer_id,
      ...history,
      totalUsd: money(row.total_usd),
      lastInvoice: row.last_invoice,
      creditLimitUsd,
      headroomUsd: creditLimitUsd === null ? null : money(creditLimitUsd - history.outstandingUsd),
      grade,
      gradeLabel: GRADE_LABELS[grade],
    };
  });
}

export type BuyerRiskRow = Awaited<ReturnType<typeof buyerRisk>>[number];

/** Warnings to show before a new invoice for this buyer is issued. Nothing is blocked. */
export async function shipmentWarnings(pool: DbPool, organizationId: string, buyerName: string, amountUsd: number) {
  const [row] = await buyerRisk(pool, organizationId, buyerName);
  const limit = await pool.query<{ credit_limit_usd: string | null }>(
    'SELECT credit_limit_usd FROM buyers WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2)) LIMIT 1',
    [organizationId, buyerName],
  );
  const creditLimitUsd = row?.creditLimitUsd ?? (limit.rows[0]?.credit_limit_usd == null ? null : money(limit.rows[0].credit_limit_usd));
  const warnings: string[] = [];
  if (row && row.overdueUsd > 0) {
    warnings.push(`${row.buyerName} already owes USD ${row.overdueUsd.toFixed(2)} past the due date (oldest ${row.maxDaysOverdue} days late).`);
  }
  if (row && (row.grade === 'C' || row.grade === 'D')) {
    warnings.push(`Payment record: ${row.gradeLabel.toLowerCase()}${row.avgDaysLate ? `, paying on average ${row.avgDaysLate} days after the due date` : ''}.`);
  }
  const outstanding = row?.outstandingUsd ?? 0;
  if (creditLimitUsd !== null && outstanding + amountUsd > creditLimitUsd + 0.005) {
    warnings.push(`This invoice takes the balance to USD ${money(outstanding + amountUsd).toFixed(2)}, over the credit limit of USD ${creditLimitUsd.toFixed(2)}.`);
  }
  return { grade: row?.grade ?? 'new', gradeLabel: GRADE_LABELS[row?.grade ?? 'new'], outstandingUsd: outstanding, creditLimitUsd, warnings };
}

export function registerBuyerRiskRoutes(app: Express, pool: DbPool): void {
  app.get('/api/buyers/risk', requireUser, asyncHandler(async (_req, res) => {
    return res.json({ buyers: await buyerRisk(pool, currentUser(res).organizationId), labels: GRADE_LABELS });
  }));

  app.get('/api/buyers/risk/check', requireUser, asyncHandler(async (req, res) => {
    const buyer = typeof req.query.buyer === 'string' ? req.query.buyer.trim().slice(0, 200) : '';
    if (!buyer) return res.status(400).json({ error: 'Name the buyer.' });
    const amountUsd = Math.max(0, Number(req.query.amountUsd) || 0);
    return res.json(await shipmentWarnings(pool, currentUser(res).organizationId, buyer, amountUsd));
  }));

  app.put('/api/buyers/:id/credit-limit', requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Buyer not found.' });
    const raw = req.body?.creditLimitUsd;
    const limit = raw === null || raw === '' || raw === undefined ? null : Math.round(Number(raw) * 100) / 100;
    if (limit !== null && (!Number.isFinite(limit) || limit < 0)) return res.status(400).json({ error: 'The credit limit must be zero or more dollars.' });
    const updated = await pool.query('UPDATE buyers SET credit_limit_usd = $3, updated_at = now() WHERE id = $1 AND organization_id = $2', [
      req.params.id,
      currentUser(res).organizationId,
      limit,
    ]);
    if (!updated.rowCount) return res.status(404).json({ error: 'Buyer not found.' });
    return res.json({ creditLimitUsd: limit });
  }));
}
