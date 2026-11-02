import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { isRoughHsCode } from '../tax/exportReports.js';
import { currentFinancialYear, financialYearDates } from '../../core/formInput.js';
import { asyncHandler, currentUser, requireUser } from '../../core/http.js';
import { csvFile, money } from '../tax/taxShared.js';

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const key = (value: string): string => value.trim().toUpperCase();

type Kind = 'rough' | 'polished';

type KindTotals = {
  opening: number;
  purchased: number;
  produced: number;
  consumed: number;
  sold: number;
  closing: number;
  closingValueInr: number;
  parcelsWithoutCost: number;
};

function emptyTotals(): KindTotals {
  return { opening: 0, purchased: 0, produced: 0, consumed: 0, sold: 0, closing: 0, closingValueInr: 0, parcelsWithoutCost: 0 };
}

/**
 * Quantity and value of stock for one financial year, by parcel and for rough and polished goods:
 * opening, received, sent to manufacture, sold, and closing, with the yield from rough to polished.
 */
export async function stockRegister(pool: DbPool, organizationId: string, year: string) {
  const range = financialYearDates(year);
  if (!range) throw Object.assign(new Error('Financial year should look like 2026-27.'), { status: 400 });
  const { start, end } = range;

  const [parcelResult, saleResult] = await Promise.all([
    pool.query<{
      parcel_id: string; description: string; stock_kind: Kind; received_on: string | null; carats_in: string; cost_inr: string | null;
      made_from: string; rough_carats_used: string | null;
    }>(
      `SELECT parcel_id, description, stock_kind, to_char(received_on, 'YYYY-MM-DD') AS received_on, carats_in, cost_inr, made_from,
              rough_carats_used
       FROM parcels WHERE organization_id = $1 AND (received_on IS NULL OR received_on <= $2)
       ORDER BY stock_kind, parcel_id`,
      [organizationId, end],
    ),
    pool.query<{ parcel_key: string; hs_code: string; before: string; during: string }>(
      `SELECT UPPER(TRIM(COALESCE(item->>'parcelId', ''))) AS parcel_key, COALESCE(item->>'hsCode', '') AS hs_code,
              SUM(CASE WHEN COALESCE(i.invoice_date, i.created_at::date) < $2 AND item->>'carats' ~ '^[0-9]+(\\.[0-9]+)?$'
                       THEN (item->>'carats')::numeric ELSE 0 END) AS before,
              SUM(CASE WHEN COALESCE(i.invoice_date, i.created_at::date) BETWEEN $2 AND $3 AND item->>'carats' ~ '^[0-9]+(\\.[0-9]+)?$'
                       THEN (item->>'carats')::numeric ELSE 0 END) AS during
       FROM invoices i, jsonb_array_elements(COALESCE(i.data->'items', '[]'::jsonb)) AS item
       WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND COALESCE(i.invoice_date, i.created_at::date) <= $3
       GROUP BY 1, 2`,
      [organizationId, start, end],
    ),
  ]);

  const sales = new Map<string, { before: number; during: number }>();
  const unassigned: Record<Kind, number> = { rough: 0, polished: 0 };
  for (const row of saleResult.rows) {
    if (!row.parcel_key) {
      unassigned[isRoughHsCode(row.hs_code) ? 'rough' : 'polished'] += Number(row.during);
      continue;
    }
    const found = sales.get(row.parcel_key) ?? { before: 0, during: 0 };
    found.before += Number(row.before);
    found.during += Number(row.during);
    sales.set(row.parcel_key, found);
  }

  // Rough carats used by polished parcels, split by whether the cutting finished before or during the year.
  const consumption = new Map<string, { before: number; during: number }>();
  const roughCostPerCarat = new Map<string, number>();
  for (const parcel of parcelResult.rows) {
    if (parcel.stock_kind === 'rough' && parcel.cost_inr !== null && Number(parcel.carats_in) > 0) {
      roughCostPerCarat.set(key(parcel.parcel_id), Number(parcel.cost_inr) / Number(parcel.carats_in));
    }
    if (!parcel.made_from || parcel.rough_carats_used === null) continue;
    const used = consumption.get(key(parcel.made_from)) ?? { before: 0, during: 0 };
    if (parcel.received_on !== null && parcel.received_on >= start) used.during += Number(parcel.rough_carats_used);
    else used.before += Number(parcel.rough_carats_used);
    consumption.set(key(parcel.made_from), used);
  }

  const totals: Record<Kind, KindTotals> = { rough: emptyTotals(), polished: emptyTotals() };
  const parcels = parcelResult.rows.map((parcel) => {
    const caratsIn = Number(parcel.carats_in);
    const inYear = parcel.received_on !== null && parcel.received_on >= start;
    const sold = sales.get(key(parcel.parcel_id)) ?? { before: 0, during: 0 };
    const used = consumption.get(key(parcel.parcel_id)) ?? { before: 0, during: 0 };
    const opening = round3((inYear ? 0 : caratsIn) - sold.before - used.before);
    const received = inYear ? caratsIn : 0;
    const closing = round3(opening + received - sold.during - used.during);

    // Cost: what was paid for the parcel, or for a polished parcel without its own cost, the cost of the rough used.
    let costInr = parcel.cost_inr === null ? null : Number(parcel.cost_inr);
    if (costInr === null && parcel.made_from && parcel.rough_carats_used !== null) {
      const perCarat = roughCostPerCarat.get(key(parcel.made_from));
      if (perCarat !== undefined) costInr = money(perCarat * Number(parcel.rough_carats_used));
    }
    const costPerCarat = costInr !== null && caratsIn > 0 ? costInr / caratsIn : null;
    const closingValueInr = costPerCarat === null ? null : money(Math.max(closing, 0) * costPerCarat);

    const bucket = totals[parcel.stock_kind];
    bucket.opening += opening;
    if (parcel.made_from) bucket.produced += received;
    else bucket.purchased += received;
    bucket.consumed += used.during;
    bucket.sold += sold.during;
    bucket.closing += closing;
    bucket.closingValueInr += closingValueInr ?? 0;
    if (closing > 0.0005 && closingValueInr === null) bucket.parcelsWithoutCost += 1;

    return {
      parcelId: parcel.parcel_id,
      description: parcel.description,
      stockKind: parcel.stock_kind,
      receivedOn: parcel.received_on,
      madeFrom: parcel.made_from,
      opening,
      received,
      consumed: round3(used.during),
      sold: round3(sold.during),
      closing,
      costPerCaratInr: costPerCarat === null ? null : money(costPerCarat),
      closingValueInr,
      negative: closing < -0.0005,
    };
  });

  const finish = (bucket: KindTotals): KindTotals => ({
    opening: round3(bucket.opening),
    purchased: round3(bucket.purchased),
    produced: round3(bucket.produced),
    consumed: round3(bucket.consumed),
    sold: round3(bucket.sold),
    closing: round3(bucket.closing),
    closingValueInr: money(bucket.closingValueInr),
    parcelsWithoutCost: bucket.parcelsWithoutCost,
  });
  const rough = finish(totals.rough);
  const polished = finish(totals.polished);
  const yieldPercent = rough.consumed > 0 ? Math.round((polished.produced / rough.consumed) * 10000) / 100 : null;

  const purchased = await pool.query<{ carats: string }>(
    `SELECT COALESCE(SUM(carats), 0) AS carats FROM purchases WHERE organization_id = $1 AND document_date BETWEEN $2 AND $3`,
    [organizationId, start, end],
  );

  return {
    year,
    start,
    end,
    parcels: parcels.filter((parcel) => parcel.opening || parcel.received || parcel.sold || parcel.consumed || parcel.closing),
    rough,
    polished,
    yieldPercent,
    processLossCarats: round3(rough.consumed - polished.produced),
    soldWithoutParcel: { rough: round3(unassigned.rough), polished: round3(unassigned.polished) },
    purchaseRegisterCarats: round3(Number(purchased.rows[0].carats)),
    negativeParcels: parcels.filter((parcel) => parcel.negative).map((parcel) => parcel.parcelId),
  };
}

export type StockRegister = Awaited<ReturnType<typeof stockRegister>>;

export function stockCsv(report: StockRegister): Buffer {
  const summary = (label: string, totals: KindTotals): unknown[] => [
    label, '', '', '', totals.opening.toFixed(3), (totals.purchased + totals.produced).toFixed(3), totals.consumed.toFixed(3),
    totals.sold.toFixed(3), totals.closing.toFixed(3), '', totals.closingValueInr.toFixed(2),
  ];
  return csvFile(
    ['Parcel / lot', 'Type', 'Description', 'Made from', 'Opening ct', 'Received / produced ct', 'Sent to manufacture ct', 'Sold ct',
      'Closing ct', 'Cost per ct INR', 'Closing value INR'],
    [
      ...report.parcels.map((parcel) => [
        parcel.parcelId, parcel.stockKind, parcel.description, parcel.madeFrom, parcel.opening.toFixed(3), parcel.received.toFixed(3),
        parcel.consumed.toFixed(3), parcel.sold.toFixed(3), parcel.closing.toFixed(3), parcel.costPerCaratInr?.toFixed(2) ?? '',
        parcel.closingValueInr?.toFixed(2) ?? '',
      ]),
      summary('Total rough', report.rough),
      summary('Total polished', report.polished),
      ['Yield (polished produced / rough used)', '', '', '', '', '', '', '', report.yieldPercent === null ? '' : `${report.yieldPercent}%`, '', ''],
    ],
  );
}

export function registerStockRoutes(app: Express, pool: DbPool): void {
  app.get('/api/stock/register', requireUser, asyncHandler(async (req, res) => {
    const year = typeof req.query.year === 'string' && req.query.year ? req.query.year : currentFinancialYear();
    return res.json(await stockRegister(pool, currentUser(res).organizationId, year));
  }));

  app.get('/api/stock/register/csv', requireUser, asyncHandler(async (req, res) => {
    const year = typeof req.query.year === 'string' && req.query.year ? req.query.year : currentFinancialYear();
    const report = await stockRegister(pool, currentUser(res).organizationId, year);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="stock-register-${year}.csv"`);
    return res.send(stockCsv(report));
  }));
}
