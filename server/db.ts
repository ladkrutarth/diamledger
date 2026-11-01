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

export async function applySchema(pool: DbPool): Promise<void> {
  const sql = fs.readFileSync(schemaPath(), 'utf8');
  await pool.query(sql);
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
