import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { formReader } from '../../core/formInput.js';
import { asyncHandler, currentUser, isUuid, requireUser, type CurrentUser } from '../../core/http.js';

const ATTACHMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'text/csv', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
export const MAX_ATTACHMENT_BYTES = 2_000_000;

/** The accountant side asks; the company side answers. */
function isAccountantSide(user: CurrentUser): boolean {
  return user.role === 'ca' || user.role === 'tax';
}

type RequestRow = {
  id: string; title: string; detail: string; due_date: string | null; status: 'open' | 'answered' | 'closed';
  invoice_id: string | null; invoice_number: string | null; created_by_email: string; created_at: Date; updated_at: Date;
  messages: string; last_message_at: Date | null;
};

function toRequest(row: RequestRow, today: string) {
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    dueDate: row.due_date,
    overdue: row.status !== 'closed' && row.due_date !== null && row.due_date < today,
    status: row.status,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messages: Number(row.messages),
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
  };
}

export async function openRequestCounts(pool: DbPool, organizationId: string) {
  const result = await pool.query<{ open: string; overdue: string }>(
    `SELECT COUNT(*) FILTER (WHERE status <> 'closed') AS open,
            COUNT(*) FILTER (WHERE status <> 'closed' AND due_date < current_date) AS overdue
     FROM client_requests WHERE organization_id = $1`,
    [organizationId],
  );
  return { open: Number(result.rows[0].open), overdue: Number(result.rows[0].overdue) };
}

function readAttachment(value: unknown): { fileName: string; contentType: string; content: Buffer } | null | string {
  if (value === undefined || value === null) return null;
  const file = value as { name?: unknown; type?: unknown; base64?: unknown };
  const fileName = typeof file.name === 'string' ? file.name.trim().slice(0, 200) : '';
  const contentType = typeof file.type === 'string' ? file.type : '';
  if (!fileName || typeof file.base64 !== 'string') return 'The attachment is missing its name or content.';
  if (!ATTACHMENT_TYPES.has(contentType)) return 'Attach a PDF, JPG, PNG, CSV, or Excel file.';
  const content = Buffer.from(file.base64, 'base64');
  if (!content.length) return 'The attachment is empty.';
  if (content.length > MAX_ATTACHMENT_BYTES) return 'Attachments can be at most 2 MB.';
  return { fileName, contentType, content };
}

export function registerClientRequestRoutes(app: Express, pool: DbPool): void {
  const loadRequest = async (organizationId: string, id: string) => {
    if (!isUuid(id)) return undefined;
    const result = await pool.query<{ id: string; status: string; created_by: string | null }>(
      'SELECT id, status, created_by FROM client_requests WHERE id = $1 AND organization_id = $2',
      [id, organizationId],
    );
    return result.rows[0];
  };

  app.get('/api/requests', requireUser, asyncHandler(async (req, res) => {
    const status = req.query.status === 'closed' ? 'closed' : req.query.status === 'all' ? 'all' : 'active';
    const result = await pool.query<RequestRow>(
      `SELECT r.id, r.title, r.detail, to_char(r.due_date, 'YYYY-MM-DD') AS due_date, r.status, r.invoice_id, i.invoice_number,
              r.created_by_email, r.created_at, r.updated_at,
              (SELECT COUNT(*) FROM client_request_messages m WHERE m.request_id = r.id) AS messages,
              (SELECT MAX(created_at) FROM client_request_messages m WHERE m.request_id = r.id) AS last_message_at
       FROM client_requests r LEFT JOIN invoices i ON i.id = r.invoice_id
       WHERE r.organization_id = $1
         AND ($2 = 'all' OR ($2 = 'closed' AND r.status = 'closed') OR ($2 = 'active' AND r.status <> 'closed'))
       ORDER BY (r.status = 'closed'), r.due_date NULLS LAST, r.updated_at DESC
       LIMIT 500`,
      [currentUser(res).organizationId, status],
    );
    const today = new Date().toISOString().slice(0, 10);
    return res.json({ requests: result.rows.map((row) => toRequest(row, today)) });
  }));

  app.post('/api/requests', requireUser, asyncHandler(async (req, res) => {
    const form = formReader(req.body);
    const user = currentUser(res);
    const title = form.required('title', 'Say what you need, for example "Bank statement for March".', 200);
    const detail = form.text('detail', 4000);
    const dueDate = form.date('dueDate', 'Enter the due date as YYYY-MM-DD.', true);
    const invoiceId = form.text('invoiceId', 40);
    if (invoiceId) {
      const found = isUuid(invoiceId)
        ? await pool.query('SELECT 1 FROM invoices WHERE id = $1 AND organization_id = $2', [invoiceId, user.organizationId])
        : { rowCount: 0 };
      if (!found.rowCount) return res.status(400).json({ error: 'That invoice is not in this company.' });
    }
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO client_requests (organization_id, title, detail, due_date, invoice_id, created_by, created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [user.organizationId, title, detail, dueDate, invoiceId || null, user.id, user.email],
    );
    return res.status(201).json({ id: inserted.rows[0].id });
  }));

  app.get('/api/requests/:id/messages', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const request = await loadRequest(user.organizationId, req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    const result = await pool.query<{ id: string; user_email: string; body: string; file_name: string | null; content_type: string | null; byte_size: number | null; created_at: Date }>(
      `SELECT id, user_email, body, file_name, content_type, byte_size, created_at FROM client_request_messages
       WHERE request_id = $1 ORDER BY created_at`,
      [request.id],
    );
    return res.json({
      messages: result.rows.map((row) => ({
        id: row.id,
        userEmail: row.user_email,
        body: row.body,
        file: row.file_name ? { name: row.file_name, type: row.content_type, size: row.byte_size } : null,
        createdAt: row.created_at.toISOString(),
      })),
    });
  }));

  app.post('/api/requests/:id/messages', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const request = await loadRequest(user.organizationId, req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    if (request.status === 'closed') return res.status(409).json({ error: 'This request is closed. Reopen it to reply.' });
    const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 4000) : '';
    const file = readAttachment(req.body?.file);
    if (typeof file === 'string') return res.status(400).json({ error: file });
    if (!body && !file) return res.status(400).json({ error: 'Write a reply or attach a file.' });
    await pool.query(
      `INSERT INTO client_request_messages (request_id, organization_id, user_id, user_email, body, file_name, content_type, byte_size, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [request.id, user.organizationId, user.id, user.email, body, file?.fileName ?? null, file?.contentType ?? null,
        file?.content.length ?? null, file?.content ?? null],
    );
    // A reply from the company marks the request answered; a follow-up from the accountant opens it again.
    await pool.query('UPDATE client_requests SET status = $2, updated_at = now() WHERE id = $1', [
      request.id,
      isAccountantSide(user) ? 'open' : 'answered',
    ]);
    return res.status(201).json({ ok: true });
  }));

  app.post('/api/requests/:id/status', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const request = await loadRequest(user.organizationId, req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    const status = req.body?.status === 'closed' ? 'closed' : req.body?.status === 'open' ? 'open' : null;
    if (!status) return res.status(400).json({ error: 'Status must be open or closed.' });
    const allowed = request.created_by === user.id || user.role === 'admin' || isAccountantSide(user);
    if (!allowed) return res.status(403).json({ error: 'Only the person who asked, an admin, or the accountant can close this request.' });
    await pool.query('UPDATE client_requests SET status = $2, updated_at = now() WHERE id = $1', [request.id, status]);
    return res.json({ status });
  }));

  app.get('/api/requests/:id/messages/:messageId/file', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    if (!isUuid(req.params.id) || !isUuid(req.params.messageId)) return res.status(404).json({ error: 'File not found.' });
    const result = await pool.query<{ file_name: string; content_type: string; content: Buffer }>(
      `SELECT file_name, content_type, content FROM client_request_messages
       WHERE id = $1 AND request_id = $2 AND organization_id = $3 AND content IS NOT NULL`,
      [req.params.messageId, req.params.id, user.organizationId],
    );
    const file = result.rows[0];
    if (!file) return res.status(404).json({ error: 'File not found.' });
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name.replace(/["\r\n\\]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(file.content);
  }));
}
