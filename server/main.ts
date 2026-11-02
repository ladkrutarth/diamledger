import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPool, migrateOnStart, runMigrationsWithRetry } from './core/db.js';
import { createApp } from './app.js';
import { flushMonitoring, initMonitoring, reportError } from './core/monitoring.js';
import { seedDemoUser } from './core/seed.js';

// Load .env from the project root (one folder up), so it works wherever the server is started from.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });
dotenv.config();
console.log(
  `AI provider: ${process.env.AI_PROVIDER || 'gemini'}; GEMINI_API_KEY ${process.env.GEMINI_API_KEY ? 'loaded' : 'MISSING'}; HF_TOKEN ${process.env.HF_TOKEN ? 'loaded' : 'missing'}`,
);

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
    console.log(`Meridian export desk running on port ${port}`);
  });
}

setupServer().catch(async (error) => {
  console.error('Failed to start server:', error);
  await reportError(error, { path: 'startup' }).catch(() => undefined);
  await flushMonitoring().catch(() => undefined);
  process.exit(1);
});
