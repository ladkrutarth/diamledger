import type { Express } from 'express';
import type { DbPool } from './db.js';

const DB_TIMEOUT_MS = 3000;

export function registerHealthRoute(app: Express, pool: DbPool): void {
  app.get('/api/health', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('Database check timed out.')), DB_TIMEOUT_MS).unref(),
        ),
      ]);
      res.json({ status: 'ok', database: 'ok' });
    } catch (error) {
      console.error('Health check failed:', error);
      res.status(503).json({ status: 'error', database: 'unreachable' });
    }
  });
}
