import crypto from 'node:crypto';
import type { Express, Request } from 'express';
import type { DbPool } from '../../core/db.js';
import { asyncHandler, currentUser, isUuid, requireRoles } from '../../core/http.js';
import { money } from '../tax/taxShared.js';

const linkManager = requireRoles('admin', 'member', 'tax');
const MAX_DAYS = 365;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function siteUrl(req: Request): string {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

export function registerPortalRoutes(app: Express, pool: DbPool): void {
  app.get('/api/portal-links', linkManager, asyncHandler(async (_req, res) => {
    const result = await pool.query<{
      id: string; buyer_name: string; created_at: Date; expires_at: Date; revoked_at: Date | null; last_viewed_at: Date | null; created_by_email: string | null;
    }>(
      `SELECT l.id, l.buyer_name, l.created_at, l.expires_at, l.revoked_at, l.last_viewed_at, u.email AS created_by_email
       FROM buyer_portal_links l LEFT JOIN users u ON u.id = l.created_by
       WHERE l.organization_id = $1 ORDER BY l.created_at DESC`,
      [currentUser(res).organizationId],
    );
    return res.json({
      links: result.rows.map((row) => ({
        id: row.id,
        buyerName: row.buyer_name,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
        lastViewedAt: row.last_viewed_at?.toISOString() ?? null,
        createdBy: row.created_by_email ?? '',
        active: !row.revoked_at && row.expires_at > new Date(),
      })),
    });
  }));

  app.post('/api/portal-links', linkManager, asyncHandler(async (req, res) => {
    const buyerName = typeof req.body?.buyerName === 'string' ? req.body.buyerName.trim().slice(0, 200) : '';
    if (!buyerName) return res.status(400).json({ error: 'Choose the buyer.' });
    const days = Math.min(Math.max(Math.round(Number(req.body?.days) || 90), 1), MAX_DAYS);
    const user = currentUser(res);
    const token = crypto.randomBytes(24).toString('base64url');
    const inserted = await pool.query<{ id: string; expires_at: Date }>(
      `INSERT INTO buyer_portal_links (organization_id, buyer_name, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
      [user.organizationId, buyerName, hashToken(token), user.id, days],
    );
    // The token is shown once. Only its hash is stored, so a lost link has to be replaced.
    return res.status(201).json({
      id: inserted.rows[0].id,
      url: `${siteUrl(req)}/?portal=${token}`,
      expiresAt: inserted.rows[0].expires_at.toISOString(),
    });
  }));

  app.delete('/api/portal-links/:id', linkManager, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Link not found.' });
    const result = await pool.query(
      'UPDATE buyer_portal_links SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL',
      [req.params.id, currentUser(res).organizationId],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Link not found.' });
    return res.json({ revoked: true });
  }));

  // Public: no sign-in. The token decides which company and which buyer can be seen.
  app.get('/api/portal/:token', asyncHandler(async (req, res) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).json({ error: 'This link is not valid.' });
    const link = await pool.query<{ id: string; organization_id: string; buyer_name: string; expires_at: Date; organization_name: string }>(
      `UPDATE buyer_portal_links l SET last_viewed_at = now()
       FROM organizations o
       WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now() AND o.id = l.organization_id
       RETURNING l.id, l.organization_id, l.buyer_name, l.expires_at, o.name AS organization_name`,
      [hashToken(token)],
    );
    const found = link.rows[0];
    if (!found) return res.status(404).json({ error: 'This link has expired or was withdrawn. Ask the exporter for a new one.' });

    const invoices = await pool.query<{
      id: string; invoice_number: string; invoice_date: string; due_date: string; status: string; total_usd: string; paid_usd: string;
      overdue: boolean; data: unknown;
    }>(
      `SELECT i.id, i.invoice_number, to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
              to_char(COALESCE(i.invoice_date, i.created_at::date) + i.credit_days, 'YYYY-MM-DD') AS due_date,
              i.status, i.total_usd, COALESCE(p.paid, 0) AS paid_usd,
              (i.status = 'issued' AND COALESCE(i.invoice_date, i.created_at::date) + i.credit_days < current_date
                AND i.total_usd - COALESCE(p.paid, 0) > 0) AS overdue,
              i.data
       FROM invoices i
       LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid FROM payments WHERE invoice_id = i.id) p ON true
       WHERE i.organization_id = $1 AND LOWER(TRIM(i.buyer_name)) = LOWER(TRIM($2)) AND i.status IN ('issued', 'paid')
       ORDER BY COALESCE(i.invoice_date, i.created_at::date) DESC
       LIMIT 500`,
      [found.organization_id, found.buyer_name],
    );
    res.setHeader('Cache-Control', 'no-store');
    const rows = invoices.rows.map((row) => {
      const totalUsd = money(row.total_usd);
      const paidUsd = money(row.paid_usd);
      return {
        id: row.id,
        invoiceNumber: row.invoice_number,
        invoiceDate: row.invoice_date,
        dueDate: row.due_date,
        status: row.status,
        totalUsd,
        paidUsd,
        dueUsd: money(Math.max(totalUsd - paidUsd, 0)),
        overdue: row.overdue,
        invoice: row.data,
      };
    });
    return res.json({
      exporterName: found.organization_name,
      buyerName: found.buyer_name,
      expiresAt: found.expires_at.toISOString(),
      invoices: rows,
      totals: {
        invoices: rows.length,
        dueUsd: money(rows.reduce((sum, row) => sum + row.dueUsd, 0)),
        overdueUsd: money(rows.filter((row) => row.overdue).reduce((sum, row) => sum + row.dueUsd, 0)),
      },
    });
  }));
}
