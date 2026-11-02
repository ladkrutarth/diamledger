import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { closedMonthMessage, parseMonth } from './closedMonths.js';
import { asyncHandler, currentUser, isUuid, requireUser } from '../../core/http.js';
import { financialYear } from '../invoices/invoiceValidation.js';
import {
  charteredAccountant,
  csvFile,
  currentMonth,
  invoiceDateOf,
  money,
  monthIsClosed,
  sendZip,
  taxReader,
  taxWriter,
} from './taxShared.js';

const DOCUMENT_KINDS = ['shipping_bill', 'airway_bill', 'lut'] as const;
type DocumentKind = (typeof DOCUMENT_KINDS)[number];
const DOCUMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const MAX_DOCUMENT_BYTES = 1_500_000;

type Scheme = 'lut' | 'igst';

function financialYearRange(token: string): { start: string; end: string; label: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(token);
  if (!match) return null;
  const startYear = Number(match[1]);
  const endShort = Number(match[2]);
  if (endShort !== (startYear + 1) % 100) return null;
  const endYear = startYear + 1;
  return { start: `${startYear}-04-01`, end: `${endYear}-03-31`, label: token };
}

const REGISTER_SQL = `
  SELECT i.id, i.invoice_number,
         to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
         i.buyer_name, i.destination_country, i.status, i.total_usd, i.total_carats,
         COALESCE(t.export_scheme, 'lut') AS export_scheme,
         COALESCE(t.shipping_bill_no, '') AS shipping_bill_no,
         to_char(t.shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date,
         COALESCE(t.igst_usd, 0) AS igst_usd,
         COALESCE(i.data->'shipment'->>'awbNumber', '') AS awb_number,
         COALESCE(i.data->'shipment'->>'lutNumber', '') AS lut_number,
         r.status AS review_status,
         COALESCE(r.comment, '') AS review_comment,
         COALESCE((
           SELECT json_agg(d.kind ORDER BY d.kind) FROM invoice_documents d WHERE d.invoice_id = i.id
         ), '[]'::json) AS documents
  FROM invoices i
  LEFT JOIN invoice_tax t ON t.invoice_id = i.id
  LEFT JOIN invoice_reviews r ON r.invoice_id = i.id
`;

type RegisterRow = {
  id: string;
  invoice_number: string;
  invoice_date: string | null;
  buyer_name: string;
  destination_country: string;
  status: string;
  total_usd: string;
  total_carats: string;
  export_scheme: Scheme;
  shipping_bill_no: string;
  shipping_bill_date: string | null;
  igst_usd: string;
  awb_number: string;
  lut_number: string;
  review_status: 'query' | 'accepted' | null;
  review_comment: string;
  documents: DocumentKind[];
};

function toRegister(row: RegisterRow) {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    buyerName: row.buyer_name,
    destinationCountry: row.destination_country,
    status: row.status,
    taxableUsd: money(row.total_usd),
    totalCarats: Number(row.total_carats),
    exportScheme: row.export_scheme,
    shippingBillNo: row.shipping_bill_no,
    shippingBillDate: row.shipping_bill_date,
    igstUsd: money(row.igst_usd),
    awbNumber: row.awb_number,
    lutNumber: row.lut_number,
    reviewStatus: row.review_status,
    reviewComment: row.review_comment,
    documents: Array.isArray(row.documents) ? row.documents : [],
  };
}

async function registerRows(pool: DbPool, organizationId: string, where: string, params: unknown[]) {
  const result = await pool.query<RegisterRow>(
    `${REGISTER_SQL} WHERE i.organization_id = $1 AND i.status <> 'draft' AND ${where}
     ORDER BY invoice_date, i.invoice_number`,
    params,
  );
  return result.rows.map(toRegister);
}

function isDocumentKind(value: unknown): value is DocumentKind {
  return DOCUMENT_KINDS.includes(value as DocumentKind);
}

export async function exportRegister(pool: DbPool, organizationId: string, month: string) {
  const rows = await registerRows(
    pool,
    organizationId,
    `to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM') = $2`,
    [organizationId, month],
  );
  return {
    month,
    closed: await monthIsClosed(pool, organizationId, month),
    rows,
    totals: {
      count: rows.length,
      taxableUsd: money(rows.reduce((sum, row) => sum + row.taxableUsd, 0)),
      igstUsd: money(rows.reduce((sum, row) => sum + row.igstUsd, 0)),
    },
  };
}

export async function closeMonth(pool: DbPool, organizationId: string, month: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO closed_months (organization_id, month, closed_by)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (organization_id, month) DO NOTHING`,
    [organizationId, `${month}-01`, userId],
  );
}

export function registerTaxRoutes(app: Express, pool: DbPool): void {
  app.get('/api/tax/register', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month) ?? currentMonth();
    return res.json(await exportRegister(pool, currentUser(res).organizationId, month));
  }));

  app.get('/api/tax/gst-pack', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month) ?? currentMonth();
    const user = currentUser(res);
    const rows = await registerRows(
      pool,
      user.organizationId,
      `to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM') = $2`,
      [user.organizationId, month],
    );
    const payments = await pool.query<{
      invoice_number: string;
      paid_on: string;
      amount_usd: string;
      reference: string;
    }>(
      `SELECT i.invoice_number, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd, p.reference
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       WHERE p.organization_id = $1
         AND to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM') = $2
       ORDER BY p.paid_on, i.invoice_number`,
      [user.organizationId, month],
    );
    const registerCsv = csvFile(
      ['Invoice number', 'Invoice date', 'Buyer', 'Country', 'Status', 'Scheme', 'Shipping bill', 'Shipping bill date', 'Taxable USD', 'IGST USD', 'Carats', 'AWB', 'LUT', 'Review'],
      rows.map((row) => [
        row.invoiceNumber, row.invoiceDate, row.buyerName, row.destinationCountry, row.status, row.exportScheme,
        row.shippingBillNo, row.shippingBillDate, row.taxableUsd.toFixed(2), row.igstUsd.toFixed(2),
        row.totalCarats.toFixed(3), row.awbNumber, row.lutNumber, row.reviewStatus ?? '',
      ]),
    );
    const paymentCsv = csvFile(
      ['Invoice number', 'Date received', 'Amount USD', 'Bank reference'],
      payments.rows.map((row) => [row.invoice_number, row.paid_on, money(row.amount_usd).toFixed(2), row.reference]),
    );
    return sendZip(res, `gst-pack-${month}.zip`, [
      { name: 'export-register.csv', data: registerCsv },
      { name: 'payments.csv', data: paymentCsv },
    ]);
  }));

  app.get('/api/tax/year-pack', taxReader, asyncHandler(async (req, res) => {
    const requested = typeof req.query.year === 'string' ? req.query.year : financialYear(new Date());
    const range = financialYearRange(requested);
    if (!range) return res.status(400).json({ error: 'Use a financial year like 2026-27.' });
    const user = currentUser(res);
    const sales = await registerRows(
      pool,
      user.organizationId,
      `COALESCE(i.invoice_date, i.created_at::date) BETWEEN $2::date AND $3::date`,
      [user.organizationId, range.start, range.end],
    );
    const receipts = await pool.query<{
      invoice_number: string;
      paid_on: string;
      amount_usd: string;
      reference: string;
      buyer_name: string;
    }>(
      `SELECT i.invoice_number, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd, p.reference, i.buyer_name
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       WHERE p.organization_id = $1 AND p.paid_on BETWEEN $2::date AND $3::date
       ORDER BY p.paid_on, i.invoice_number`,
      [user.organizationId, range.start, range.end],
    );
    const outstanding = await pool.query<{
      invoice_number: string;
      invoice_date: string | null;
      buyer_name: string;
      total_usd: string;
      paid_usd: string;
    }>(
      `SELECT i.invoice_number,
              to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
              i.buyer_name, i.total_usd,
              COALESCE((SELECT SUM(amount_usd) FROM payments WHERE invoice_id = i.id), 0) AS paid_usd
       FROM invoices i
       WHERE i.organization_id = $1 AND i.status = 'issued'
         AND COALESCE(i.invoice_date, i.created_at::date) <= $2::date
       ORDER BY invoice_date, i.invoice_number`,
      [user.organizationId, range.end],
    );
    const openRows = outstanding.rows
      .map((row) => ({ ...row, due: money(money(row.total_usd) - money(row.paid_usd)) }))
      .filter((row) => row.due > 0);
    return sendZip(res, `year-pack-${range.label}.zip`, [
      {
        name: 'sales-register.csv',
        data: csvFile(
          ['Invoice number', 'Invoice date', 'Buyer', 'Country', 'Status', 'Scheme', 'Taxable USD', 'IGST USD'],
          sales.map((row) => [
            row.invoiceNumber, row.invoiceDate, row.buyerName, row.destinationCountry, row.status,
            row.exportScheme, row.taxableUsd.toFixed(2), row.igstUsd.toFixed(2),
          ]),
        ),
      },
      {
        name: 'receipts.csv',
        data: csvFile(
          ['Invoice number', 'Buyer', 'Date received', 'Amount USD', 'Bank reference'],
          receipts.rows.map((row) => [row.invoice_number, row.buyer_name, row.paid_on, money(row.amount_usd).toFixed(2), row.reference]),
        ),
      },
      {
        name: 'outstanding.csv',
        data: csvFile(
          ['Invoice number', 'Invoice date', 'Buyer', 'Total USD', 'Received USD', 'Balance USD'],
          openRows.map((row) => [
            row.invoice_number, row.invoice_date, row.buyer_name, money(row.total_usd).toFixed(2), money(row.paid_usd).toFixed(2), row.due.toFixed(2),
          ]),
        ),
      },
      {
        name: 'cancelled.csv',
        data: csvFile(
          ['Invoice number', 'Invoice date', 'Buyer', 'Country', 'Taxable USD'],
          sales.filter((row) => row.status === 'cancelled').map((row) => [
            row.invoiceNumber, row.invoiceDate, row.buyerName, row.destinationCountry, row.taxableUsd.toFixed(2),
          ]),
        ),
      },
    ]);
  }));

  app.get('/api/tax/months', taxReader, asyncHandler(async (_req, res) => {
    const user = currentUser(res);
    const result = await pool.query<{ month: string; closed_at: Date; email: string | null }>(
      `SELECT to_char(c.month, 'YYYY-MM') AS month, c.closed_at, u.email
       FROM closed_months c
       LEFT JOIN users u ON u.id = c.closed_by
       WHERE c.organization_id = $1
       ORDER BY c.month DESC`,
      [user.organizationId],
    );
    return res.json({
      financialYear: financialYear(new Date()),
      months: result.rows.map((row) => ({
        month: row.month,
        closedAt: new Date(row.closed_at).toISOString(),
        closedBy: row.email,
      })),
    });
  }));

  app.post('/api/tax/months/:month/close', charteredAccountant, asyncHandler(async (req, res) => {
    const month = parseMonth(req.params.month);
    if (!month) return res.status(400).json({ error: 'Choose a month like 2026-10.' });
    const user = currentUser(res);
    await closeMonth(pool, user.organizationId, month, user.id);
    return res.json({ month, closed: true });
  }));

  app.post('/api/tax/months/:month/open', charteredAccountant, asyncHandler(async (req, res) => {
    const month = parseMonth(req.params.month);
    if (!month) return res.status(400).json({ error: 'Choose a month like 2026-10.' });
    await pool.query('DELETE FROM closed_months WHERE organization_id = $1 AND month = $2::date', [
      currentUser(res).organizationId,
      `${month}-01`,
    ]);
    return res.json({ month, closed: false });
  }));

  app.get('/api/invoices/:id/tax', requireUser, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Invoice not found.' });
    const user = currentUser(res);
    const invoice = await pool.query<{ invoice_date: string | null }>(
      `SELECT to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date
       FROM invoices WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!invoice.rows[0]) return res.status(404).json({ error: 'Invoice not found.' });
    const tax = await pool.query<{
      export_scheme: Scheme;
      shipping_bill_no: string;
      shipping_bill_date: string | null;
      igst_usd: string;
      port_code: string;
      sb_invoice_number: string;
      sb_value_usd: string | null;
    }>(
      `SELECT export_scheme, shipping_bill_no, to_char(shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date, igst_usd,
              port_code, sb_invoice_number, sb_value_usd
       FROM invoice_tax WHERE invoice_id = $1`,
      [req.params.id],
    );
    const einvoice = await pool.query<{ irn: string; ack_no: string; ack_date: string | null }>(
      `SELECT irn, ack_no, to_char(ack_date, 'YYYY-MM-DD') AS ack_date FROM invoice_einvoices WHERE invoice_id = $1`,
      [req.params.id],
    );
    const documents = await pool.query<{
      id: string;
      kind: DocumentKind;
      file_name: string;
      content_type: string;
      byte_size: number;
      created_at: Date;
    }>(
      `SELECT id, kind, file_name, content_type, byte_size, created_at
       FROM invoice_documents WHERE invoice_id = $1 ORDER BY kind`,
      [req.params.id],
    );
    const review = await pool.query<{ status: 'query' | 'accepted'; comment: string; updated_at: Date }>(
      'SELECT status, comment, updated_at FROM invoice_reviews WHERE invoice_id = $1',
      [req.params.id],
    );
    const saved = tax.rows[0];
    const month = monthOfDate(invoice.rows[0].invoice_date);
    return res.json({
      exportScheme: saved?.export_scheme ?? 'lut',
      shippingBillNo: saved?.shipping_bill_no ?? '',
      shippingBillDate: saved?.shipping_bill_date ?? '',
      igstUsd: saved ? money(saved.igst_usd) : 0,
      portCode: saved?.port_code ?? '',
      sbInvoiceNumber: saved?.sb_invoice_number ?? '',
      sbValueUsd: saved?.sb_value_usd === null || saved?.sb_value_usd === undefined ? null : money(saved.sb_value_usd),
      einvoice: einvoice.rows[0]
        ? { irn: einvoice.rows[0].irn, ackNo: einvoice.rows[0].ack_no, ackDate: einvoice.rows[0].ack_date ?? '' }
        : null,
      month,
      monthClosed: month ? await monthIsClosed(pool, user.organizationId, month) : false,
      documents: documents.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        fileName: row.file_name,
        contentType: row.content_type,
        byteSize: row.byte_size,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      review: review.rows[0]
        ? {
            status: review.rows[0].status,
            comment: review.rows[0].comment,
            updatedAt: new Date(review.rows[0].updated_at).toISOString(),
          }
        : null,
    });
  }));

  app.put('/api/invoices/:id/tax', taxWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Invoice not found.' });
    const user = currentUser(res);
    const invoice = await pool.query<{ invoice_date: string | null }>(
      `SELECT to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date
       FROM invoices WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!invoice.rows[0]) return res.status(404).json({ error: 'Invoice not found.' });
    const closed = await closedMonthMessage(pool, user.organizationId, invoice.rows[0].invoice_date);
    if (closed) return res.status(409).json({ error: closed });

    const scheme: Scheme = req.body?.exportScheme === 'igst' ? 'igst' : 'lut';
    const shippingBillNo = typeof req.body?.shippingBillNo === 'string' ? req.body.shippingBillNo.trim().slice(0, 80) : '';
    const shippingBillDate = typeof req.body?.shippingBillDate === 'string' ? req.body.shippingBillDate : '';
    if (shippingBillDate && !/^\d{4}-\d{2}-\d{2}$/.test(shippingBillDate)) {
      return res.status(400).json({ error: 'Enter the shipping bill date as YYYY-MM-DD.' });
    }
    const igstUsd = scheme === 'igst' ? money(req.body?.igstUsd) : 0;
    if (!Number.isFinite(igstUsd) || igstUsd < 0 || igstUsd > 1e11) {
      return res.status(400).json({ error: 'Enter the IGST amount in USD.' });
    }
    const portCode = typeof req.body?.portCode === 'string' ? req.body.portCode.trim().toUpperCase().slice(0, 6) : '';
    if (portCode && !/^[A-Z0-9]{6}$/.test(portCode)) {
      return res.status(400).json({ error: 'Enter the six-character port code from the shipping bill, like INBOM4.' });
    }
    const sbInvoiceNumber = typeof req.body?.sbInvoiceNumber === 'string' ? req.body.sbInvoiceNumber.trim().slice(0, 40) : '';
    const rawValue = req.body?.sbValueUsd;
    const sbValueUsd = rawValue === null || rawValue === undefined || rawValue === '' ? null : money(rawValue);
    if (sbValueUsd !== null && (!Number.isFinite(sbValueUsd) || sbValueUsd < 0 || sbValueUsd > 1e11)) {
      return res.status(400).json({ error: 'Enter the shipping bill value in USD.' });
    }
    await pool.query(
      `INSERT INTO invoice_tax (invoice_id, organization_id, export_scheme, shipping_bill_no, shipping_bill_date, igst_usd,
                                port_code, sb_invoice_number, sb_value_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (invoice_id) DO UPDATE SET
         export_scheme = EXCLUDED.export_scheme,
         shipping_bill_no = EXCLUDED.shipping_bill_no,
         shipping_bill_date = EXCLUDED.shipping_bill_date,
         igst_usd = EXCLUDED.igst_usd,
         port_code = EXCLUDED.port_code,
         sb_invoice_number = EXCLUDED.sb_invoice_number,
         sb_value_usd = EXCLUDED.sb_value_usd`,
      [req.params.id, user.organizationId, scheme, shippingBillNo, shippingBillDate || null, igstUsd, portCode, sbInvoiceNumber, sbValueUsd],
    );
    return res.json({ exportScheme: scheme, shippingBillNo, shippingBillDate, igstUsd, portCode, sbInvoiceNumber, sbValueUsd });
  }));

  app.post('/api/invoices/:id/documents', taxWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Invoice not found.' });
    const user = currentUser(res);
    const invoice = await pool.query<{ invoice_date: string | null }>(
      `SELECT to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date
       FROM invoices WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!invoice.rows[0]) return res.status(404).json({ error: 'Invoice not found.' });
    const closed = await closedMonthMessage(pool, user.organizationId, invoice.rows[0].invoice_date);
    if (closed) return res.status(409).json({ error: closed });
    if (!isDocumentKind(req.body?.kind)) return res.status(400).json({ error: 'Choose a shipping bill, airway bill, or LUT.' });
    const contentType = typeof req.body?.contentType === 'string' ? req.body.contentType : '';
    if (!DOCUMENT_TYPES.has(contentType)) return res.status(400).json({ error: 'Upload a PDF, JPEG, or PNG.' });
    const encoded = typeof req.body?.dataBase64 === 'string' ? req.body.dataBase64.replace(/^data:[^,]+,/, '') : '';
    const content = Buffer.from(encoded, 'base64');
    if (!content.length || content.length > MAX_DOCUMENT_BYTES) {
      return res.status(400).json({ error: 'The file must be a PDF or image under 1.5 MB.' });
    }
    const fileName = (typeof req.body?.fileName === 'string' ? req.body.fileName : 'document')
      .split(/[/\\]/)
      .pop()
      ?.replace(/[^\w.\- ()]+/g, '')
      .slice(0, 180) || 'document';
    const saved = await pool.query<{ id: string }>(
      `INSERT INTO invoice_documents (invoice_id, organization_id, kind, file_name, content_type, byte_size, content, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (invoice_id, kind) DO UPDATE SET
         file_name = EXCLUDED.file_name,
         content_type = EXCLUDED.content_type,
         byte_size = EXCLUDED.byte_size,
         content = EXCLUDED.content,
         uploaded_by = EXCLUDED.uploaded_by,
         created_at = now()
       RETURNING id`,
      [req.params.id, user.organizationId, req.body.kind, fileName, contentType, content.length, content, user.id],
    );
    return res.status(201).json({ id: saved.rows[0].id, kind: req.body.kind, fileName, byteSize: content.length });
  }));

  app.get('/api/invoices/:id/documents/:docId', requireUser, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id) || !isUuid(req.params.docId)) return res.status(404).json({ error: 'Document not found.' });
    const result = await pool.query<{ file_name: string; content_type: string; content: Buffer }>(
      `SELECT file_name, content_type, content
       FROM invoice_documents WHERE id = $1 AND invoice_id = $2 AND organization_id = $3`,
      [req.params.docId, req.params.id, currentUser(res).organizationId],
    );
    const file = result.rows[0];
    if (!file) return res.status(404).json({ error: 'Document not found.' });
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name.replace(/"/g, '')}"`);
    return res.send(file.content);
  }));

  app.delete('/api/invoices/:id/documents/:docId', taxWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id) || !isUuid(req.params.docId)) return res.status(404).json({ error: 'Document not found.' });
    const user = currentUser(res);
    const invoice = await pool.query<{ invoice_date: string | null }>(
      `SELECT to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date
       FROM invoices WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!invoice.rows[0]) return res.status(404).json({ error: 'Invoice not found.' });
    const closed = await closedMonthMessage(pool, user.organizationId, invoice.rows[0].invoice_date);
    if (closed) return res.status(409).json({ error: closed });
    const result = await pool.query(
      'DELETE FROM invoice_documents WHERE id = $1 AND invoice_id = $2 AND organization_id = $3',
      [req.params.docId, req.params.id, user.organizationId],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Document not found.' });
    return res.status(204).send();
  }));

  app.put('/api/invoices/:id/review', charteredAccountant, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Invoice not found.' });
    const status = req.body?.status;
    if (status !== 'query' && status !== 'accepted') {
      return res.status(400).json({ error: 'Mark the invoice as a query or accepted.' });
    }
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 2000) : '';
    if (status === 'query' && !comment) return res.status(400).json({ error: 'Write what the team needs to fix.' });
    const user = currentUser(res);
    const invoice = await pool.query('SELECT 1 FROM invoices WHERE id = $1 AND organization_id = $2', [
      req.params.id,
      user.organizationId,
    ]);
    if (invoice.rowCount === 0) return res.status(404).json({ error: 'Invoice not found.' });
    await pool.query(
      `INSERT INTO invoice_reviews (invoice_id, organization_id, status, comment, reviewed_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (invoice_id) DO UPDATE SET
         status = EXCLUDED.status,
         comment = EXCLUDED.comment,
         reviewed_by = EXCLUDED.reviewed_by,
         updated_at = now()`,
      [req.params.id, user.organizationId, status, comment, user.id],
    );
    return res.json({ status, comment });
  }));
}

function monthOfDate(invoiceDate: string | null): string | null {
  return parseMonth(invoiceDate?.slice(0, 7));
}
