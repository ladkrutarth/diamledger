import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

export type DbPool = pg.Pool;

export function createPool(connectionString = process.env.DATABASE_URL): DbPool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required.');
  }
  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 10000,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
}

function schemaPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'db/schema.sql'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('db/schema.sql was not found.');
  }
  return found;
}

const SCHEMA_LOCK_ID = 74102391;

export async function applySchema(pool: DbPool): Promise<void> {
  const sql = fs.readFileSync(schemaPath(), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_ID]);
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

export async function applySchemaWithRetry(pool: DbPool, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await applySchema(pool);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}
