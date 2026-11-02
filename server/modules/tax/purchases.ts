import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { closedMonthMessage, parseMonth } from './closedMonths.js';
import { monthRange } from './exportReports.js';
import { FormError, documentKey, formReader } from '../../core/formInput.js';
import { asyncHandler, currentUser, isUuid, requireUser } from '../../core/http.js';
import { csvFile, findColumn, money, parseAmount, parseCsv, parseLooseDate, taxManager, taxReader, taxWriter } from './taxShared.js';

const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
const MAX_2B_ROWS = 5000;

export type PurchaseKind = 'import' | 'local';

type PurchaseRow = {
  id: string; kind: PurchaseKind; supplier_name: string; supplier_gstin: string; supplier_country: string; document_no: string;
  document_date: string; port_code: string; description: string; carats: string; parcel_id: string; taxable_inr: string;
  igst_inr: string; cgst_inr: string; sgst_inr: string; related_party: boolean; notes: string;
};

function toPurchase(row: PurchaseRow) {
  const igstInr = money(row.igst_inr);
  const cgstInr = money(row.cgst_inr);
  const sgstInr = money(row.sgst_inr);
  return {
    id: row.id,
    kind: row.kind,
    supplierName: row.supplier_name,
    supplierGstin: row.supplier_gstin,
    supplierCountry: row.supplier_country,
    documentNo: row.document_no,
    documentDate: row.document_date,
    portCode: row.port_code,
    description: row.description,
    carats: Number(row.carats),
    parcelId: row.parcel_id,
    taxableInr: money(row.taxable_inr),
    igstInr,
    cgstInr,
    sgstInr,
    taxInr: money(igstInr + cgstInr + sgstInr),
    relatedParty: row.related_party,
    notes: row.notes,
  };
}

export type Purchase = ReturnType<typeof toPurchase>;

const PURCHASE_COLUMNS = `id, kind, supplier_name, supplier_gstin, supplier_country, document_no,
  to_char(document_date, 'YYYY-MM-DD') AS document_date, port_code, description, carats, parcel_id, taxable_inr,
  igst_inr, cgst_inr, sgst_inr, related_party, notes`;

export async function purchasesBetween(pool: DbPool, organizationId: string, start: string, end: string): Promise<Purchase[]> {
  const result = await pool.query<PurchaseRow>(
    `SELECT ${PURCHASE_COLUMNS} FROM purchases
     WHERE organization_id = $1 AND document_date BETWEEN $2 AND $3
     ORDER BY document_date, supplier_name, document_no`,
    [organizationId, start, end],
  );
  return result.rows.map(toPurchase);
}

function readPurchase(body: unknown) {
  const form = formReader(body);
  const kind = form.choice<PurchaseKind>('kind', ['import', 'local']);
  const supplierName = form.required('supplierName', 'Enter the supplier name.', 200);
  const supplierGstin = form.text('supplierGstin', 15).toUpperCase();
  if (kind === 'local' && supplierGstin && !GSTIN.test(supplierGstin)) {
    throw new FormError('The supplier GSTIN should be 15 characters, like 24ABCDE1234F1Z5.');
  }
  const documentNo = form.required('documentNo', kind === 'import' ? 'Enter the Bill of Entry number.' : 'Enter the supplier invoice number.', 50);
  const documentDate = form.date('documentDate', 'Enter the document date as YYYY-MM-DD.') as string;
  const taxableInr = form.number('taxableInr', 'Enter the taxable (assessable) value in rupees.', { min: 0 }) as number;
  const igstInr = form.number('igstInr', 'IGST must be zero or more.', { min: 0, optional: true }) ?? 0;
  const cgstInr = form.number('cgstInr', 'CGST must be zero or more.', { min: 0, optional: true }) ?? 0;
  const sgstInr = form.number('sgstInr', 'SGST must be zero or more.', { min: 0, optional: true }) ?? 0;
  const carats = form.number('carats', 'Carats must be zero or more.', { min: 0, optional: true, places: 3 }) ?? 0;
  return {
    kind,
    supplierName,
    supplierGstin: kind === 'import' ? '' : supplierGstin,
    supplierCountry: form.text('supplierCountry', 100),
    documentNo,
    documentDate,
    portCode: form.text('portCode', 20).toUpperCase(),
    description: form.text('description', 300),
    carats,
    parcelId: form.text('parcelId', 100),
    taxableInr,
    igstInr,
    cgstInr: kind === 'import' ? 0 : cgstInr,
    sgstInr: kind === 'import' ? 0 : sgstInr,
    relatedParty: form.flag('relatedParty'),
    notes: form.text('notes', 500),
  };
}

// ---------- GSTR-2B ----------

type Gstr2bInput = {
  section: 'b2b' | 'impg';
  supplierGstin: string;
  supplierName: string;
  documentNo: string;
  documentDate: string | null;
  taxableInr: number;
  igstInr: number;
  cgstInr: number;
  sgstInr: number;
  itcAvailable: boolean;
};

/** Reads the B2B and import (IMPG) tables of a GSTR-2B download saved as CSV. */
export function parseGstr2bCsv(text: string): { lines: Gstr2bInput[]; skipped: number } | string {
  const rows = parseCsv(text);
  if (rows.length < 2) return 'Upload the GSTR-2B as CSV with a header row and at least one line.';
  if (rows.length > MAX_2B_ROWS + 1) return `Import at most ${MAX_2B_ROWS} lines at a time.`;
  const [header, ...lines] = rows;
  const col = (names: string[]) => findColumn(header, names);
  const gstin = col(['gstin of supplier', 'supplier gstin', 'gstin', 'ctin']);
  const name = col(['trade legal name', 'trade name', 'legal name', 'supplier name', 'name of supplier']);
  const invoice = col(['invoice number', 'invoice no', 'document number', 'inum']);
  const boe = col(['bill of entry number', 'bill of entry no', 'boe number', 'boe no']);
  const dateCol = col(['invoice date', 'bill of entry date', 'boe date', 'document date', 'date']);
  const taxable = col(['taxable value', 'taxable value rs', 'taxable value inr', 'assessable value', 'txval']);
  const igst = col(['integrated tax', 'igst', 'integrated tax rs', 'iamt']);
  const cgst = col(['central tax', 'cgst', 'central tax rs', 'camt']);
  const sgst = col(['state ut tax', 'state tax', 'sgst', 'state ut tax rs', 'samt']);
  const available = col(['itc availability', 'itc available', 'eligibility']);
  const sectionCol = col(['section', 'table', 'type']);
  if ((invoice < 0 && boe < 0) || taxable < 0) {
    return 'The CSV needs an invoice number (or bill of entry number) column and a taxable value column.';
  }
  const parsed: Gstr2bInput[] = [];
  let skipped = 0;
  for (const cells of lines) {
    const cell = (index: number) => (index >= 0 ? (cells[index] ?? '').trim() : '');
    const supplierGstin = cell(gstin).toUpperCase();
    const sectionText = cell(sectionCol).toLowerCase();
    const documentNo = cell(invoice) || cell(boe);
    const section: 'b2b' | 'impg' =
      sectionText.includes('imp') || (!supplierGstin && Boolean(cell(boe))) ? 'impg' : 'b2b';
    const taxableInr = parseAmount(cell(taxable).replace(/₹/g, ''));
    if (!documentNo || taxableInr === null) {
      skipped += 1;
      continue;
    }
    const amount = (index: number) => parseAmount(cell(index).replace(/₹/g, '')) ?? 0;
    parsed.push({
      section,
      supplierGstin: section === 'impg' ? '' : supplierGstin,
      supplierName: cell(name).slice(0, 200),
      documentNo: documentNo.slice(0, 50),
      documentDate: parseLooseDate(cell(dateCol)),
      taxableInr,
      igstInr: amount(igst),
      cgstInr: amount(cgst),
      sgstInr: amount(sgst),
      itcAvailable: !/^\s*no/i.test(cell(available)),
    });
  }
  return { lines: parsed, skipped };
}

export function purchaseMatchKey(kind: PurchaseKind | 'b2b' | 'impg', gstin: string, documentNo: string): string {
  const imported = kind === 'import' || kind === 'impg';
  return imported ? `impg|${documentKey(documentNo)}` : `b2b|${gstin.toUpperCase()}|${documentKey(documentNo)}`;
}

export type ItcStatus = 'matched' | 'mismatch' | 'missing_in_2b' | 'not_in_books' | 'itc_blocked';

function monthEnd(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`;
}

/**
 * Compares purchase invoices in the books with GSTR-2B. A purchase is matched against 2B lines from its
 * own month or any later month up to the one asked for, because suppliers sometimes file late.
 */
export async function itcMatch(pool: DbPool, organizationId: string, month: string) {
  const end = monthEnd(month);
  const [purchasesResult, linesResult, importedMonths] = await Promise.all([
    pool.query<PurchaseRow>(
      `SELECT ${PURCHASE_COLUMNS} FROM purchases
       WHERE organization_id = $1 AND document_date <= $2 AND document_date >= ($3::date - interval '12 months')`,
      [organizationId, end, `${month}-01`],
    ),
    pool.query<{
      id: string; month: string; section: 'b2b' | 'impg'; supplier_gstin: string; supplier_name: string; document_no: string;
      document_date: string | null; taxable_inr: string; igst_inr: string; cgst_inr: string; sgst_inr: string; itc_available: boolean;
    }>(
      `SELECT id, to_char(month, 'YYYY-MM') AS month, section, supplier_gstin, supplier_name, document_no,
              to_char(document_date, 'YYYY-MM-DD') AS document_date, taxable_inr, igst_inr, cgst_inr, sgst_inr, itc_available
       FROM gstr2b_lines WHERE organization_id = $1 AND month <= $2::date AND month >= ($2::date - interval '12 months')`,
      [organizationId, `${month}-01`],
    ),
    pool.query<{ month: string }>(
      `SELECT DISTINCT to_char(month, 'YYYY-MM') AS month FROM gstr2b_lines WHERE organization_id = $1 ORDER BY 1 DESC LIMIT 24`,
      [organizationId],
    ),
  ]);

  const purchases = purchasesResult.rows.map(toPurchase);
  const lines = linesResult.rows.map((row) => ({
    id: row.id,
    month: row.month,
    section: row.section,
    supplierGstin: row.supplier_gstin,
    supplierName: row.supplier_name,
    documentNo: row.document_no,
    documentDate: row.document_date,
    taxableInr: money(row.taxable_inr),
    taxInr: money(Number(row.igst_inr) + Number(row.cgst_inr) + Number(row.sgst_inr)),
    itcAvailable: row.itc_available,
  }));
  const linesByKey = new Map<string, typeof lines>();
  for (const line of lines) {
    const key = purchaseMatchKey(line.section, line.supplierGstin, line.documentNo);
    linesByKey.set(key, [...(linesByKey.get(key) ?? []), line]);
  }
  const purchaseKeys = new Set(purchases.map((purchase) => purchaseMatchKey(purchase.kind, purchase.supplierGstin, purchase.documentNo)));

  type Row = {
    status: ItcStatus;
    detail: string;
    purchaseId: string | null;
    supplierName: string;
    supplierGstin: string;
    documentNo: string;
    documentDate: string | null;
    kind: PurchaseKind;
    booksTaxInr: number | null;
    gstr2bTaxInr: number | null;
    gstr2bMonth: string | null;
  };
  const rows: Row[] = [];

  for (const purchase of purchases.filter((entry) => entry.documentDate.slice(0, 7) === month)) {
    const found = linesByKey.get(purchaseMatchKey(purchase.kind, purchase.supplierGstin, purchase.documentNo)) ?? [];
    const base = {
      purchaseId: purchase.id,
      supplierName: purchase.supplierName,
      supplierGstin: purchase.supplierGstin,
      documentNo: purchase.documentNo,
      documentDate: purchase.documentDate,
      kind: purchase.kind,
      booksTaxInr: purchase.taxInr,
    };
    if (!found.length) {
      rows.push({
        ...base,
        status: 'missing_in_2b',
        detail: purchase.kind === 'import'
          ? 'Bill of Entry not in GSTR-2B (IMPG) yet. Check the port code and BoE number with the customs broker.'
          : 'Supplier has not reported this invoice in GSTR-1 yet. Ask them to file it, or the credit cannot be claimed.',
        gstr2bTaxInr: null,
        gstr2bMonth: null,
      });
      continue;
    }
    const taxIn2b = money(found.reduce((sum, line) => sum + line.taxInr, 0));
    const blocked = found.every((line) => !line.itcAvailable);
    const differs = Math.abs(taxIn2b - purchase.taxInr) > 1;
    rows.push({
      ...base,
      status: blocked ? 'itc_blocked' : differs ? 'mismatch' : 'matched',
      detail: blocked
        ? 'GSTR-2B marks this credit as not available.'
        : differs
          ? `Tax in the books is ₹${purchase.taxInr.toFixed(2)} but GSTR-2B shows ₹${taxIn2b.toFixed(2)}.`
          : '',
      gstr2bTaxInr: taxIn2b,
      gstr2bMonth: found[0].month,
    });
  }

  for (const line of lines.filter((entry) => entry.month === month)) {
    if (purchaseKeys.has(purchaseMatchKey(line.section, line.supplierGstin, line.documentNo))) continue;
    rows.push({
      status: 'not_in_books',
      detail: line.itcAvailable
        ? 'In GSTR-2B but not recorded as a purchase. Record it to claim the credit, or tell the supplier it is not yours.'
        : 'In GSTR-2B (credit not available) but not recorded as a purchase.',
      purchaseId: null,
      supplierName: line.supplierName,
      supplierGstin: line.supplierGstin,
      documentNo: line.documentNo,
      documentDate: line.documentDate,
      kind: line.section === 'impg' ? 'import' : 'local',
      booksTaxInr: null,
      gstr2bTaxInr: line.taxInr,
      gstr2bMonth: line.month,
    });
  }

  const order: Record<ItcStatus, number> = { not_in_books: 0, missing_in_2b: 1, mismatch: 2, itc_blocked: 3, matched: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || a.supplierName.localeCompare(b.supplierName));
  const sum = (filter: (row: Row) => boolean, pick: (row: Row) => number | null) =>
    money(rows.filter(filter).reduce((total, row) => total + (pick(row) ?? 0), 0));

  return {
    month,
    gstr2bImported: lines.some((line) => line.month === month),
    importedMonths: importedMonths.rows.map((row) => row.month),
    rows,
    totals: {
      booksItcInr: sum((row) => row.purchaseId !== null, (row) => row.booksTaxInr),
      gstr2bItcInr: money(lines.filter((line) => line.month === month && line.itcAvailable).reduce((total, line) => total + line.taxInr, 0)),
      matchedItcInr: sum((row) => row.status === 'matched', (row) => row.booksTaxInr),
      atRiskItcInr: sum((row) => row.status === 'missing_in_2b' || row.status === 'itc_blocked', (row) => row.booksTaxInr),
      unclaimedItcInr: sum((row) => row.status === 'not_in_books', (row) => row.gstr2bTaxInr),
      mismatches: rows.filter((row) => row.status === 'mismatch').length,
    },
  };
}

/** Purchase totals for the tax audit pack. */
export async function purchaseSummary(pool: DbPool, organizationId: string, start: string, end: string) {
  const purchases = await purchasesBetween(pool, organizationId, start, end);
  const group = (filter: (purchase: Purchase) => boolean) => {
    const chosen = purchases.filter(filter);
    return {
      count: chosen.length,
      taxableInr: money(chosen.reduce((sum, purchase) => sum + purchase.taxableInr, 0)),
      taxInr: money(chosen.reduce((sum, purchase) => sum + purchase.taxInr, 0)),
      carats: Math.round(chosen.reduce((sum, purchase) => sum + purchase.carats, 0) * 1000) / 1000,
    };
  };
  return {
    purchases,
    imports: group((purchase) => purchase.kind === 'import'),
    registered: group((purchase) => purchase.kind === 'local' && Boolean(purchase.supplierGstin)),
    unregistered: group((purchase) => purchase.kind === 'local' && !purchase.supplierGstin),
    relatedParty: group((purchase) => purchase.relatedParty),
    total: group(() => true),
  };
}

export function purchaseCsv(purchases: Purchase[]): Buffer {
  return csvFile(
    ['Type', 'Supplier', 'Supplier GSTIN', 'Country', 'Invoice / BoE no', 'Date', 'Port code', 'Description', 'Carats', 'Parcel',
      'Taxable INR', 'IGST INR', 'CGST INR', 'SGST INR', 'Total tax INR', 'Related party', 'Notes'],
    purchases.map((purchase) => [
      purchase.kind === 'import' ? 'Import' : 'Local', purchase.supplierName, purchase.supplierGstin, purchase.supplierCountry,
      purchase.documentNo, purchase.documentDate, purchase.portCode, purchase.description, purchase.carats.toFixed(3), purchase.parcelId,
      purchase.taxableInr.toFixed(2), purchase.igstInr.toFixed(2), purchase.cgstInr.toFixed(2), purchase.sgstInr.toFixed(2),
      purchase.taxInr.toFixed(2), purchase.relatedParty ? 'Yes' : 'No', purchase.notes,
    ]),
  );
}

async function closedMessage(pool: DbPool, organizationId: string, documentDate: string | null | undefined) {
  const message = await closedMonthMessage(pool, organizationId, documentDate);
  return message?.replace('this invoice', 'this purchase') ?? null;
}

export function registerPurchaseRoutes(app: Express, pool: DbPool): void {
  app.get('/api/purchases', requireUser, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    const purchases = await purchasesBetween(pool, currentUser(res).organizationId, range.start, range.end);
    return res.json({
      from: range.from,
      to: range.to,
      purchases,
      totals: {
        taxableInr: money(purchases.reduce((sum, purchase) => sum + purchase.taxableInr, 0)),
        taxInr: money(purchases.reduce((sum, purchase) => sum + purchase.taxInr, 0)),
        carats: Math.round(purchases.reduce((sum, purchase) => sum + purchase.carats, 0) * 1000) / 1000,
      },
    });
  }));

  app.get('/api/purchases/csv', requireUser, asyncHandler(async (req, res) => {
    const range = monthRange(req);
    const purchases = await purchasesBetween(pool, currentUser(res).organizationId, range.start, range.end);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="purchase-register-${range.from}-to-${range.to}.csv"`);
    return res.send(purchaseCsv(purchases));
  }));

  app.post('/api/purchases', taxWriter, asyncHandler(async (req, res) => {
    const input = readPurchase(req.body);
    const user = currentUser(res);
    const closed = await closedMessage(pool, user.organizationId, input.documentDate);
    if (closed) return res.status(409).json({ error: closed });
    try {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO purchases (organization_id, kind, supplier_name, supplier_gstin, supplier_country, document_no, document_date,
           port_code, description, carats, parcel_id, taxable_inr, igst_inr, cgst_inr, sgst_inr, related_party, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
        [user.organizationId, input.kind, input.supplierName, input.supplierGstin, input.supplierCountry, input.documentNo,
          input.documentDate, input.portCode, input.description, input.carats, input.parcelId, input.taxableInr, input.igstInr,
          input.cgstInr, input.sgstInr, input.relatedParty, input.notes, user.id],
      );
      return res.status(201).json({ id: inserted.rows[0].id });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return res.status(409).json({ error: `${input.documentNo} from this supplier is already recorded.` });
      }
      throw error;
    }
  }));

  app.put('/api/purchases/:id', taxWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Purchase not found.' });
    const input = readPurchase(req.body);
    const user = currentUser(res);
    const existing = await pool.query<{ document_date: string }>(
      `SELECT to_char(document_date, 'YYYY-MM-DD') AS document_date FROM purchases WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Purchase not found.' });
    const closed = (await closedMessage(pool, user.organizationId, existing.rows[0].document_date))
      ?? (await closedMessage(pool, user.organizationId, input.documentDate));
    if (closed) return res.status(409).json({ error: closed });
    try {
      await pool.query(
        `UPDATE purchases SET kind = $3, supplier_name = $4, supplier_gstin = $5, supplier_country = $6, document_no = $7,
           document_date = $8, port_code = $9, description = $10, carats = $11, parcel_id = $12, taxable_inr = $13, igst_inr = $14,
           cgst_inr = $15, sgst_inr = $16, related_party = $17, notes = $18, updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.organizationId, input.kind, input.supplierName, input.supplierGstin, input.supplierCountry,
          input.documentNo, input.documentDate, input.portCode, input.description, input.carats, input.parcelId, input.taxableInr,
          input.igstInr, input.cgstInr, input.sgstInr, input.relatedParty, input.notes],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return res.status(409).json({ error: `${input.documentNo} from this supplier is already recorded.` });
      }
      throw error;
    }
    return res.json({ id: req.params.id });
  }));

  app.delete('/api/purchases/:id', taxManager, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Purchase not found.' });
    const user = currentUser(res);
    const existing = await pool.query<{ document_date: string }>(
      `SELECT to_char(document_date, 'YYYY-MM-DD') AS document_date FROM purchases WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Purchase not found.' });
    const closed = await closedMessage(pool, user.organizationId, existing.rows[0].document_date);
    if (closed) return res.status(409).json({ error: closed });
    await pool.query('DELETE FROM purchases WHERE id = $1 AND organization_id = $2', [req.params.id, user.organizationId]);
    return res.json({ deleted: true });
  }));

  app.post('/api/purchases/gstr2b', taxWriter, asyncHandler(async (req, res) => {
    const month = parseMonth(req.body?.month);
    if (!month) return res.status(400).json({ error: 'Choose the return month of this GSTR-2B.' });
    const parsed = parseGstr2bCsv(typeof req.body?.csv === 'string' ? req.body.csv : '');
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
    const organizationId = currentUser(res).organizationId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM gstr2b_lines WHERE organization_id = $1 AND month = $2::date', [organizationId, `${month}-01`]);
      for (const line of parsed.lines) {
        await client.query(
          `INSERT INTO gstr2b_lines (organization_id, month, section, supplier_gstin, supplier_name, document_no, document_date,
             taxable_inr, igst_inr, cgst_inr, sgst_inr, itc_available)
           VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [organizationId, `${month}-01`, line.section, line.supplierGstin, line.supplierName, line.documentNo, line.documentDate,
            line.taxableInr, line.igstInr, line.cgstInr, line.sgstInr, line.itcAvailable],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return res.status(201).json({ month, imported: parsed.lines.length, skipped: parsed.skipped });
  }));

  app.get('/api/purchases/itc-match', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month);
    if (!month) return res.status(400).json({ error: 'Choose a month.' });
    return res.json(await itcMatch(pool, currentUser(res).organizationId, month));
  }));

  app.get('/api/purchases/itc-match/csv', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month);
    if (!month) return res.status(400).json({ error: 'Choose a month.' });
    const report = await itcMatch(pool, currentUser(res).organizationId, month);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="itc-match-${month}.csv"`);
    return res.send(
      csvFile(
        ['Status', 'Type', 'Supplier', 'GSTIN', 'Invoice / BoE no', 'Date', 'Tax in books INR', 'Tax in GSTR-2B INR', '2B month', 'Detail'],
        report.rows.map((row) => [
          row.status.replace(/_/g, ' '), row.kind, row.supplierName, row.supplierGstin, row.documentNo, row.documentDate ?? '',
          row.booksTaxInr?.toFixed(2) ?? '', row.gstr2bTaxInr?.toFixed(2) ?? '', row.gstr2bMonth ?? '', row.detail,
        ]),
      ),
    );
  }));
}
