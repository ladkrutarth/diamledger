import crypto from 'crypto';
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
    connectionString: local ? connectionString : withoutSslParams(connectionString),
    connectionTimeoutMillis: 10000,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
}

/**
 * SSL is set by the `ssl` option above. An `sslmode` in the URL would override it and makes pg
 * print a security warning on every cold start, so it is removed here.
 */
export function withoutSslParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    for (const key of ['sslmode', 'ssl', 'uselibpqcompat']) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return connectionString;
  }
}

export function migrationsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'db/migrations'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('db/migrations was not found.');
  }
  return found;
}

type Migration = { version: string; sql: string; checksum: string };

export function loadMigrations(dir = migrationsDir()): Migration[] {
  return fs
    .readdirSync(dir)
    .filter((file) => /^\d{3,}_[\w-]+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      };
    });
}

const MIGRATION_LOCK_ID = 74102391;

export async function runMigrations(pool: DbPool, migrations = loadMigrations()): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // One transaction with a transaction-scoped lock. A session-level advisory lock can be left
    // behind forever when the database sits behind a transaction pooler (for example Neon's
    // "-pooler" host), which makes every later start wait until the request times out.
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const recorded = new Map(done.rows.map((row) => [row.version, row.checksum]));

    for (const migration of migrations) {
      const checksum = recorded.get(migration.version);
      if (checksum) {
        if (checksum !== migration.checksum) {
          console.warn(`Migration ${migration.version} was edited after it ran. Add a new migration instead.`);
        }
        continue;
      }
      await client.query('SAVEPOINT migration');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          migration.version,
          migration.checksum,
        ]);
        await client.query('RELEASE SAVEPOINT migration');
        applied.push(migration.version);
      } catch (error) {
        throw new Error(`Migration ${migration.version} failed: ${(error as Error).message}`);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return applied;
}

export async function runMigrationsWithRetry(pool: DbPool, attempts = 20): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runMigrations(pool);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || /^Migration /.test((error as Error).message)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

export function migrateOnStart(): boolean {
  return process.env.MIGRATE_ON_START !== 'false';
}
