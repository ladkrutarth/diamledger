import type { Express, Request, Response } from 'express';
import type { DbPool } from '../../core/db.js';
import { asyncHandler, currentUser, requireUser } from '../../core/http.js';
import { parseLooseDate, taxManager } from './taxShared.js';

/**
 * Daily USD/INR rates. Reference rates come from a public source (Frankfurter, which publishes the
 * ECB reference rates); RBI does not offer a public API. A company can enter its own rate for a date,
 * such as the customs notified rate, and that rate wins over the reference rate.
 */
export const REFERENCE_SOURCE = 'ECB reference (Frankfurter)';
const REFERENCE_WINDOW_DAYS = 7;
const COMPANY_WINDOW_DAYS = 31;
const BACKFILL_DAYS = 400;

function rateSourceUrl(): string {
  return (process.env.EXCHANGE_RATE_URL || 'https://api.frankfurter.dev/v1').replace(/\/+$/, '');
}

export type RatePoint = { date: string; rateInr: number };

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

export async function fetchReferenceRates(from: string, to: string, fetcher: typeof fetch = fetch): Promise<RatePoint[]> {
  const response = await fetcher(`${rateSourceUrl()}/${from}..${to}?base=USD&symbols=INR`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`The rate source answered ${response.status}.`);
  const body = (await response.json()) as { rates?: Record<string, { INR?: number }> };
  return Object.entries(body.rates ?? {})
    .filter(([date, rate]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof rate?.INR === 'number' && rate.INR > 0)
    .map(([date, rate]) => ({ date, rateInr: rate.INR as number }));
}

/** Fetches every day since the last stored rate (or the last ~13 months on first run). */
export async function refreshReferenceRates(pool: DbPool, fetcher: typeof fetch = fetch): Promise<{ added: number; latest: string | null }> {
  const today = isoDay(new Date());
  const last = await pool.query<{ last: string | null }>(
    `SELECT to_char(MAX(rate_date), 'YYYY-MM-DD') AS last FROM reference_rates WHERE currency = 'USD'`,
  );
  const lastDate = last.rows[0]?.last ?? null;
  const from = lastDate ? addDays(lastDate, 1) : addDays(today, -BACKFILL_DAYS);
  if (from > today) return { added: 0, latest: lastDate };
  const points = await fetchReferenceRates(from, today, fetcher);
  let added = 0;
  for (const point of points) {
    const inserted = await pool.query(
      `INSERT INTO reference_rates (currency, rate_date, rate_inr, source) VALUES ('USD', $1, $2, $3)
       ON CONFLICT (currency, rate_date) DO NOTHING`,
      [point.date, point.rateInr, REFERENCE_SOURCE],
    );
    added += inserted.rowCount ?? 0;
  }
  const latest = points.length ? points[points.length - 1].date : lastDate;
  return { added, latest };
}

/**
 * A LATERAL subquery that yields `rate_inr`, `rate_source`, and `rate_date` for the date expression:
 * the company's own rate within a month before the date, else the reference rate within a week.
 */
export function rateLateral(organizationExpr: string, dateExpr: string): string {
  return `(
    SELECT r.rate_inr, r.rate_source, r.rate_date FROM (
      SELECT o.rate_inr, 'Company rate' AS rate_source, o.rate_date, 0 AS preference
      FROM organization_rates o
      WHERE o.organization_id = ${organizationExpr} AND o.currency = 'USD'
        AND o.rate_date <= ${dateExpr} AND o.rate_date > ${dateExpr} - ${COMPANY_WINDOW_DAYS}
      UNION ALL
      SELECT x.rate_inr, x.source AS rate_source, x.rate_date, 1 AS preference
      FROM reference_rates x
      WHERE x.currency = 'USD' AND x.rate_date <= ${dateExpr} AND x.rate_date > ${dateExpr} - ${REFERENCE_WINDOW_DAYS}
    ) r ORDER BY r.preference, r.rate_date DESC LIMIT 1
  )`;
}

export async function rateOn(
  pool: DbPool,
  organizationId: string,
  date: string,
): Promise<{ rateInr: number; source: string; date: string } | null> {
  const result = await pool.query<{ rate_inr: string; rate_source: string; rate_date: string }>(
    `SELECT rate_inr, rate_source, to_char(rate_date, 'YYYY-MM-DD') AS rate_date FROM ${rateLateral('$1::uuid', '$2::date')} AS found`,
    [organizationId, date],
  );
  const row = result.rows[0];
  return row ? { rateInr: Number(row.rate_inr), source: row.rate_source, date: row.rate_date } : null;
}

async function listRates(pool: DbPool, organizationId: string, from: string, to: string) {
  const [reference, company] = await Promise.all([
    pool.query<{ rate_date: string; rate_inr: string; source: string }>(
      `SELECT to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_inr, source FROM reference_rates
       WHERE currency = 'USD' AND rate_date BETWEEN $1 AND $2 ORDER BY rate_date DESC`,
      [from, to],
    ),
    pool.query<{ rate_date: string; rate_inr: string; note: string }>(
      `SELECT to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_inr, note FROM organization_rates
       WHERE organization_id = $1 AND currency = 'USD' AND rate_date BETWEEN $2 AND $3 ORDER BY rate_date DESC`,
      [organizationId, from, to],
    ),
  ]);
  return {
    reference: reference.rows.map((row) => ({ date: row.rate_date, rateInr: Number(row.rate_inr), source: row.source })),
    company: company.rows.map((row) => ({ date: row.rate_date, rateInr: Number(row.rate_inr), note: row.note })),
  };
}

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}

export function registerRateRoutes(app: Express, pool: DbPool, fetcher: typeof fetch = fetch): void {
  // Called once a day by Vercel Cron (see vercel.json). Vercel sends CRON_SECRET as a bearer token.
  app.get('/api/cron/rates', asyncHandler(async (req: Request, res: Response) => {
    if (!cronAuthorized(req)) return res.status(401).json({ error: 'Not allowed.' });
    return res.json(await refreshReferenceRates(pool, fetcher));
  }));

  app.get('/api/rates', requireUser, asyncHandler(async (req, res) => {
    const today = isoDay(new Date());
    const to = parseLooseDate(String(req.query.to ?? '')) ?? today;
    const from = parseLooseDate(String(req.query.from ?? '')) ?? addDays(to, -45);
    const organizationId = currentUser(res).organizationId;
    // Keep the table fresh even without the cron: refresh when the newest rate is more than two days old.
    const newest = await pool.query<{ newest: string | null }>(
      `SELECT to_char(MAX(rate_date), 'YYYY-MM-DD') AS newest FROM reference_rates WHERE currency = 'USD'`,
    );
    let refreshError = '';
    if (!newest.rows[0]?.newest || newest.rows[0].newest < addDays(today, -2)) {
      await refreshReferenceRates(pool, fetcher).catch((error: Error) => {
        refreshError = `Could not reach the rate source: ${error.message}`;
      });
    }
    const latest = await rateOn(pool, organizationId, today);
    return res.json({ today, latest, ...(await listRates(pool, organizationId, from, to)), refreshError, source: REFERENCE_SOURCE });
  }));

  app.get('/api/rates/on', requireUser, asyncHandler(async (req, res) => {
    const date = parseLooseDate(String(req.query.date ?? ''));
    if (!date) return res.status(400).json({ error: 'Give a date as YYYY-MM-DD.' });
    return res.json({ date, rate: await rateOn(pool, currentUser(res).organizationId, date) });
  }));

  app.post('/api/rates/refresh', taxManager, asyncHandler(async (_req, res) => {
    try {
      return res.json(await refreshReferenceRates(pool, fetcher));
    } catch (error) {
      return res.status(502).json({ error: `Could not reach the rate source: ${(error as Error).message}` });
    }
  }));

  app.put('/api/rates/company', taxManager, asyncHandler(async (req, res) => {
    const date = parseLooseDate(String(req.body?.date ?? ''));
    const rate = Number(req.body?.rateInr);
    if (!date) return res.status(400).json({ error: 'Enter the date as YYYY-MM-DD.' });
    if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) return res.status(400).json({ error: 'Enter the rate in rupees per US dollar.' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
    const user = currentUser(res);
    await pool.query(
      `INSERT INTO organization_rates (organization_id, currency, rate_date, rate_inr, note, entered_by)
       VALUES ($1, 'USD', $2, $3, $4, $5)
       ON CONFLICT (organization_id, currency, rate_date) DO UPDATE SET rate_inr = EXCLUDED.rate_inr, note = EXCLUDED.note,
         entered_by = EXCLUDED.entered_by, created_at = now()`,
      [user.organizationId, date, rate, note, user.id],
    );
    return res.json({ date, rateInr: rate, note });
  }));

  app.delete('/api/rates/company/:date', taxManager, asyncHandler(async (req, res) => {
    const date = parseLooseDate(req.params.date);
    if (!date) return res.status(404).json({ error: 'Rate not found.' });
    const result = await pool.query(
      `DELETE FROM organization_rates WHERE organization_id = $1 AND currency = 'USD' AND rate_date = $2`,
      [currentUser(res).organizationId, date],
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Rate not found.' });
    return res.json({ deleted: true });
  }));
}
