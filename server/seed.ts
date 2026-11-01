import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { DbPool } from './db.js';

export const DEMO_EMAIL = 'owner@example.com';
export const DEMO_PASSWORD = 'password123';

export function demoUserEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO_USER === 'true';
}

export async function seedDemoUser(pool: DbPool): Promise<void> {
  if (!demoUserEnabled()) {
    await disableDemoPassword(pool);
    return;
  }

  const existing = await pool.query('SELECT 1 FROM users WHERE email = $1', [DEMO_EMAIL]);
  if (existing.rowCount) return;

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org = await client.query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      ['xyz LLC'],
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
