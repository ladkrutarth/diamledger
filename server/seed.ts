import bcrypt from 'bcryptjs';
import type { DbPool } from './db.js';

export async function seedDemoUser(pool: DbPool): Promise<void> {
  const passwordHash = await bcrypt.hash('password123', 10);
  await pool.query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    ['owner@example.com', passwordHash],
  );
}
