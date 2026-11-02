import type { Response } from 'express';
import type { DbPool } from '../../core/db.js';
import { requireRoles } from '../../core/http.js';
import { zipFiles } from '../../core/zip.js';

export const taxReader = requireRoles('admin', 'tax', 'ca');
export const taxWriter = requireRoles('admin', 'member', 'tax');
export const taxManager = requireRoles('admin', 'tax');
export const charteredAccountant = requireRoles('ca');

export const DIAMOND_GST_RATE = 0.25;

export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvFile(header: string[], rows: unknown[][]): Buffer {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

export function money(value: unknown): number {
  return Math.round(Number(value) * 100) / 100;
}

export function sendZip(res: Response, filename: string, files: Array<{ name: string; data: Buffer }>): void {
  const body = zipFiles(files);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

export function sendDownload(res: Response, filename: string, contentType: string, body: string): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

export function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export async function monthIsClosed(pool: DbPool, organizationId: string, month: string): Promise<boolean> {
  const found = await pool.query('SELECT 1 FROM closed_months WHERE organization_id = $1 AND month = $2::date', [
    organizationId,
    `${month}-01`,
  ]);
  return (found.rowCount ?? 0) > 0;
}

export async function invoiceDateOf(pool: DbPool, organizationId: string, invoiceId: string): Promise<string | null | undefined> {
  const invoice = await pool.query<{ invoice_date: string | null }>(
    `SELECT to_char(COALESCE(invoice_date, created_at::date), 'YYYY-MM-DD') AS invoice_date
     FROM invoices WHERE id = $1 AND organization_id = $2`,
    [invoiceId, organizationId],
  );
  return invoice.rows[0] ? invoice.rows[0].invoice_date : undefined;
}

export type TaxSettings = {
  realizationMonths: number;
  lutValidUntil: string | null;
  einvoiceRequired: boolean;
};

export async function taxSettings(pool: DbPool, organizationId: string): Promise<TaxSettings> {
  const result = await pool.query<{ realization_months: number; lut_valid_until: string | null; einvoice_required: boolean }>(
    `SELECT realization_months, to_char(lut_valid_until, 'YYYY-MM-DD') AS lut_valid_until, einvoice_required
     FROM organization_tax_settings WHERE organization_id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  return {
    realizationMonths: row?.realization_months ?? 9,
    lutValidUntil: row?.lut_valid_until ?? null,
    einvoiceRequired: row?.einvoice_required ?? true,
  };
}

/** Parses CSV text into rows of cells, honouring quoted fields with commas, quotes, and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

export function findColumn(header: string[], names: string[]): number {
  const normalized = header.map((value) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  for (const name of names) {
    const index = normalized.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

/** Accepts YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, and DD.MM.YYYY. */
export function parseLooseDate(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  let year: number;
  let month: number;
  let day: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(raw);
    if (!match) return null;
    [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function parseAmount(value: string | undefined): number | null {
  const raw = (value ?? '').replace(/[,\s$]/g, '').replace(/^USD/i, '');
  if (!raw) return null;
  const amount = Number(raw);
  return Number.isFinite(amount) ? money(amount) : null;
}
