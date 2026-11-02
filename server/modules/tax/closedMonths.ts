import type { DbPool } from '../../core/db.js';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseMonth(value: unknown): string | null {
  return typeof value === 'string' && MONTH.test(value) ? value : null;
}

export function monthOf(invoiceDate: string | null | undefined): string | null {
  if (!invoiceDate) return null;
  return parseMonth(invoiceDate.slice(0, 7));
}

export async function closedMonthMessage(
  pool: DbPool,
  organizationId: string,
  invoiceDate: string | null | undefined,
): Promise<string | null> {
  const month = monthOf(invoiceDate);
  if (!month) return null;
  const found = await pool.query('SELECT 1 FROM closed_months WHERE organization_id = $1 AND month = $2::date', [
    organizationId,
    `${month}-01`,
  ]);
  if (found.rowCount === 0) return null;
  return `The books for ${month} are closed. A chartered accountant has to reopen that month before this invoice can change.`;
}
