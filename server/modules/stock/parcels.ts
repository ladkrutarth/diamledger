import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { asyncHandler, currentUser, isUuid, requireUser, requireRoles } from '../../core/http.js';
import { csvFile, parseLooseDate } from '../tax/taxShared.js';

const parcelWriter = requireRoles('admin', 'member', 'tax');

type ParcelInput = {
  parcelId: string;
  description: string;
  receivedOn: string | null;
  source: string;
  piecesIn: number;
  caratsIn: number;
  notes: string;
  stockKind: 'rough' | 'polished';
  costInr: number | null;
  madeFrom: string;
  roughCaratsUsed: number | null;
};

function readParcel(body: unknown): ParcelInput | string {
  const value = (body ?? {}) as Record<string, unknown>;
  const text = (key: string, max: number) => (typeof value[key] === 'string' ? (value[key] as string).trim().slice(0, max) : '');
  const parcelId = text('parcelId', 100);
  if (!parcelId) return 'Enter the parcel or lot number.';
  const caratsIn = Math.round(Number(value.caratsIn) * 1000) / 1000;
  if (!Number.isFinite(caratsIn) || caratsIn <= 0) return 'Enter the carats received.';
  const piecesIn = value.piecesIn === undefined || value.piecesIn === '' ? 0 : Number(value.piecesIn);
  if (!Number.isInteger(piecesIn) || piecesIn < 0) return 'Pieces must be a whole number.';
  const receivedRaw = text('receivedOn', 20);
  const receivedOn = receivedRaw ? parseLooseDate(receivedRaw) : null;
  if (receivedRaw && !receivedOn) return 'Enter the received date as YYYY-MM-DD.';
  const stockKind = value.stockKind === 'rough' ? 'rough' : 'polished';
  const costRaw = value.costInr;
  const costInr = costRaw === undefined || costRaw === null || costRaw === '' ? null : Math.round(Number(costRaw) * 100) / 100;
  if (costInr !== null && (!Number.isFinite(costInr) || costInr < 0)) return 'Cost must be zero or more rupees.';
  const madeFrom = stockKind === 'polished' ? text('madeFrom', 100) : '';
  let roughCaratsUsed: number | null = null;
  if (madeFrom) {
    roughCaratsUsed = Math.round(Number(value.roughCaratsUsed) * 1000) / 1000;
    if (!Number.isFinite(roughCaratsUsed) || roughCaratsUsed <= 0) return 'Enter the rough carats used to make this parcel.';
    if (roughCaratsUsed < caratsIn) return 'Polished carats cannot be more than the rough carats used.';
  }
  return {
    stockKind,
    costInr,
    madeFrom,
    roughCaratsUsed,
    parcelId,
    description: text('description', 300),
    receivedOn,
    source: text('source', 200),
    piecesIn,
    caratsIn,
    notes: text('notes', 500),
  };
}

/** A polished parcel can only be cut from a rough parcel that is already in the register. */
async function checkRoughSource(pool: DbPool, organizationId: string, input: ParcelInput): Promise<string | null> {
  if (!input.madeFrom) return null;
  if (input.madeFrom.trim().toUpperCase() === input.parcelId.trim().toUpperCase()) return 'A parcel cannot be made from itself.';
  const found = await pool.query<{ stock_kind: string }>(
    'SELECT stock_kind FROM parcels WHERE organization_id = $1 AND UPPER(TRIM(parcel_id)) = UPPER(TRIM($2))',
    [organizationId, input.madeFrom],
  );
  if (!found.rows[0]) return `Rough parcel ${input.madeFrom} is not in the register. Receive it first.`;
  if (found.rows[0].stock_kind !== 'rough') return `${input.madeFrom} is a polished parcel. Choose the rough parcel it was cut from.`;
  return null;
}

/** Each parcel with the carats and pieces invoiced against it (issued and paid invoices only). */
export async function parcelRegister(pool: DbPool, organizationId: string) {
  const result = await pool.query<{
    id: string; parcel_id: string; description: string; received_on: string | null; source: string; pieces_in: number;
    carats_in: string; notes: string; carats_out: string; pieces_out: string; invoices: string[] | null; draft_carats: string;
    stock_kind: 'rough' | 'polished'; cost_inr: string | null; made_from: string; rough_carats_used: string | null; consumed: string;
  }>(
    `WITH lines AS (
       SELECT i.invoice_number, i.status, UPPER(TRIM(item->>'parcelId')) AS parcel_key,
              CASE WHEN item->>'carats' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (item->>'carats')::numeric ELSE 0 END AS carats,
              CASE WHEN item->>'pieces' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (item->>'pieces')::numeric ELSE 0 END AS pieces
       FROM invoices i, jsonb_array_elements(COALESCE(i.data->'items', '[]'::jsonb)) AS item
       WHERE i.organization_id = $1 AND i.status <> 'cancelled' AND COALESCE(TRIM(item->>'parcelId'), '') <> ''
     )
     SELECT p.id, p.parcel_id, p.description, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.source, p.pieces_in,
            p.carats_in, p.notes, p.stock_kind, p.cost_inr, p.made_from, p.rough_carats_used,
            (SELECT COALESCE(SUM(c.rough_carats_used), 0) FROM parcels c
              WHERE c.organization_id = p.organization_id AND UPPER(TRIM(c.made_from)) = UPPER(TRIM(p.parcel_id))) AS consumed,
            COALESCE(SUM(l.carats) FILTER (WHERE l.status IN ('issued', 'paid')), 0) AS carats_out,
            COALESCE(SUM(l.pieces) FILTER (WHERE l.status IN ('issued', 'paid')), 0) AS pieces_out,
            COALESCE(SUM(l.carats) FILTER (WHERE l.status = 'draft'), 0) AS draft_carats,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT l.invoice_number) FILTER (WHERE l.status IN ('issued', 'paid')), NULL) AS invoices
     FROM parcels p
     LEFT JOIN lines l ON l.parcel_key = UPPER(TRIM(p.parcel_id))
     WHERE p.organization_id = $1
     GROUP BY p.id
     ORDER BY p.received_on DESC NULLS LAST, p.parcel_id`,
    [organizationId],
  );
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const parcels = result.rows.map((row) => {
    const caratsIn = Number(row.carats_in);
    const consumedCarats = round(Number(row.consumed));
    const caratsOut = round(Number(row.carats_out));
    const balance = round(caratsIn - caratsOut - consumedCarats);
    return {
      id: row.id,
      parcelId: row.parcel_id,
      description: row.description,
      receivedOn: row.received_on,
      source: row.source,
      piecesIn: row.pieces_in,
      caratsIn,
      notes: row.notes,
      stockKind: row.stock_kind,
      costInr: row.cost_inr === null ? null : Number(row.cost_inr),
      madeFrom: row.made_from,
      roughCaratsUsed: row.rough_carats_used === null ? null : Number(row.rough_carats_used),
      consumedCarats,
      caratsOut,
      piecesOut: Number(row.pieces_out),
      draftCarats: round(Number(row.draft_carats)),
      balanceCarats: balance,
      invoices: row.invoices ?? [],
      status: balance < -0.0005 ? 'over' : balance <= 0.0005 ? 'sold' : caratsOut + consumedCarats > 0 ? 'partial' : 'in_stock',
    };
  });

  // Invoiced parcel numbers that were never received into stock.
  const unknown = await pool.query<{ parcel_id: string; carats: string; invoices: string[] }>(
    `SELECT MIN(TRIM(item->>'parcelId')) AS parcel_id, SUM(CASE WHEN item->>'carats' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (item->>'carats')::numeric ELSE 0 END) AS carats,
            ARRAY_AGG(DISTINCT i.invoice_number) AS invoices
     FROM invoices i, jsonb_array_elements(COALESCE(i.data->'items', '[]'::jsonb)) AS item
     WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND COALESCE(TRIM(item->>'parcelId'), '') <> ''
       AND NOT EXISTS (SELECT 1 FROM parcels p WHERE p.organization_id = $1 AND UPPER(TRIM(p.parcel_id)) = UPPER(TRIM(item->>'parcelId')))
     GROUP BY UPPER(TRIM(item->>'parcelId'))
     ORDER BY 1`,
    [organizationId],
  );

  return {
    parcels,
    unregistered: unknown.rows.map((row) => ({ parcelId: row.parcel_id, carats: round(Number(row.carats)), invoices: row.invoices })),
    totals: {
      caratsIn: round(parcels.reduce((sum, parcel) => sum + parcel.caratsIn, 0)),
      caratsOut: round(parcels.reduce((sum, parcel) => sum + parcel.caratsOut, 0)),
      balanceCarats: round(parcels.reduce((sum, parcel) => sum + parcel.balanceCarats, 0)),
      overInvoiced: parcels.filter((parcel) => parcel.status === 'over').length,
    },
  };
}

export function registerParcelRoutes(app: Express, pool: DbPool): void {
  app.get('/api/parcels', requireUser, asyncHandler(async (_req, res) => {
    return res.json(await parcelRegister(pool, currentUser(res).organizationId));
  }));

  app.get('/api/parcels/csv', requireUser, asyncHandler(async (_req, res) => {
    const { parcels } = await parcelRegister(pool, currentUser(res).organizationId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="parcel-register.csv"');
    return res.send(
      csvFile(
        ['Parcel / lot', 'Type', 'Description', 'Received on', 'Source', 'Made from', 'Pieces in', 'Carats in', 'Cost INR', 'Pieces invoiced',
          'Carats invoiced', 'Carats sent to manufacture', 'Balance carats', 'Invoices', 'Notes'],
        parcels.map((parcel) => [
          parcel.parcelId, parcel.stockKind, parcel.description, parcel.receivedOn ?? '', parcel.source, parcel.madeFrom, parcel.piecesIn,
          parcel.caratsIn.toFixed(3), parcel.costInr?.toFixed(2) ?? '', parcel.piecesOut, parcel.caratsOut.toFixed(3),
          parcel.consumedCarats.toFixed(3), parcel.balanceCarats.toFixed(3), parcel.invoices.join(' '), parcel.notes,
        ]),
      ),
    );
  }));

  app.post('/api/parcels', parcelWriter, asyncHandler(async (req, res) => {
    const input = readParcel(req.body);
    if (typeof input === 'string') return res.status(400).json({ error: input });
    const user = currentUser(res);
    const sourceProblem = await checkRoughSource(pool, user.organizationId, input);
    if (sourceProblem) return res.status(400).json({ error: sourceProblem });
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO parcels (organization_id, parcel_id, description, received_on, source, pieces_in, carats_in, notes, created_by,
         stock_kind, cost_inr, made_from, rough_carats_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (organization_id, parcel_id) DO NOTHING RETURNING id`,
      [user.organizationId, input.parcelId, input.description, input.receivedOn, input.source, input.piecesIn, input.caratsIn, input.notes, user.id,
        input.stockKind, input.costInr, input.madeFrom, input.roughCaratsUsed],
    );
    if (!inserted.rows[0]) return res.status(409).json({ error: `Parcel ${input.parcelId} is already in the register.` });
    return res.status(201).json({ id: inserted.rows[0].id });
  }));

  app.put('/api/parcels/:id', parcelWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Parcel not found.' });
    const input = readParcel(req.body);
    if (typeof input === 'string') return res.status(400).json({ error: input });
    const sourceProblem = await checkRoughSource(pool, currentUser(res).organizationId, input);
    if (sourceProblem) return res.status(400).json({ error: sourceProblem });
    try {
      const updated = await pool.query(
        `UPDATE parcels SET parcel_id = $3, description = $4, received_on = $5, source = $6, pieces_in = $7, carats_in = $8, notes = $9,
           stock_kind = $10, cost_inr = $11, made_from = $12, rough_carats_used = $13
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, currentUser(res).organizationId, input.parcelId, input.description, input.receivedOn, input.source,
          input.piecesIn, input.caratsIn, input.notes, input.stockKind, input.costInr, input.madeFrom, input.roughCaratsUsed],
      );
      if (!updated.rowCount) return res.status(404).json({ error: 'Parcel not found.' });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: `Parcel ${input.parcelId} is already in the register.` });
      throw error;
    }
    return res.json({ id: req.params.id });
  }));

  app.delete('/api/parcels/:id', requireRoles('admin'), asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Parcel not found.' });
    const deleted = await pool.query('DELETE FROM parcels WHERE id = $1 AND organization_id = $2', [req.params.id, currentUser(res).organizationId]);
    if (!deleted.rowCount) return res.status(404).json({ error: 'Parcel not found.' });
    return res.json({ deleted: true });
  }));
}
