import type { Express } from 'express';
import type { DbPool } from './db.js';
import { asyncHandler, currentUser, requireUser } from './http.js';

export function registerDashboardRoutes(app: Express, pool: DbPool): void {
  app.get('/api/dashboard', requireUser, asyncHandler(async (_req, res) => {
    const organizationId = currentUser(res).organizationId;
    const effectiveDate = 'COALESCE(i.invoice_date, i.created_at::date)';

    const [month, countries, unpaid, statuses] = await Promise.all([
      pool.query<{ count: string; total_usd: string; total_carats: string }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total_usd), 0) AS total_usd, COALESCE(SUM(total_carats), 0) AS total_carats
         FROM invoices i
         WHERE organization_id = $1 AND status IN ('issued', 'paid')
           AND ${effectiveDate} >= date_trunc('month', now())::date`,
        [organizationId],
      ),
      pool.query<{ country: string; count: string; total_usd: string }>(
        `SELECT COALESCE(NULLIF(destination_country, ''), 'Not set') AS country,
                COUNT(*) AS count, SUM(total_usd) AS total_usd
         FROM invoices i
         WHERE organization_id = $1 AND status IN ('issued', 'paid')
         GROUP BY 1 ORDER BY SUM(total_usd) DESC LIMIT 10`,
        [organizationId],
      ),
      pool.query<{ id: string; invoice_number: string; buyer_name: string; invoice_date: string | null; total_usd: string; paid_usd: string }>(
        `SELECT i.id, i.invoice_number, i.buyer_name, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
                i.total_usd, COALESCE(SUM(p.amount_usd), 0) AS paid_usd
         FROM invoices i
         LEFT JOIN payments p ON p.invoice_id = i.id
         WHERE i.organization_id = $1 AND i.status = 'issued'
         GROUP BY i.id
         ORDER BY ${effectiveDate}`,
        [organizationId],
      ),
      pool.query<{ status: string; count: string }>(
        'SELECT status, COUNT(*) AS count FROM invoices WHERE organization_id = $1 GROUP BY status',
        [organizationId],
      ),
    ]);

    const unpaidInvoices = unpaid.rows.map((row) => {
      const totalUsd = Number(row.total_usd);
      const paidUsd = Number(row.paid_usd);
      return {
        id: row.id,
        invoiceNumber: row.invoice_number,
        buyerName: row.buyer_name,
        invoiceDate: row.invoice_date,
        totalUsd,
        paidUsd,
        dueUsd: Math.max(0, Math.round((totalUsd - paidUsd) * 100) / 100),
      };
    });

    const statusCounts = { draft: 0, issued: 0, paid: 0, cancelled: 0 } as Record<string, number>;
    for (const row of statuses.rows) statusCounts[row.status] = Number(row.count);

    return res.json({
      thisMonth: {
        count: Number(month.rows[0].count),
        totalUsd: Number(month.rows[0].total_usd),
        totalCarats: Number(month.rows[0].total_carats),
      },
      byCountry: countries.rows.map((row) => ({
        country: row.country,
        count: Number(row.count),
        totalUsd: Number(row.total_usd),
      })),
      unpaid: {
        count: unpaidInvoices.length,
        dueUsd: Math.round(unpaidInvoices.reduce((sum, row) => sum + row.dueUsd, 0) * 100) / 100,
        invoices: unpaidInvoices,
      },
      statusCounts,
    });
  }));
}
