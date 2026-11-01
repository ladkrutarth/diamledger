import type { PoolClient } from 'pg';
import type { DbPool } from './db.js';
import { nextInvoiceNumber, refreshPaidStatus } from './invoices.js';
import { invoiceFacts, validateInvoice } from './invoiceValidation.js';
import { MUMBAI_TO_NY_PRESET, SURAT_TO_ANTWERP_PRESET, SURAT_TO_DUBAI_PRESET } from '../src/data/sampleInvoices.js';
import type { ConsigneeDetails, InvoiceState } from '../src/types/invoice.js';

export const DEMO_INVOICE_PREFIX = 'XYZ';

type DemoBuyer = Pick<ConsigneeDetails, 'companyName' | 'addressLine1' | 'city' | 'country' | 'postalCode' | 'contactPerson' | 'email' | 'phone'>;

export const DEMO_BUYERS: DemoBuyer[] = [
  {
    companyName: 'Rosenfeld & Sons BVBA',
    addressLine1: 'Hoveniersstraat 30',
    city: 'Antwerp',
    country: 'Belgium',
    postalCode: '2018',
    contactPerson: 'Miriam Rosenfeld',
    email: 'accounts.rosenfeld@example.com',
    phone: '+32 3 000 0101',
  },
  {
    companyName: 'Fifth Avenue Diamonds Inc',
    addressLine1: '580 Fifth Avenue, Suite 1200',
    city: 'New York',
    country: 'United States',
    postalCode: '10036',
    contactPerson: 'Daniel Brooks',
    email: 'payables.fifthavenue@example.com',
    phone: '+1 212 000 0102',
  },
  {
    companyName: 'Gulf Gems DMCC',
    addressLine1: 'Almas Tower, Jumeirah Lakes Towers',
    city: 'Dubai',
    country: 'United Arab Emirates',
    postalCode: '00000',
    contactPerson: 'Omar Haddad',
    email: 'finance.gulfgems@example.com',
    phone: '+971 4 000 0103',
  },
  {
    companyName: 'Kowloon Jewellery Trading Ltd',
    addressLine1: '18 Hankow Road, Tsim Sha Tsui',
    city: 'Hong Kong',
    country: 'Hong Kong',
    postalCode: '000000',
    contactPerson: 'Grace Leung',
    email: 'ap.kowloon@example.com',
    phone: '+852 0000 0104',
  },
  {
    companyName: 'Ramat Gan Polished Ltd',
    addressLine1: '3 Jabotinsky Street, Diamond Exchange',
    city: 'Tel Aviv',
    country: 'Israel',
    postalCode: '5252001',
    contactPerson: 'Avi Cohen',
    email: 'billing.ramatgan@example.com',
    phone: '+972 3 000 0105',
  },
  {
    companyName: 'Siam Gem Traders Co Ltd',
    addressLine1: '919 Silom Road, Bang Rak',
    city: 'Bangkok',
    country: 'Thailand',
    postalCode: '10500',
    contactPerson: 'Niran Chaiyaporn',
    email: 'accounts.siamgem@example.com',
    phone: '+66 2 000 0106',
  },
];

export const DEMO_INVOICE_TARGET = 400;

type DemoInvoice = {
  buyer: number;
  preset: InvoiceState;
  items: number;
  daysAgo: number;
  creditDays: number;
  status: 'draft' | 'issued' | 'cancelled';
  paid?: 'full' | 'partial';
  reminded?: boolean;
  scale?: number;
  key?: number;
};

const PRESETS = [SURAT_TO_ANTWERP_PRESET, MUMBAI_TO_NY_PRESET, SURAT_TO_DUBAI_PRESET];

export const DEMO_INVOICES: DemoInvoice[] = [
  { buyer: 0, preset: PRESETS[0], items: 3, daysAgo: 115, creditDays: 60, status: 'issued', paid: 'partial' },
  { buyer: 0, preset: PRESETS[0], items: 2, daysAgo: 20, creditDays: 30, status: 'issued' },
  { buyer: 1, preset: PRESETS[1], items: 3, daysAgo: 100, creditDays: 30, status: 'issued', reminded: true },
  { buyer: 1, preset: PRESETS[1], items: 2, daysAgo: 75, creditDays: 60, status: 'issued', paid: 'full' },
  { buyer: 2, preset: PRESETS[2], items: 2, daysAgo: 95, creditDays: 0, status: 'issued', paid: 'partial' },
  { buyer: 2, preset: PRESETS[2], items: 3, daysAgo: 45, creditDays: 30, status: 'issued' },
  { buyer: 3, preset: PRESETS[0], items: 4, daysAgo: 110, creditDays: 60, status: 'issued', paid: 'full' },
  { buyer: 3, preset: PRESETS[1], items: 1, daysAgo: 10, creditDays: 30, status: 'issued' },
  { buyer: 4, preset: PRESETS[2], items: 4, daysAgo: 80, creditDays: 30, status: 'issued', paid: 'partial' },
  { buyer: 4, preset: PRESETS[0], items: 1, daysAgo: 40, creditDays: 60, status: 'issued' },
  { buyer: 5, preset: PRESETS[1], items: 2, daysAgo: 50, creditDays: 0, status: 'issued', paid: 'full' },
  { buyer: 5, preset: PRESETS[2], items: 1, daysAgo: 35, creditDays: 30, status: 'issued' },
  { buyer: 1, preset: PRESETS[1], items: 1, daysAgo: 5, creditDays: 30, status: 'draft' },
  { buyer: 2, preset: PRESETS[2], items: 2, daysAgo: 3, creditDays: 30, status: 'draft' },
  { buyer: 3, preset: PRESETS[0], items: 2, daysAgo: 65, creditDays: 30, status: 'cancelled' },
];

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function generatedSpec(n: number): DemoInvoice {
  const kind = n % 20;
  let status: DemoInvoice['status'] = 'issued';
  let paid: DemoInvoice['paid'];
  let daysAgo = 40 + (n % 200);
  let creditDays = [0, 30, 60][n % 3];
  if (kind <= 1) {
    status = 'draft';
    daysAgo = 1 + (n % 12);
    creditDays = 30;
  } else if (kind === 2) {
    status = 'cancelled';
    daysAgo = 15 + (n % 100);
  } else if (kind <= 10) {
    paid = 'full';
    daysAgo = 20 + (n % 240);
  } else if (kind <= 12) {
    paid = 'partial';
    daysAgo = 70 + (n % 80);
    creditDays = 30;
  } else if (kind <= 16) {
    daysAgo = 2 + (n % 10);
    creditDays = 60;
  } else {
    daysAgo = 50 + (n % 90);
    creditDays = n % 2 === 0 ? 0 : 30;
  }
  return {
    buyer: n % DEMO_BUYERS.length,
    preset: PRESETS[n % PRESETS.length],
    items: (n % 4) + 1,
    daysAgo,
    creditDays,
    status,
    paid,
    scale: Math.round((0.35 + (n % 10) * 0.08) * 100) / 100,
    key: n,
  };
}

function demoInvoice(spec: DemoInvoice, invoiceDate: string): InvoiceState {
  const buyer = DEMO_BUYERS[spec.buyer];
  const preset = spec.preset;
  const scale = spec.scale ?? 1;
  const items = preset.items.slice(0, Math.min(spec.items, preset.items.length)).map((item, index) => {
    const carats = Math.round(item.carats * scale * 1000) / 1000;
    const totalAmount = Math.round(carats * item.ratePerCarat * 100) / 100;
    return {
      ...item,
      id: `demo-${spec.key ?? 'base'}-${index + 1}`,
      srNo: index + 1,
      parcelId: spec.key === undefined ? item.parcelId : `${item.parcelId}-${spec.key}`,
      carats,
      totalAmount,
    };
  });
  return {
    ...preset,
    exporter: { ...preset.exporter, companyName: 'Meridian Diamond Exports' },
    items,
    consignee: {
      ...preset.consignee,
      ...buyer,
      addressLine2: '',
      state: '',
      taxIdVat: '',
      buyerOtherThanConsignee: false,
    },
    shipment: {
      ...preset.shipment,
      invoiceNumber: '',
      invoiceDate,
      creditDays: spec.creditDays,
      paymentTerms: spec.creditDays === 0 ? 'Payment against documents' : `${spec.creditDays} days from invoice date`,
      countryOfDestination: buyer.country,
    },
  };
}

async function ensureDemoProfile(client: PoolClient, organizationId: string): Promise<void> {
  const preset = SURAT_TO_ANTWERP_PRESET;
  const profile = {
    invoicePrefix: DEMO_INVOICE_PREFIX,
    authorizedSignatoryName: preset.authorizedSignatoryName,
    authorizedSignatoryDesignation: preset.authorizedSignatoryDesignation,
    exporter: { ...preset.exporter, companyName: 'Meridian Diamond Exports' },
    bank: preset.bank,
  };
  await client.query('UPDATE organizations SET profile = $2::jsonb WHERE id = $1 AND profile IS NULL', [
    organizationId,
    JSON.stringify(profile),
  ]);
}

export async function seedDemoData(pool: DbPool, organizationId: string): Promise<{ invoices: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [organizationId]);
    const existing = await client.query('SELECT 1 FROM invoices WHERE organization_id = $1 LIMIT 1', [organizationId]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return { invoices: 0 };
    }

    const owner = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE organization_id = $1 ORDER BY (role = 'admin') DESC, created_at LIMIT 1`,
      [organizationId],
    );
    const userId = owner.rows[0]?.id ?? null;
    const today = (await client.query<{ today: string }>("SELECT to_char(current_date, 'YYYY-MM-DD') AS today")).rows[0].today;

    await ensureDemoProfile(client, organizationId);

    for (const buyer of DEMO_BUYERS) {
      await client.query('INSERT INTO buyers (organization_id, name, data) VALUES ($1, $2, $3::jsonb)', [
        organizationId,
        buyer.companyName,
        JSON.stringify({ ...buyer, addressLine2: '', state: '', taxIdVat: '' }),
      ]);
    }

    for (const spec of DEMO_INVOICES) {
      await insertDemoInvoice(client, organizationId, userId, today, spec);
    }

    await client.query('COMMIT');
    return { invoices: DEMO_INVOICES.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertDemoInvoice(
  client: PoolClient,
  organizationId: string,
  userId: string | null,
  today: string,
  spec: DemoInvoice,
): Promise<void> {
  const invoiceDate = addDays(today, -spec.daysAgo);
  const draft = demoInvoice(spec, invoiceDate);
  draft.shipment.invoiceNumber = await nextInvoiceNumber(client, organizationId);
  const validation = validateInvoice(draft);
  if (!validation.ok) throw new Error(`Demo invoice is invalid: ${validation.error}`);
  const facts = invoiceFacts(validation.invoice);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO invoices (user_id, organization_id, invoice_number, data, status, buyer_name,
                           destination_country, invoice_date, total_usd, total_carats, credit_days, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $8::date)
     RETURNING id`,
    [userId, organizationId, facts.invoiceNumber, JSON.stringify(validation.invoice), spec.status, facts.buyerName,
      facts.destinationCountry, facts.invoiceDate, facts.totalUsd, facts.totalCarats, facts.creditDays],
  );
  const invoiceId = inserted.rows[0].id;

  if (spec.paid && spec.status === 'issued' && facts.totalUsd > 0) {
    const amount = spec.paid === 'full' ? facts.totalUsd : Math.max(0.01, Math.round(facts.totalUsd * 0.4 * 100) / 100);
    const paidOn = addDays(invoiceDate, Math.min(spec.daysAgo - 1, Math.max(spec.creditDays, 1)));
    await client.query(
      `INSERT INTO payments (invoice_id, organization_id, amount_usd, paid_on, reference, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [invoiceId, organizationId, amount, paidOn, `SWIFT-DEMO-${facts.invoiceNumber.slice(-4)}`, userId],
    );
    await refreshPaidStatus(client, invoiceId);
  }

  if (spec.reminded) {
    await client.query(
      `INSERT INTO payment_reminders (organization_id, invoice_id, created_by, model, prompt_version, subject,
                                      body_html, status, created_at, sent_at)
       VALUES ($1, $2, $3, 'template', 'demo', $4, $5, 'sent', now() - interval '3 days', now() - interval '3 days')`,
      [organizationId, invoiceId, userId, `Payment reminder: invoice ${facts.invoiceNumber}`,
        `<p>Dear ${DEMO_BUYERS[spec.buyer].contactPerson},</p><p>This is a reminder that invoice ${facts.invoiceNumber} is past due.</p>`],
    );
  }
}

export async function fillDemoInvoices(
  pool: DbPool,
  organizationId: string,
  target = DEMO_INVOICE_TARGET,
): Promise<{ invoices: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [organizationId]);
    const count = await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM invoices WHERE organization_id = $1', [
      organizationId,
    ]);
    const have = count.rows[0].n;
    const need = target - have;
    if (need <= 0) {
      await client.query('COMMIT');
      return { invoices: 0 };
    }
    const owner = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE organization_id = $1 ORDER BY (role = 'admin') DESC, created_at LIMIT 1`,
      [organizationId],
    );
    const today = (await client.query<{ today: string }>("SELECT to_char(current_date, 'YYYY-MM-DD') AS today")).rows[0].today;
    for (let offset = 0; offset < need; offset += 1) {
      await insertDemoInvoice(client, organizationId, owner.rows[0]?.id ?? null, today, generatedSpec(have + offset));
    }
    await client.query('COMMIT');
    return { invoices: need };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function resetDemoData(pool: DbPool, organizationId: string): Promise<{ invoices: number }> {
  await pool.query('DELETE FROM assistant_sessions WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM ai_calls WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM email_dispatches WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM invoices WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM buyers WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM invoice_counters WHERE organization_id = $1', [organizationId]);
  const seeded = await seedDemoData(pool, organizationId);
  const filled = await fillDemoInvoices(pool, organizationId);
  return { invoices: seeded.invoices + filled.invoices };
}
