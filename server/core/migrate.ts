import dotenv from 'dotenv';
import { createPool, runMigrationsWithRetry } from './db.js';

dotenv.config();

const pool = createPool();
try {
  const applied = await runMigrationsWithRetry(pool, 5);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date.');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
