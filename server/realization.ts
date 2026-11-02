import type { Express } from 'express';
import type { DbPool } from './db.js';
import { asyncHandler, currentUser } from './http.js';
import { findColumn, money, parseAmount, parseCsv, parseLooseDate, taxManager, taxReader, taxSettings } from './taxShared.js';

export const DUE_SOON_DAYS = 30;

type RealizationSource = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  shipped_on: string;
  buyer_name: string;
  destination_country: string;
  total_usd: string;
  paid_usd: string;
  bank_references: string | null;
  days_since_shipment: number;
  deadline: string;
  days_left: number;
  brc_number: string | null;
  brc_date: string | null;
  brc_amount_usd: string | null;
};

export type RealizationFlag = 'overdue' | 'due_soon' | 'open' | 'needs_brc' | 'done';

export async function realizationRows(pool: DbPool, organizationId: string) {
  const settings = await taxSettings(pool, organizationId);
  const result = await pool.query<RealizationSource>(
    `SELECT i.id, i.invoice_number,
            to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date,
            to_char(COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS shipped_on,
            i.buyer_name, i.destination_country, i.total_usd,
            COALESCE(p.paid_usd, 0) AS paid_usd,
            p.bank_references,
            (current_date - COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date))::int AS days_since_shipment,
            to_char((COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date) + make_interval(months => $2))::date, 'YYYY-MM-DD') AS deadline,
            ((COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date) + make_interval(months => $2))::date - current_date)::int AS days_left,
            b.brc_number, to_char(b.realised_on, 'YYYY-MM-DD') AS brc_date, b.amount_usd AS brc_amount_usd
     FROM invoices i
     LEFT JOIN invoice_tax t ON t.invoice_id = i.id
     LEFT JOIN invoice_brcs b ON b.invoice_id = i.id
     LEFT JOIN LATERAL (
       SELECT SUM(amount_usd) AS paid_usd,
              string_agg(NULLIF(btrim(reference), ''), ', ' ORDER BY paid_on) AS bank_references
       FROM payments WHERE invoice_id = i.id
     ) p ON true
     WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid')
     ORDER BY days_left, i.invoice_number
     LIMIT 1000`,
    [organizationId, settings.realizationMonths],
  );
  const rows = result.rows.map((row) => {
    const totalUsd = money(row.total_usd);
    const paidUsd = money(row.paid_usd);
    const dueUsd = Math.max(0, money(totalUsd - paidUsd));
    const bankReferences = row.bank_references ?? '';
    const open = dueUsd > 0 && !row.brc_number;
    const daysLeft = Number(row.days_left);
    let flag: RealizationFlag = 'done';
    if (open && daysLeft < 0) flag = 'overdue';
    else if (open && daysLeft <= DUE_SOON_DAYS) flag = 'due_soon';
    else if (open) flag = 'open';
    else if (!row.brc_number) flag = 'needs_brc';
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      shippedOn: row.shipped_on,
      buyerName: row.buyer_name,
      destinationCountry: row.destination_country,
      totalUsd,
      paidUsd,
      dueUsd,
      bankReferences,
      daysSinceShipment: Number(row.days_since_shipment),
      deadline: row.deadline,
      daysLeft,
      open,
      flag,
      missingReference: paidUsd > 0 && bankReferences === '',
      brcNumber: row.brc_number ?? '',
      brcDate: row.brc_date ?? '',
      brcAmountUsd: row.brc_amount_usd === null ? null : money(row.brc_amount_usd),
    };
  });
  return { settings, rows };
}

export async function realizationSummary(pool: DbPool, organizationId: string) {
  const { settings, rows } = await realizationRows(pool, organizationId);
  const open = rows.filter((row) => row.open);
  return {
    realizationMonths: settings.realizationMonths,
    rows,
    openCount: open.length,
    openUsd: money(open.reduce((sum, row) => sum + row.dueUsd, 0)),
    overdueCount: rows.filter((row) => row.flag === 'overdue').length,
    dueSoonCount: rows.filter((row) => row.flag === 'due_soon').length,
    needsBrcCount: rows.filter((row) => row.flag === 'needs_brc').length,
  };
}

export function registerRealizationRoutes(app: Express, pool: DbPool): void {
  app.get('/api/tax/realization', taxReader, asyncHandler(async (_req, res) => {
    return res.json(await realizationSummary(pool, currentUser(res).organizationId));
  }));

  app.get('/api/tax/settings', taxReader, asyncHandler(async (_req, res) => {
    return res.json(await taxSettings(pool, currentUser(res).organizationId));
  }));

  app.put('/api/tax/settings', taxManager, asyncHandler(async (req, res) => {
    const months = Number(req.body?.realizationMonths);
    if (!Number.isInteger(months) || months < 1 || months > 36) {
      return res.status(400).json({ error: 'The realization period must be between 1 and 36 months.' });
    }
    const lutValidUntil = typeof req.body?.lutValidUntil === 'string' && req.body.lutValidUntil ? req.body.lutValidUntil : null;
    if (lutValidUntil && !parseLooseDate(lutValidUntil)) return res.status(400).json({ error: 'Enter the LUT expiry as YYYY-MM-DD.' });
    const einvoiceRequired = req.body?.einvoiceRequired !== false;
    const organizationId = currentUser(res).organizationId;
    await pool.query(
      `INSERT INTO organization_tax_settings (organization_id, realization_months, lut_valid_until, einvoice_required)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id) DO UPDATE SET
         realization_months = EXCLUDED.realization_months,
         lut_valid_until = EXCLUDED.lut_valid_until,
         einvoice_required = EXCLUDED.einvoice_required,
         updated_at = now()`,
      [organizationId, months, lutValidUntil, einvoiceRequired],
    );
    return res.json(await taxSettings(pool, organizationId));
  }));

  app.post('/api/tax/ebrc/import', taxManager, asyncHandler(async (req, res) => {
    const rows = parseCsv(typeof req.body?.csv === 'string' ? req.body.csv : '');
    if (rows.length < 2) return res.status(400).json({ error: 'Upload the e-BRC CSV with its header row.' });
    const [header, ...lines] = rows;
    const brcColumn = findColumn(header, ['brc number', 'ebrc number', 'e brc number', 'brc no', 'e brc no', 'ebrc no', 'brc']);
    const billColumn = findColumn(header, ['shipping bill number', 'shipping bill no', 'sb number', 'sb no', 'shipping bill']);
    const invoiceColumn = findColumn(header, ['invoice number', 'invoice no', 'invoice']);
    const dateColumn = findColumn(header, ['realisation date', 'realization date', 'brc date', 'date']);
    const amountColumn = findColumn(header, ['realised value', 'realized value', 'realised amount', 'realized amount', 'amount usd', 'amount']);
    if (brcColumn < 0 || dateColumn < 0 || (billColumn < 0 && invoiceColumn < 0)) {
      return res.status(400).json({ error: 'The CSV needs the e-BRC number, realisation date, and a shipping bill or invoice number.' });
    }
    const organizationId = currentUser(res).organizationId;
    let matched = 0;
    const unmatched: string[] = [];
    for (const cells of lines) {
      const brcNumber = (cells[brcColumn] ?? '').trim().slice(0, 60);
      const realisedOn = parseLooseDate(cells[dateColumn]);
      const bill = billColumn >= 0 ? (cells[billColumn] ?? '').trim() : '';
      const invoiceNumber = invoiceColumn >= 0 ? (cells[invoiceColumn] ?? '').trim() : '';
      const label = bill || invoiceNumber || brcNumber || '(blank row)';
      if (!brcNumber || !realisedOn) {
        unmatched.push(label);
        continue;
      }
      const invoice = await pool.query<{ id: string; total_usd: string }>(
        `SELECT i.id, i.total_usd FROM invoices i
         LEFT JOIN invoice_tax t ON t.invoice_id = i.id
         WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid')
           AND (($2 <> '' AND t.shipping_bill_no = $2) OR ($3 <> '' AND upper(i.invoice_number) = upper($3)))
         LIMIT 1`,
        [organizationId, bill, invoiceNumber],
      );
      const found = invoice.rows[0];
      if (!found) {
        unmatched.push(label);
        continue;
      }
      const amount = amountColumn >= 0 ? parseAmount(cells[amountColumn]) : null;
      await pool.query(
        `INSERT INTO invoice_brcs (invoice_id, organization_id, brc_number, realised_on, amount_usd)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (invoice_id) DO UPDATE SET
           brc_number = EXCLUDED.brc_number, realised_on = EXCLUDED.realised_on, amount_usd = EXCLUDED.amount_usd`,
        [found.id, organizationId, brcNumber, realisedOn, amount ?? money(found.total_usd)],
      );
      matched += 1;
    }
    return res.status(201).json({ matched, unmatched });
  }));
}
