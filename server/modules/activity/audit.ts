import type { Express, NextFunction, Request, Response } from 'express';
import type { DbPool } from '../../core/db.js';
import { asyncHandler, currentUser, type CurrentUser } from '../../core/http.js';
import { csvFile, parseLooseDate, taxReader } from '../tax/taxShared.js';

type Rule = {
  method: string;
  pattern: RegExp;
  action: string;
  entityType: string;
  summary: (req: Request, match: RegExpExecArray) => string;
};

const UUID = '([0-9a-f-]{36})';

/** Every change the app can make, with how to describe it in the activity history. */
const RULES: Rule[] = [
  { method: 'POST', pattern: /^\/api\/invoices$/, action: 'invoice.create', entityType: 'invoice', summary: () => 'Created an invoice draft' },
  { method: 'PUT', pattern: new RegExp(`^/api/invoices/${UUID}$`), action: 'invoice.edit', entityType: 'invoice', summary: () => 'Edited an invoice draft' },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/invoices/${UUID}/status$`),
    action: 'invoice.status',
    entityType: 'invoice',
    summary: (req) => (req.body?.status === 'issued' ? 'Issued an invoice' : req.body?.status === 'cancelled' ? 'Cancelled an invoice' : 'Changed an invoice status'),
  },
  { method: 'DELETE', pattern: new RegExp(`^/api/invoices/${UUID}$`), action: 'invoice.delete', entityType: 'invoice', summary: () => 'Deleted an invoice draft' },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/invoices/${UUID}/payments$`),
    action: 'payment.record',
    entityType: 'invoice',
    summary: (req) => `Recorded a payment of USD ${Number(req.body?.amountUsd ?? 0).toFixed(2)}`,
  },
  { method: 'PATCH', pattern: new RegExp(`^/api/invoices/${UUID}/payments/${UUID}$`), action: 'payment.edit', entityType: 'invoice', summary: () => 'Changed a payment (bank rate or details)' },
  { method: 'DELETE', pattern: new RegExp(`^/api/invoices/${UUID}/payments/${UUID}$`), action: 'payment.delete', entityType: 'invoice', summary: () => 'Deleted a payment' },
  { method: 'PUT', pattern: new RegExp(`^/api/invoices/${UUID}/tax$`), action: 'invoice.tax', entityType: 'invoice', summary: () => 'Updated shipping bill and tax details' },
  { method: 'PUT', pattern: new RegExp(`^/api/invoices/${UUID}/einvoice$`), action: 'invoice.einvoice', entityType: 'invoice', summary: () => 'Recorded the e-invoice IRN' },
  { method: 'POST', pattern: new RegExp(`^/api/invoices/${UUID}/documents$`), action: 'document.upload', entityType: 'invoice', summary: (req) => `Uploaded a ${String(req.body?.kind ?? 'document').replace(/_/g, ' ')}` },
  { method: 'DELETE', pattern: new RegExp(`^/api/invoices/${UUID}/documents/${UUID}$`), action: 'document.delete', entityType: 'invoice', summary: () => 'Deleted a document' },
  {
    method: 'PUT',
    pattern: new RegExp(`^/api/invoices/${UUID}/review$`),
    action: 'invoice.review',
    entityType: 'invoice',
    summary: (req) => (req.body?.status === 'accepted' ? 'Accepted an invoice (CA review)' : 'Raised a query on an invoice (CA review)'),
  },
  { method: 'POST', pattern: /^\/api\/bank\/import$/, action: 'bank.import', entityType: 'bank', summary: () => 'Imported a bank statement' },
  { method: 'POST', pattern: /^\/api\/bank\/import-lines$/, action: 'bank.import', entityType: 'bank', summary: (req) => `Imported ${Array.isArray(req.body?.lines) ? req.body.lines.length : 0} bank lines read by AI` },
  { method: 'POST', pattern: new RegExp(`^/api/bank/lines/${UUID}/match$`), action: 'bank.match', entityType: 'bank_line', summary: () => 'Matched a bank credit to an invoice' },
  { method: 'POST', pattern: new RegExp(`^/api/bank/lines/${UUID}/ignore$`), action: 'bank.ignore', entityType: 'bank_line', summary: () => 'Ignored a bank line' },
  { method: 'POST', pattern: /^\/api\/tax\/months\/(\d{4}-\d{2})\/close$/, action: 'month.close', entityType: 'month', summary: (_req, m) => `Closed the books for ${m[1]}` },
  { method: 'POST', pattern: /^\/api\/tax\/months\/(\d{4}-\d{2})\/open$/, action: 'month.open', entityType: 'month', summary: (_req, m) => `Reopened ${m[1]}` },
  { method: 'PUT', pattern: /^\/api\/tax\/settings$/, action: 'tax.settings', entityType: 'settings', summary: () => 'Changed tax settings (LUT, realization period)' },
  { method: 'POST', pattern: /^\/api\/tax\/ebrc\/import$/, action: 'ebrc.import', entityType: 'ebrc', summary: () => 'Imported e-BRCs' },
  { method: 'PUT', pattern: /^\/api\/company$/, action: 'company.edit', entityType: 'company', summary: () => 'Edited the company profile' },
  { method: 'POST', pattern: /^\/api\/buyers$/, action: 'buyer.create', entityType: 'buyer', summary: (req) => `Added buyer ${req.body?.consignee?.companyName ?? ''}`.trim() },
  { method: 'PUT', pattern: new RegExp(`^/api/buyers/${UUID}$`), action: 'buyer.edit', entityType: 'buyer', summary: (req) => `Edited buyer ${req.body?.consignee?.companyName ?? ''}`.trim() },
  { method: 'DELETE', pattern: new RegExp(`^/api/buyers/${UUID}$`), action: 'buyer.delete', entityType: 'buyer', summary: () => 'Deleted a buyer' },
  { method: 'POST', pattern: /^\/api\/team\/members$/, action: 'team.add', entityType: 'user', summary: (req) => `Added team member ${req.body?.email ?? ''}`.trim() },
  { method: 'PATCH', pattern: new RegExp(`^/api/team/members/${UUID}$`), action: 'team.role', entityType: 'user', summary: (req) => `Changed a team member's role to ${req.body?.role ?? ''}`.trim() },
  { method: 'DELETE', pattern: new RegExp(`^/api/team/members/${UUID}$`), action: 'team.remove', entityType: 'user', summary: () => 'Removed a team member' },
  { method: 'POST', pattern: /^\/api\/team\/accountants$/, action: 'team.ca', entityType: 'user', summary: (req) => `Gave ${req.body?.email ?? 'an accountant'} access`.trim() },
  { method: 'DELETE', pattern: new RegExp(`^/api/team/accountants/${UUID}$`), action: 'team.ca_remove', entityType: 'user', summary: () => "Removed an accountant's access" },
  { method: 'POST', pattern: /^\/api\/send-email$/, action: 'email.send', entityType: 'email', summary: () => 'Emailed an invoice' },
  { method: 'POST', pattern: new RegExp(`^/api/reminders/${UUID}/send$`), action: 'reminder.send', entityType: 'reminder', summary: () => 'Sent a payment reminder' },
  { method: 'POST', pattern: new RegExp(`^/api/assistant/actions/${UUID}/confirm$`), action: 'assistant.confirm', entityType: 'assistant_action', summary: () => 'Confirmed a change proposed by the assistant' },
  { method: 'PUT', pattern: /^\/api\/rates\/company$/, action: 'rate.set', entityType: 'rate', summary: (req) => `Set the company rate for ${req.body?.date ?? ''} to ₹${req.body?.rateInr ?? ''}` },
  { method: 'DELETE', pattern: /^\/api\/rates\/company\/([0-9-]+)$/, action: 'rate.delete', entityType: 'rate', summary: (_req, m) => `Removed the company rate for ${m[1]}` },
  { method: 'POST', pattern: /^\/api\/parcels$/, action: 'parcel.create', entityType: 'parcel', summary: (req) => `Received parcel ${req.body?.parcelId ?? ''} (${req.body?.caratsIn ?? ''} ct)` },
  { method: 'PUT', pattern: new RegExp(`^/api/parcels/${UUID}$`), action: 'parcel.edit', entityType: 'parcel', summary: (req) => `Edited parcel ${req.body?.parcelId ?? ''}`.trim() },
  { method: 'DELETE', pattern: new RegExp(`^/api/parcels/${UUID}$`), action: 'parcel.delete', entityType: 'parcel', summary: () => 'Deleted a parcel' },
  { method: 'POST', pattern: /^\/api\/portal-links$/, action: 'portal.create', entityType: 'portal_link', summary: (req) => `Created a buyer portal link for ${req.body?.buyerName ?? ''}`.trim() },
  { method: 'DELETE', pattern: new RegExp(`^/api/portal-links/${UUID}$`), action: 'portal.revoke', entityType: 'portal_link', summary: () => 'Revoked a buyer portal link' },
  { method: 'POST', pattern: /^\/api\/purchases$/, action: 'purchase.create', entityType: 'purchase', summary: (req) => `Recorded purchase ${req.body?.documentNo ?? ''} from ${req.body?.supplierName ?? ''}`.trim() },
  { method: 'PUT', pattern: new RegExp(`^/api/purchases/${UUID}$`), action: 'purchase.edit', entityType: 'purchase', summary: (req) => `Edited purchase ${req.body?.documentNo ?? ''}`.trim() },
  { method: 'DELETE', pattern: new RegExp(`^/api/purchases/${UUID}$`), action: 'purchase.delete', entityType: 'purchase', summary: () => 'Deleted a purchase' },
  { method: 'POST', pattern: /^\/api\/purchases\/gstr2b$/, action: 'gstr2b.import', entityType: 'gstr2b', summary: (req) => `Imported GSTR-2B for ${req.body?.month ?? ''}`.trim() },
  { method: 'POST', pattern: /^\/api\/foreign-payments$/, action: 'foreign_payment.create', entityType: 'foreign_payment', summary: (req) => `Recorded a payment abroad to ${req.body?.payeeName ?? ''}`.trim() },
  { method: 'PUT', pattern: new RegExp(`^/api/foreign-payments/${UUID}$`), action: 'foreign_payment.edit', entityType: 'foreign_payment', summary: (req) => `Edited a payment abroad to ${req.body?.payeeName ?? ''}`.trim() },
  { method: 'DELETE', pattern: new RegExp(`^/api/foreign-payments/${UUID}$`), action: 'foreign_payment.delete', entityType: 'foreign_payment', summary: () => 'Deleted a payment abroad' },
  { method: 'POST', pattern: /^\/api\/tally\/import$/, action: 'tally.import', entityType: 'tally', summary: () => 'Imported vouchers from Tally' },
  { method: 'DELETE', pattern: /^\/api\/tally\/vouchers$/, action: 'tally.clear', entityType: 'tally', summary: () => 'Cleared imported Tally vouchers' },
  { method: 'POST', pattern: /^\/api\/requests$/, action: 'request.create', entityType: 'request', summary: (req) => `Asked: ${String(req.body?.title ?? '').slice(0, 120)}` },
  { method: 'POST', pattern: new RegExp(`^/api/requests/${UUID}/messages$`), action: 'request.reply', entityType: 'request', summary: (req) => (req.body?.file ? `Replied to a request with ${req.body.file.name ?? 'a file'}` : 'Replied to a request') },
  { method: 'POST', pattern: new RegExp(`^/api/requests/${UUID}/status$`), action: 'request.status', entityType: 'request', summary: (req) => (req.body?.status === 'closed' ? 'Closed a request' : 'Reopened a request') },
  { method: 'POST', pattern: /^\/api\/notices$/, action: 'notice.create', entityType: 'notice', summary: (req) => `Logged notice ${req.body?.formType ?? ''} ${req.body?.referenceNo ?? ''}`.trim() },
  { method: 'PUT', pattern: new RegExp(`^/api/notices/${UUID}$`), action: 'notice.edit', entityType: 'notice', summary: (req) => `Updated notice ${req.body?.formType ?? ''} (${req.body?.status ?? 'open'})`.trim() },
  { method: 'DELETE', pattern: new RegExp(`^/api/notices/${UUID}$`), action: 'notice.delete', entityType: 'notice', summary: () => 'Deleted a notice' },
  { method: 'POST', pattern: new RegExp(`^/api/notices/${UUID}/draft-reply$`), action: 'notice.draft', entityType: 'notice', summary: () => 'Drafted a notice reply' },
  { method: 'POST', pattern: /^\/api\/billing\/checkout$/, action: 'billing.checkout', entityType: 'billing', summary: (req) => `Started checkout for the ${req.body?.plan ?? ''} plan (${req.body?.cycle ?? ''})` },
  { method: 'POST', pattern: /^\/api\/billing\/verify$/, action: 'billing.paid', entityType: 'billing', summary: () => 'Paid for a plan' },
  { method: 'POST', pattern: /^\/api\/billing\/cancel$/, action: 'billing.cancel', entityType: 'billing', summary: () => 'Turned off plan renewal' },
  { method: 'PUT', pattern: new RegExp(`^/api/buyers/${UUID}/credit-limit$`), action: 'buyer.credit_limit', entityType: 'buyer', summary: (req) => (req.body?.creditLimitUsd ? `Set a buyer credit limit of USD ${req.body.creditLimitUsd}` : 'Removed a buyer credit limit') },
];

export function describeChange(req: Request): { rule: Rule; match: RegExpExecArray } | null {
  for (const rule of RULES) {
    if (rule.method !== req.method) continue;
    const match = rule.pattern.exec(req.path);
    if (match) return { rule, match };
  }
  return null;
}

/**
 * Records successful changes. The response is held until the row is written, so the entry is not
 * lost when a serverless function is frozen right after it answers.
 */
export function auditTrail(pool: DbPool) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const found = describeChange(req);
    const user = res.locals.user as CurrentUser | undefined;
    if (!found || !user) {
      next();
      return;
    }
    const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
    let done = false;
    res.end = ((...args: unknown[]) => {
      if (done || res.statusCode >= 400) return originalEnd(...args);
      done = true;
      const { rule, match } = found;
      const entityId = match[1] ?? '';
      const summary = rule.summary(req, match).slice(0, 300);
      pool
        .query(
          `INSERT INTO audit_events (organization_id, user_id, user_email, action, summary, entity_type, entity_id, method, path)
           VALUES ($1, $2, $3, $4,
             $5 || COALESCE((SELECT ' ' || invoice_number FROM invoices WHERE $6 = 'invoice' AND id::text = $7 AND organization_id = $1), ''),
             $6, $7, $8, $9)`,
          [user.organizationId, user.id, user.email, rule.action, summary, rule.entityType, entityId, req.method, req.path],
        )
        .catch((error: Error) => console.error('Could not record activity:', error.message))
        .finally(() => originalEnd(...args));
      return res;
    }) as Response['end'];
    next();
  };
}

export function registerAuditRoutes(app: Express, pool: DbPool): void {
  const query = async (organizationId: string, req: Request, limit: number) => {
    const from = parseLooseDate(String(req.query.from ?? ''));
    const to = parseLooseDate(String(req.query.to ?? ''));
    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const result = await pool.query<{
      id: string; created_at: Date; user_email: string; action: string; summary: string; entity_type: string; entity_id: string;
    }>(
      `SELECT id, created_at, user_email, action, summary, entity_type, entity_id FROM audit_events
       WHERE organization_id = $1
         AND ($2::date IS NULL OR created_at >= $2::date)
         AND ($3::date IS NULL OR created_at < $3::date + 1)
         AND ($4 = '' OR summary ILIKE '%' || $4 || '%' OR user_email ILIKE '%' || $4 || '%')
       ORDER BY created_at DESC LIMIT $5`,
      [organizationId, from, to, search, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      at: row.created_at.toISOString(),
      userEmail: row.user_email,
      action: row.action,
      summary: row.summary,
      entityType: row.entity_type,
      entityId: row.entity_id,
    }));
  };

  app.get('/api/audit', taxReader, asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    return res.json({ events: await query(currentUser(res).organizationId, req, limit) });
  }));

  app.get('/api/audit/csv', taxReader, asyncHandler(async (req, res) => {
    const events = await query(currentUser(res).organizationId, req, 10000);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="activity-history.csv"');
    return res.send(csvFile(['When (UTC)', 'Who', 'What', 'Action'], events.map((event) => [event.at, event.userEmail, event.summary, event.action])));
  }));
}
