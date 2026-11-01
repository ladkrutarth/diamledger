import type { Express } from 'express';
import type { DbPool } from './db.js';
import { asyncHandler, currentUser, requireAdmin, requireUser, isUuid } from './http.js';
import { refreshPaidStatus } from './invoices.js';

type PaymentRow = {
  id: string;
  amount_usd: string;
  paid_on: string;
  reference: string;
  created_at: Date;
};

function toPayment(row: PaymentRow) {
  return {
    id: row.id,
    amountUsd: Number(row.amount_usd),
    paidOn: row.paid_on,
    reference: row.reference,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function findInvoice(pool: DbPool, id: string, organizationId: string) {
  if (!isUuid(id)) return undefined;
  const result = await pool.query<{ id: string; status: string; total_usd: string }>(
    'SELECT id, status, total_usd FROM invoices WHERE id = $1 AND organization_id = $2',
    [id, organizationId],
  );
  return result.rows[0];
}

async function listPayments(pool: DbPool, invoiceId: string) {
  const result = await pool.query<PaymentRow>(
    `SELECT id, amount_usd, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, reference, created_at
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

export function registerPaymentRoutes(app: Express, pool: DbPool): void {
  app.get('/api/invoices/:id/payments', requireUser, asyncHandler(async (req, res) => {
    const invoice = await findInvoice(pool, req.params.id, currentUser(res).organizationId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    return res.json(await paymentState(pool, invoice.id));
  }));

  app.post('/api/invoices/:id/payments', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const invoice = await findInvoice(pool, req.params.id, user.organizationId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    if (invoice.status !== 'issued' && invoice.status !== 'paid') {
      return res.status(409).json({ error: 'Issue the invoice before recording payments.' });
    }

    const amount = Math.round(Number(req.body?.amountUsd) * 100) / 100;
    const paidOn = typeof req.body?.paidOn === 'string' ? req.body.paidOn : '';
    const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim().slice(0, 200) : '';
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e11) {
      return res.status(400).json({ error: 'Enter a payment amount greater than zero.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(paidOn))) {
      return res.status(400).json({ error: 'Enter the date the payment was received.' });
    }

    await pool.query(
      `INSERT INTO payments (invoice_id, organization_id, amount_usd, paid_on, reference, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [invoice.id, user.organizationId, amount, paidOn, reference, user.id],
    );
    await refreshPaidStatus(pool, invoice.id);
    return res.status(201).json(await paymentState(pool, invoice.id));
  }));

  app.delete('/api/invoices/:id/payments/:paymentId', requireAdmin, asyncHandler(async (req, res) => {
    const invoice = await findInvoice(pool, req.params.id, currentUser(res).organizationId);
    if (!invoice || !isUuid(req.params.paymentId)) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
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
