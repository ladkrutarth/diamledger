import type { Express } from 'express';
import type { DbPool } from './db';
import { isUuid, parseInvoice } from './invoiceValidation';
import { requireUser } from './auth';

type InvoiceRow = {
  id: string;
  invoice_number: string;
  updated_at: Date;
  data: unknown;
};

function toSummary(row: Pick<InvoiceRow, 'id' | 'invoice_number' | 'updated_at'>) {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toRecord(row: InvoiceRow) {
  return {
    ...toSummary(row),
    invoice: row.data,
  };
}

export function registerInvoiceRoutes(app: Express, pool: DbPool): void {
  app.get('/api/invoices', requireUser, async (req, res) => {
    const result = await pool.query<InvoiceRow>(
      `SELECT id, invoice_number, updated_at
       FROM invoices
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [req.session.userId],
    );
    return res.json({ invoices: result.rows.map(toSummary) });
  });

  app.post('/api/invoices', requireUser, async (req, res) => {
    const invoice = parseInvoice(req.body?.invoice);
    if (!invoice) {
      return res.status(400).json({ error: 'Invoice data is incomplete.' });
    }

    const result = await pool.query<InvoiceRow>(
      `INSERT INTO invoices (user_id, invoice_number, data)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, invoice_number, updated_at, data`,
      [req.session.userId, invoice.shipment.invoiceNumber.trim(), JSON.stringify(invoice)],
    );
    return res.status(201).json(toRecord(result.rows[0]));
  });

  app.get('/api/invoices/:id', requireUser, async (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    const result = await pool.query<InvoiceRow>(
      `SELECT id, invoice_number, updated_at, data
       FROM invoices
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId],
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    return res.json(toRecord(row));
  });

  app.put('/api/invoices/:id', requireUser, async (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    const invoice = parseInvoice(req.body?.invoice);
    if (!invoice) {
      return res.status(400).json({ error: 'Invoice data is incomplete.' });
    }

    const result = await pool.query<InvoiceRow>(
      `UPDATE invoices
       SET invoice_number = $3,
           data = $4::jsonb,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, invoice_number, updated_at, data`,
      [req.params.id, req.session.userId, invoice.shipment.invoiceNumber.trim(), JSON.stringify(invoice)],
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    return res.json(toRecord(row));
  });

  app.delete('/api/invoices/:id', requireUser, async (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    const result = await pool.query(
      'DELETE FROM invoices WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    return res.status(204).send();
  });
}
