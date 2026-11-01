import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import type { DbPool } from './db.js';
import { fillDemoInvoices, resetDemoData, seedDemoData } from './demoData.js';

export const DEMO_EMAIL = 'owner@example.com';
export const DEMO_MEMBER_EMAIL = 'priya.mehta@example.com';
export const DEMO_PASSWORD = 'password123';

export const DEMO_TEAM: Array<{ email: string; role: 'admin' | 'member' }> = [
  { email: DEMO_EMAIL, role: 'admin' },
  { email: 'anil.desai@example.com', role: 'admin' },
  { email: 'neha.kapoor@example.com', role: 'admin' },
  { email: DEMO_MEMBER_EMAIL, role: 'member' },
  { email: 'rahul.shah@example.com', role: 'member' },
  { email: 'kavita.joshi@example.com', role: 'member' },
  { email: 'arjun.patel@example.com', role: 'member' },
  { email: 'meera.nair@example.com', role: 'member' },
  { email: 'vikram.singh@example.com', role: 'member' },
  { email: 'ananya.iyer@example.com', role: 'member' },
  { email: 'rohan.gupta@example.com', role: 'member' },
  { email: 'sneha.reddy@example.com', role: 'member' },
  { email: 'karan.malhotra@example.com', role: 'member' },
  { email: 'divya.bose@example.com', role: 'member' },
  { email: 'amit.verma@example.com', role: 'member' },
  { email: 'pooja.kulkarni@example.com', role: 'member' },
  { email: 'nikhil.rao@example.com', role: 'member' },
  { email: 'isha.banerjee@example.com', role: 'member' },
  { email: 'dev.sharma@example.com', role: 'member' },
  { email: 'riya.choudhary@example.com', role: 'member' },
  { email: 'sameer.khan@example.com', role: 'member' },
  { email: 'lakshmi.pillai@example.com', role: 'member' },
  { email: 'harsh.agarwal@example.com', role: 'member' },
];

export function demoUserEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO_USER === 'true';
}

async function demoOrganizationId(pool: DbPool): Promise<string | undefined> {
  const result = await pool.query<{ organization_id: string }>('SELECT organization_id FROM users WHERE email = $1', [
    DEMO_EMAIL,
  ]);
  return result.rows[0]?.organization_id;
}

export async function seedDemoUser(pool: DbPool): Promise<void> {
  if (!demoUserEnabled()) {
    await disableDemoPassword(pool);
    return;
  }

  const existing = await demoOrganizationId(pool);
  if (existing) {
    await seedDemoData(pool, existing);
    await fillDemoInvoices(pool, existing);
    await ensureDemoTeam(pool, existing);
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org = await client.query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      ['Meridian Diamond Exports'],
    );
    await client.query(
      `INSERT INTO users (email, password_hash, organization_id, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [DEMO_EMAIL, passwordHash, org.rows[0].id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const demoOrg = await demoOrganizationId(pool);
  if (demoOrg) {
    await seedDemoData(pool, demoOrg);
    await fillDemoInvoices(pool, demoOrg);
    await ensureDemoTeam(pool, demoOrg);
  }
}

async function ensureDemoTeam(pool: DbPool, organizationId: string): Promise<void> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const person of DEMO_TEAM) {
    await pool.query(
      `INSERT INTO users (email, password_hash, organization_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [person.email, passwordHash, organizationId, person.role],
    );
  }
}

async function disableDemoPassword(pool: DbPool): Promise<void> {
  const result = await pool.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [DEMO_EMAIL],
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(DEMO_PASSWORD, user.password_hash))) return;

  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, unusable]);
  console.warn(`Disabled the public demo password for ${DEMO_EMAIL}. Use "Forgot password?" to set a new one.`);
}

async function main(): Promise<void> {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
  if (!demoUserEnabled()) {
    console.error('Refusing to seed demo data in production. Set SEED_DEMO_USER=true to allow it.');
    process.exitCode = 1;
    return;
  }
  const { createPool, runMigrations } = await import('./db.js');
  const pool = createPool();
  try {
    await runMigrations(pool);
    await seedDemoUser(pool);
    const organizationId = await demoOrganizationId(pool);
    if (!organizationId) throw new Error(`No ${DEMO_EMAIL} account to seed.`);
    if (process.argv.includes('--reset')) {
      console.log(`Resetting demo data for ${DEMO_EMAIL} only. Other companies are not touched.`);
      const { invoices } = await resetDemoData(pool, organizationId);
      console.log(`Reseeded ${invoices} demo invoices.`);
    } else {
      console.log(`Demo account ready: ${DEMO_EMAIL} / ${DEMO_PASSWORD}. Use --reset to wipe and reseed its data.`);
    }
  } finally {
    await pool.end();
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile && thisFile.endsWith(path.join('server', 'seed.ts'))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
