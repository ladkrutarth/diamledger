import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { createPool, migrateOnStart, runMigrationsWithRetry } from './server/db.js';
import { createApp } from './server/app.js';
import { flushMonitoring, initMonitoring, reportError } from './server/monitoring.js';
import { seedDemoUser } from './server/seed.js';

dotenv.config();

const port = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const distDir = path.resolve(process.cwd(), 'dist');

async function setupServer() {
  await initMonitoring();
  const pool = createPool();
  if (migrateOnStart()) {
    const applied = await runMigrationsWithRetry(pool);
    if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  }
  await seedDemoUser(pool);
  const app = createApp(pool);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir, { index: false }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(Number(port), '0.0.0.0', () => {
    console.log(`DiamondX-A1005 Precision Engine running on port ${port}`);
  });
}

setupServer().catch(async (error) => {
  console.error('Failed to start server:', error);
  await reportError(error, { path: 'startup' }).catch(() => undefined);
  await flushMonitoring().catch(() => undefined);
  process.exit(1);
});
