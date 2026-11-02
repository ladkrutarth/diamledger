import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { closedMonthMessage } from '../tax/closedMonths.js';
import { asyncHandler, currentUser, requireAdmin, requireUser, isUuid, type CurrentUser } from '../../core/http.js';
import { refreshPaidStatus } from './invoices.js';

type PaymentRow = {
  id: string;
  amount_usd: string;
  paid_on: string;
  reference: string;
  bank_rate_inr: string | null;
  created_at: Date;
};

function toPayment(row: PaymentRow) {
  return {
    id: row.id,
    amountUsd: Number(row.amount_usd),
    paidOn: row.paid_on,
    reference: row.reference,
    bankRateInr: row.bank_rate_inr === null ? null : Number(row.bank_rate_inr),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function findInvoice(pool: DbPool, id: string, organizationId: string) {
  if (!isUuid(id)) return undefined;
  const result = await pool.query<{ id: string; status: string; total_usd: string; invoice_date: string | null }>(
    `SELECT id, status, total_usd, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date
     FROM invoices WHERE id = $1 AND organization_id = $2`,
    [id, organizationId],
  );
  return result.rows[0];
}

async function listPayments(pool: DbPool, invoiceId: string) {
  const result = await pool.query<PaymentRow>(
    `SELECT id, amount_usd, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, reference, bank_rate_inr, created_at
     FROM payments WHERE invoice_id = $1 ORDER BY paid_on, created_at`,
    [invoiceId],
  );
  return result.rows.map(toPayment);
}

async function paymentState(pool: DbPool, invoiceId: string) {
  const invoice = await pool.query<{ status: string; total_usd: string }>(
    'SELECT status, total_usd FROM invoices WHERE id = $1',
    [invoiceId],
  );
  const payments = await listPayments(pool, invoiceId);
  const totalUsd = Number(invoice.rows[0].total_usd);
  const paidUsd = Math.round(payments.reduce((sum, payment) => sum + payment.amountUsd, 0) * 100) / 100;
  return {
    status: invoice.rows[0].status,
    totalUsd,
    paidUsd,
    dueUsd: Math.max(0, Math.round((totalUsd - paidUsd) * 100) / 100),
    payments,
  };
}

export type PaymentInput = { amountUsd?: unknown; paidOn?: unknown; reference?: unknown; bankRateInr?: unknown };

export type PaymentResult =
  | { ok: true; state: Awaited<ReturnType<typeof paymentState>>; paymentId: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

export async function recordPayment(
  pool: DbPool,
  user: CurrentUser,
  invoiceId: string,
  input: PaymentInput,
  options: { withinBalance?: boolean } = {},
): Promise<PaymentResult> {
  const invoice = await findInvoice(pool, invoiceId, user.organizationId);
  if (!invoice) {
    return { ok: false, status: 404, error: 'Invoice not found.' };
  }
  if (invoice.status !== 'issued' && invoice.status !== 'paid') {
    return { ok: false, status: 409, error: 'Issue the invoice before recording payments.' };
  }
  const closed = await closedMonthMessage(pool, user.organizationId, invoice.invoice_date);
  if (closed) return { ok: false, status: 409, error: closed };

  const amount = Math.round(Number(input.amountUsd) * 100) / 100;
  const paidOn = typeof input.paidOn === 'string' ? input.paidOn : '';
  const reference = typeof input.reference === 'string' ? input.reference.trim().slice(0, 200) : '';
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e11) {
    return { ok: false, status: 400, error: 'Enter a payment amount greater than zero.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(paidOn))) {
    return { ok: false, status: 400, error: 'Enter the date the payment was received.' };
  }
  const bankRate = parseBankRate(input.bankRateInr);
  if (bankRate === undefined) {
    return { ok: false, status: 400, error: 'Enter the bank exchange rate in rupees per USD, or leave it blank.' };
  }
  if (options.withinBalance && amount > (await paymentState(pool, invoice.id)).dueUsd) {
    return { ok: false, status: 409, error: 'The payment is more than the balance due on this invoice.' };
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO payments (invoice_id, organization_id, amount_usd, paid_on, reference, bank_rate_inr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [invoice.id, user.organizationId, amount, paidOn, reference, bankRate, user.id],
  );
  await refreshPaidStatus(pool, invoice.id);
  return { ok: true, state: await paymentState(pool, invoice.id), paymentId: inserted.rows[0].id };
}

/** Returns null when blank and undefined when the value is not a sensible rupee rate. */
export function parseBankRate(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const rate = Math.round(Number(value) * 10000) / 10000;
  return Number.isFinite(rate) && rate > 0 && rate < 1000 ? rate : undefined;
}

export function registerPaymentRoutes(app: Express, pool: DbPool): void {
  app.get('/api/invoices/:id/payments', requireUser, asyncHandler(async (req, res) => {
    const invoice = await findInvoice(pool, req.params.id, currentUser(res).organizationId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    return res.json(await paymentState(pool, invoice.id));
  }));

  app.post('/api/invoices/:id/payments', requireUser, asyncHandler(async (req, res) => {
    const result = await recordPayment(pool, currentUser(res), req.params.id, req.body ?? {});
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(201).json(result.state);
  }));

  app.patch('/api/invoices/:id/payments/:paymentId', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const invoice = await findInvoice(pool, req.params.id, user.organizationId);
    if (!invoice || !isUuid(req.params.paymentId)) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
    const closed = await closedMonthMessage(pool, user.organizationId, invoice.invoice_date);
    if (closed) return res.status(409).json({ error: closed });
    const bankRate = parseBankRate(req.body?.bankRateInr);
    if (bankRate === undefined) {
      return res.status(400).json({ error: 'Enter the bank exchange rate in rupees per USD, or leave it blank.' });
    }
    const result = await pool.query('UPDATE payments SET bank_rate_inr = $3 WHERE id = $1 AND invoice_id = $2', [
      req.params.paymentId,
      invoice.id,
      bankRate,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
    return res.json(await paymentState(pool, invoice.id));
  }));

  app.delete('/api/invoices/:id/payments/:paymentId', requireAdmin, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const invoice = await findInvoice(pool, req.params.id, user.organizationId);
    if (!invoice || !isUuid(req.params.paymentId)) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
    const closed = await closedMonthMessage(pool, user.organizationId, invoice.invoice_date);
    if (closed) return res.status(409).json({ error: closed });
    const result = await pool.query('DELETE FROM payments WHERE id = $1 AND invoice_id = $2', [
      req.params.paymentId,
      invoice.id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
    await refreshPaidStatus(pool, invoice.id);
    return res.json(await paymentState(pool, invoice.id));
  }));
}
