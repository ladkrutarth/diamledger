import type { Express } from 'express';
import type { DbPool } from './db.js';
import { asyncHandler, currentUser, isRecord, isUuid, requireAdmin, requireUser, stringFields } from './http.js';

export const EXPORTER_FIELDS = [
  'companyName', 'addressLine1', 'addressLine2', 'city', 'state', 'stateCode', 'pincode', 'country',
  'iec', 'gstin', 'pan', 'rcmcNo', 'email', 'phone',
] as const;

export const BANK_FIELDS = [
  'bankName', 'branch', 'accountNumber', 'adCode', 'swiftCode', 'ifscCode', 'iban', 'correspondentBank',
  'correspondentSwift',
] as const;

export const BUYER_FIELDS = [
  'companyName', 'addressLine1', 'addressLine2', 'city', 'state', 'country', 'postalCode', 'taxIdVat',
  'contactPerson', 'email', 'phone',
] as const;

type BuyerRow = { id: string; name: string; data: Record<string, string>; updated_at: Date };

function toBuyer(row: BuyerRow) {
  return { id: row.id, name: row.name, consignee: row.data, updatedAt: new Date(row.updated_at).toISOString() };
}

function parseProfile(value: unknown) {
  if (!isRecord(value)) return null;
  const exporter = stringFields(value.exporter ?? {}, EXPORTER_FIELDS);
  const bank = stringFields(value.bank ?? {}, BANK_FIELDS);
  const extra = stringFields(value, ['invoicePrefix', 'authorizedSignatoryName', 'authorizedSignatoryDesignation']);
  if (!exporter || !bank || !extra) return null;
  const invoicePrefix = extra.invoicePrefix.trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
  return { ...extra, invoicePrefix, exporter, bank };
}

export function registerCompanyRoutes(app: Express, pool: DbPool): void {
  app.get('/api/company', requireUser, asyncHandler(async (_req, res) => {
    const result = await pool.query<{ name: string; profile: unknown }>(
      'SELECT name, profile FROM organizations WHERE id = $1',
      [currentUser(res).organizationId],
    );
    const row = result.rows[0];
    return res.json({ name: row.name, profile: row.profile ?? null });
  }));

  app.put('/api/company', requireAdmin, asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : '';
    const profile = parseProfile(req.body?.profile);
    if (!name) {
      return res.status(400).json({ error: 'Company name is required.' });
    }
    if (!profile) {
      return res.status(400).json({ error: 'Company profile is invalid.' });
    }
    await pool.query('UPDATE organizations SET name = $2, profile = $3::jsonb WHERE id = $1', [
      currentUser(res).organizationId,
      name,
      JSON.stringify(profile),
    ]);
    return res.json({ name, profile });
  }));

  app.get('/api/buyers', requireUser, asyncHandler(async (_req, res) => {
    const result = await pool.query<BuyerRow>(
      'SELECT id, name, data, updated_at FROM buyers WHERE organization_id = $1 ORDER BY lower(name)',
      [currentUser(res).organizationId],
    );
    return res.json({ buyers: result.rows.map(toBuyer) });
  }));

  app.post('/api/buyers', requireUser, asyncHandler(async (req, res) => {
    const consignee = stringFields(req.body?.consignee, BUYER_FIELDS);
    if (!consignee || !consignee.companyName.trim()) {
      return res.status(400).json({ error: 'Buyer company name is required.' });
    }
    const result = await pool.query<BuyerRow>(
      `INSERT INTO buyers (organization_id, name, data) VALUES ($1, $2, $3::jsonb)
       RETURNING id, name, data, updated_at`,
      [currentUser(res).organizationId, consignee.companyName.trim(), JSON.stringify(consignee)],
    );
    return res.status(201).json(toBuyer(result.rows[0]));
  }));

  app.put('/api/buyers/:id', requireUser, asyncHandler(async (req, res) => {
    const consignee = stringFields(req.body?.consignee, BUYER_FIELDS);
    if (!consignee || !consignee.companyName.trim()) {
      return res.status(400).json({ error: 'Buyer company name is required.' });
    }
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Buyer not found.' });
    }
    const result = await pool.query<BuyerRow>(
      `UPDATE buyers SET name = $3, data = $4::jsonb, updated_at = now()
       WHERE id = $1 AND organization_id = $2
       RETURNING id, name, data, updated_at`,
      [req.params.id, currentUser(res).organizationId, consignee.companyName.trim(), JSON.stringify(consignee)],
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Buyer not found.' });
    }
    return res.json(toBuyer(result.rows[0]));
  }));

  app.delete('/api/buyers/:id', requireUser, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Buyer not found.' });
    }
    const result = await pool.query('DELETE FROM buyers WHERE id = $1 AND organization_id = $2', [
      req.params.id,
      currentUser(res).organizationId,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Buyer not found.' });
    }
    return res.status(204).send();
  }));
}
