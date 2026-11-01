import bcrypt from 'bcryptjs';
import type { DbPool } from './db.js';

export async function seedDemoUser(pool: DbPool): Promise<void> {
  const existing = await pool.query('SELECT 1 FROM users WHERE email = $1', ['owner@example.com']);
  if (existing.rowCount) return;

  const passwordHash = await bcrypt.hash('password123', 10);
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
      ['owner@example.com', passwordHash, org.rows[0].id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
