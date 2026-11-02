import type { Express } from 'express';
import type { PoolClient } from 'pg';
import type { DbPool } from '../../core/db.js';
import { closedMonthMessage } from '../tax/closedMonths.js';
import { asyncHandler, currentUser, requireAdmin, requireUser } from '../../core/http.js';
import { financialYear, invoiceFacts, isUuid, validateInvoice, type StoredInvoice } from './invoiceValidation.js';

export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

type InvoiceRow = {
  id: string;
  invoice_number: string;
  status: InvoiceStatus;
  buyer_name: string;
  destination_country: string;
  invoice_date: string | null;
  total_usd: string;
  total_carats: string;
  paid_usd: string;
  updated_at: Date;
  data?: unknown;
};

const SUMMARY_COLUMNS = `
  i.id, i.invoice_number, i.status, i.buyer_name, i.destination_country,
  to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
  i.total_usd, i.total_carats, i.updated_at,
  COALESCE((SELECT SUM(p.amount_usd) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_usd`;

function toSummary(row: InvoiceRow) {
  const totalUsd = Number(row.total_usd);
  const paidUsd = Number(row.paid_usd);
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    buyerName: row.buyer_name,
    destinationCountry: row.destination_country,
    invoiceDate: row.invoice_date,
    totalUsd,
    totalCarats: Number(row.total_carats),
    paidUsd,
    dueUsd: Math.max(0, Math.round((totalUsd - paidUsd) * 100) / 100),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toRecord(row: InvoiceRow) {
  return { ...toSummary(row), invoice: row.data };
}

type Filters = { q: string; status: string; from: string; to: string };

function readFilters(query: Record<string, unknown>): Filters {
  const read = (key: string) => (typeof query[key] === 'string' ? (query[key] as string).trim() : '');
  return { q: read('q'), status: read('status'), from: read('from'), to: read('to') };
}

function filterSql(organizationId: string, filters: Filters) {
  const clauses = ['i.organization_id = $1'];
  const params: unknown[] = [organizationId];
  if (filters.q) {
    params.push(`%${filters.q}%`);
    clauses.push(`(i.invoice_number ILIKE $${params.length} OR i.buyer_name ILIKE $${params.length})`);
  }
  if ((INVOICE_STATUSES as readonly string[]).includes(filters.status)) {
    params.push(filters.status);
    clauses.push(`i.status = $${params.length}`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(filters.from)) {
    params.push(filters.from);
    clauses.push(`COALESCE(i.invoice_date, i.created_at::date) >= $${params.length}`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(filters.to)) {
    params.push(filters.to);
    clauses.push(`COALESCE(i.invoice_date, i.created_at::date) <= $${params.length}`);
  }
  return { where: clauses.join(' AND '), params };
}

async function loadInvoice(pool: DbPool | PoolClient, id: string, organizationId: string) {
  const result = await pool.query<InvoiceRow>(
    `SELECT ${SUMMARY_COLUMNS}, i.data FROM invoices i WHERE i.id = $1 AND i.organization_id = $2`,
    [id, organizationId],
  );
  return result.rows[0];
}

async function numberTaken(client: PoolClient, organizationId: string, invoiceNumber: string, exceptId?: string) {
  const result = await client.query(
    `SELECT 1 FROM invoices
     WHERE organization_id = $1 AND lower(invoice_number) = lower($2) AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [organizationId, invoiceNumber, exceptId ?? null],
  );
  return Boolean(result.rowCount);
}

export async function nextInvoiceNumber(client: PoolClient, organizationId: string): Promise<string> {
  const profile = await client.query<{ profile: { invoicePrefix?: string } | null }>(
    'SELECT profile FROM organizations WHERE id = $1',
    [organizationId],
  );
  const prefix = profile.rows[0]?.profile?.invoicePrefix?.trim() || 'EXP';
  const year = financialYear(new Date());

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const counter = await client.query<{ last_number: number }>(
      `INSERT INTO invoice_counters (organization_id, financial_year, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (organization_id, financial_year)
       DO UPDATE SET last_number = invoice_counters.last_number + 1
       RETURNING last_number`,
      [organizationId, year],
    );
    const candidate = `${prefix}/${year}/${String(counter.rows[0].last_number).padStart(4, '0')}`;
    if (!(await numberTaken(client, organizationId, candidate))) return candidate;
  }
  throw new Error('Could not assign an invoice number.');
}

async function withNumber(client: PoolClient, organizationId: string, invoice: StoredInvoice, exceptId?: string) {
  let invoiceNumber = invoice.shipment.invoiceNumber.trim();
  if (!invoiceNumber) {
    invoiceNumber = await nextInvoiceNumber(client, organizationId);
  } else if (await numberTaken(client, organizationId, invoiceNumber, exceptId)) {
    return null;
  }
  const numbered: StoredInvoice = { ...invoice, shipment: { ...invoice.shipment, invoiceNumber } };
  return numbered;
}

export async function refreshPaidStatus(pool: DbPool | PoolClient, invoiceId: string): Promise<void> {
  await pool.query(
    `UPDATE invoices i
     SET status = CASE
         WHEN paid.total >= i.total_usd AND i.total_usd > 0 THEN 'paid'
         ELSE 'issued'
       END,
       updated_at = now()
     FROM (SELECT COALESCE(SUM(amount_usd), 0) AS total FROM payments WHERE invoice_id = $1) paid
     WHERE i.id = $1 AND i.status IN ('issued', 'paid')`,
    [invoiceId],
  );
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function registerInvoiceRoutes(app: Express, pool: DbPool): void {
  app.get('/api/invoices', requireUser, asyncHandler(async (req, res) => {
    const { where, params } = filterSql(currentUser(res).organizationId, readFilters(req.query));
    const result = await pool.query<InvoiceRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM invoices i WHERE ${where} ORDER BY i.updated_at DESC LIMIT 500`,
      params,
    );
    return res.json({ invoices: result.rows.map(toSummary) });
  }));

  app.get('/api/invoices/export', requireUser, asyncHandler(async (req, res) => {
    const { where, params } = filterSql(currentUser(res).organizationId, readFilters(req.query));
    const result = await pool.query<InvoiceRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM invoices i WHERE ${where}
       ORDER BY COALESCE(i.invoice_date, i.created_at::date) DESC, i.invoice_number`,
      params,
    );
    const header = ['Invoice number', 'Invoice date', 'Status', 'Buyer', 'Destination', 'Carats', 'Total USD', 'Paid USD', 'Due USD'];
    const lines = result.rows.map(toSummary).map((row) =>
      [row.invoiceNumber, row.invoiceDate, row.status, row.buyerName, row.destinationCountry,
        row.totalCarats.toFixed(3), row.totalUsd.toFixed(2), row.paidUsd.toFixed(2), row.dueUsd.toFixed(2)]
        .map(csvCell)
        .join(','),
    );
    const csv = `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="invoices-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  }));

  app.post('/api/invoices', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const validation = validateInvoice(req.body?.invoice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const parsed = validation.invoice;
    const closed = await closedMonthMessage(pool, user.organizationId, invoiceFacts(parsed).invoiceDate);
    if (closed) return res.status(409).json({ error: closed });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invoice = await withNumber(client, user.organizationId, parsed);
      if (!invoice) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Another invoice already uses that invoice number.' });
      }
      const facts = invoiceFacts(invoice);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO invoices (user_id, organization_id, invoice_number, data, status, buyer_name,
                               destination_country, invoice_date, total_usd, total_carats, credit_days)
         VALUES ($1, $2, $3, $4::jsonb, 'draft', $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [user.id, user.organizationId, facts.invoiceNumber, JSON.stringify(invoice), facts.buyerName,
          facts.destinationCountry, facts.invoiceDate, facts.totalUsd, facts.totalCarats, facts.creditDays],
      );
      await client.query('COMMIT');
      const row = await loadInvoice(pool, inserted.rows[0].id, user.organizationId);
      return res.status(201).json(toRecord(row));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get('/api/invoices/:id', requireUser, asyncHandler(async (req, res) => {
    const row = isUuid(req.params.id) ? await loadInvoice(pool, req.params.id, currentUser(res).organizationId) : undefined;
    if (!row) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    return res.json(toRecord(row));
  }));

  app.put('/api/invoices/:id', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const existing = isUuid(req.params.id) ? await loadInvoice(pool, req.params.id, user.organizationId) : undefined;
    if (!existing) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    if (existing.status !== 'draft') {
      return res.status(409).json({ error: `This invoice is ${existing.status} and locked. Duplicate it to make changes.` });
    }
    const validation = validateInvoice(req.body?.invoice);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    const parsed = validation.invoice;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invoice = await withNumber(client, user.organizationId, parsed, existing.id);
      if (!invoice) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Another invoice already uses that invoice number.' });
      }
      const facts = invoiceFacts(invoice);
      const closed =
        (await closedMonthMessage(pool, user.organizationId, existing.invoice_date)) ??
        (await closedMonthMessage(pool, user.organizationId, facts.invoiceDate));
      if (closed) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: closed });
      }
      await client.query(
        `UPDATE invoices
         SET invoice_number = $3, data = $4::jsonb, buyer_name = $5, destination_country = $6,
             invoice_date = $7, total_usd = $8, total_carats = $9, credit_days = $10, updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND status = 'draft'`,
        [existing.id, user.organizationId, facts.invoiceNumber, JSON.stringify(invoice), facts.buyerName,
          facts.destinationCountry, facts.invoiceDate, facts.totalUsd, facts.totalCarats, facts.creditDays],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const row = await loadInvoice(pool, existing.id, user.organizationId);
    return res.json(toRecord(row));
  }));

  app.patch('/api/invoices/:id/status', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const existing = isUuid(req.params.id) ? await loadInvoice(pool, req.params.id, user.organizationId) : undefined;
    if (!existing) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    const next = req.body?.status;
    const allowed =
      (existing.status === 'draft' && (next === 'issued' || next === 'cancelled')) ||
      ((existing.status === 'issued' || existing.status === 'paid') && next === 'cancelled');
    if (!allowed) {
      return res.status(400).json({ error: `A ${existing.status} invoice cannot be marked ${String(next)}.` });
    }
    if (next === 'cancelled' && existing.status !== 'draft' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only company admins can cancel an issued invoice.' });
    }
    const closed = await closedMonthMessage(pool, user.organizationId, existing.invoice_date);
    if (closed) return res.status(409).json({ error: closed });

    await pool.query(
      'UPDATE invoices SET status = $3, updated_at = now() WHERE id = $1 AND organization_id = $2',
      [existing.id, user.organizationId, next],
    );
    if (next === 'issued') await refreshPaidStatus(pool, existing.id);
    const row = await loadInvoice(pool, existing.id, user.organizationId);
    return res.json(toRecord(row));
  }));

  app.delete('/api/invoices/:id', requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    const existing = await loadInvoice(pool, req.params.id, currentUser(res).organizationId);
    if (!existing) return res.status(404).json({ error: 'Invoice not found.' });
    const closed = await closedMonthMessage(pool, currentUser(res).organizationId, existing.invoice_date);
    if (closed) return res.status(409).json({ error: closed });
    const result = await pool.query(
      'DELETE FROM invoices WHERE id = $1 AND organization_id = $2',
      [req.params.id, currentUser(res).organizationId],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    return res.status(204).send();
  }));
}
