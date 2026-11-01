import type { Express } from 'express';
import type { DbPool } from './db.js';
import { asyncHandler, currentUser, requireUser } from './http.js';

const EFFECTIVE_DATE = 'COALESCE(i.invoice_date, i.created_at::date)';
const DUE_DATE = `(${EFFECTIVE_DATE} + i.credit_days)`;
const PAID = 'COALESCE(p.paid, 0)';
const BALANCE = `(i.total_usd - ${PAID})`;
const OPEN_FROM = `
  FROM invoices i
  LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid FROM payments WHERE invoice_id = i.id) p ON true
  WHERE i.organization_id = $1 AND i.status = 'issued' AND ${BALANCE} > 0`;

const money = (value: number) => Math.round(value * 100) / 100;

export function registerDashboardRoutes(app: Express, pool: DbPool): void {
  app.get('/api/dashboard', requireUser, asyncHandler(async (_req, res) => {
    const organizationId = currentUser(res).organizationId;

    const [month, collected, countries, months, aging, buyers, attention, openTotals, statuses] = await Promise.all([
      pool.query<{ count: string; total_usd: string; total_carats: string }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total_usd), 0) AS total_usd, COALESCE(SUM(total_carats), 0) AS total_carats
         FROM invoices i
         WHERE organization_id = $1 AND status IN ('issued', 'paid')
           AND ${EFFECTIVE_DATE} >= date_trunc('month', current_date)`,
        [organizationId],
      ),
      pool.query<{ count: string; total_usd: string }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount_usd), 0) AS total_usd
         FROM payments
         WHERE organization_id = $1 AND paid_on >= date_trunc('month', current_date)`,
        [organizationId],
      ),
      pool.query<{ country: string; count: string; total_usd: string }>(
        `SELECT COALESCE(NULLIF(destination_country, ''), 'Not set') AS country,
                COUNT(*) AS count, SUM(total_usd) AS total_usd
         FROM invoices i
         WHERE organization_id = $1 AND status IN ('issued', 'paid')
         GROUP BY 1 ORDER BY SUM(total_usd) DESC LIMIT 8`,
        [organizationId],
      ),
      pool.query<{ month: string; label: string; count: string; total_usd: string }>(
        `SELECT to_char(span.month, 'YYYY-MM') AS month, to_char(span.month, 'Mon') AS label,
                COUNT(i.id) AS count, COALESCE(SUM(i.total_usd), 0) AS total_usd
         FROM generate_series(
           date_trunc('month', current_date) - interval '5 months',
           date_trunc('month', current_date),
           interval '1 month'
         ) AS span(month)
         LEFT JOIN invoices i
           ON i.organization_id = $1 AND i.status IN ('issued', 'paid')
          AND date_trunc('month', ${EFFECTIVE_DATE}) = span.month
         GROUP BY span.month
         ORDER BY span.month`,
        [organizationId],
      ),
      pool.query<{ bucket: string; count: string; due_usd: string }>(
        `SELECT CASE
                  WHEN ${DUE_DATE} >= current_date THEN 'current'
                  WHEN current_date - ${DUE_DATE} <= 30 THEN '1-30'
                  WHEN current_date - ${DUE_DATE} <= 60 THEN '31-60'
                  WHEN current_date - ${DUE_DATE} <= 90 THEN '61-90'
                  ELSE '90+'
                END AS bucket,
                COUNT(*) AS count, SUM(${BALANCE}) AS due_usd
         ${OPEN_FROM}
         GROUP BY 1`,
        [organizationId],
      ),
      pool.query<{ buyer_name: string; invoices: string; due_usd: string; overdue_usd: string }>(
        `SELECT i.buyer_name, COUNT(*) AS invoices, SUM(${BALANCE}) AS due_usd,
                SUM(CASE WHEN ${DUE_DATE} < current_date THEN ${BALANCE} ELSE 0 END) AS overdue_usd
         ${OPEN_FROM}
         GROUP BY i.buyer_name
         ORDER BY due_usd DESC
         LIMIT 6`,
        [organizationId],
      ),
      pool.query<{
        id: string; invoice_number: string; buyer_name: string; invoice_date: string | null; due_date: string;
        days_overdue: number; overdue: boolean; total_usd: string; paid_usd: string;
      }>(
        `SELECT i.id, i.invoice_number, i.buyer_name, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
                to_char(${DUE_DATE}, 'YYYY-MM-DD') AS due_date,
                GREATEST(current_date - ${DUE_DATE}, 0) AS days_overdue,
                ${DUE_DATE} < current_date AS overdue,
                i.total_usd, ${PAID} AS paid_usd
         ${OPEN_FROM}
         ORDER BY overdue DESC, days_overdue DESC, ${BALANCE} DESC
         LIMIT 8`,
        [organizationId],
      ),
      pool.query<{ count: string; due_usd: string }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(${BALANCE}), 0) AS due_usd ${OPEN_FROM}`,
        [organizationId],
      ),
      pool.query<{ status: string; count: string }>(
        'SELECT status, COUNT(*) AS count FROM invoices WHERE organization_id = $1 GROUP BY status',
        [organizationId],
      ),
    ]);

    const agingOrder = [
      ['current', 'Not yet due'],
      ['1-30', '1–30 days'],
      ['31-60', '31–60 days'],
      ['61-90', '61–90 days'],
      ['90+', 'Over 90 days'],
    ] as const;
    const agingByKey = new Map(aging.rows.map((row) => [row.bucket, row]));
    const statusCounts = { draft: 0, issued: 0, paid: 0, cancelled: 0 } as Record<string, number>;
    for (const row of statuses.rows) statusCounts[row.status] = Number(row.count);

    return res.json({
      thisMonth: {
        count: Number(month.rows[0].count),
        totalUsd: Number(month.rows[0].total_usd),
        totalCarats: Number(month.rows[0].total_carats),
      },
      collectedThisMonth: {
        count: Number(collected.rows[0].count),
        totalUsd: Number(collected.rows[0].total_usd),
      },
      months: months.rows.map((row) => ({
        month: row.month,
        label: row.label.trim(),
        count: Number(row.count),
        totalUsd: Number(row.total_usd),
      })),
      byCountry: countries.rows.map((row) => ({
        country: row.country,
        count: Number(row.count),
        totalUsd: Number(row.total_usd),
      })),
      aging: agingOrder.map(([key, label]) => {
        const row = agingByKey.get(key);
        return { key, label, count: Number(row?.count ?? 0), dueUsd: money(Number(row?.due_usd ?? 0)) };
      }),
      topBuyers: buyers.rows.map((row) => ({
        buyer: row.buyer_name || 'No buyer',
        invoices: Number(row.invoices),
        dueUsd: money(Number(row.due_usd)),
        overdueUsd: money(Number(row.overdue_usd)),
      })),
      unpaid: {
        count: Number(openTotals.rows[0].count),
        dueUsd: money(Number(openTotals.rows[0].due_usd)),
        invoices: attention.rows.map((row) => {
          const totalUsd = Number(row.total_usd);
          const paidUsd = Number(row.paid_usd);
          return {
            id: row.id,
            invoiceNumber: row.invoice_number,
            buyerName: row.buyer_name,
            invoiceDate: row.invoice_date,
            dueDate: row.due_date,
            daysOverdue: Number(row.days_overdue),
            overdue: row.overdue,
            totalUsd,
            paidUsd,
            dueUsd: Math.max(0, money(totalUsd - paidUsd)),
          };
        }),
      },
      statusCounts,
    });
  }));
}
