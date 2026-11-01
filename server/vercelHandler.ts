import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type Express } from 'express';

let appPromise: Promise<Express> | undefined;

function errorApp(message: string): Express {
  const app = express();
  app.use((_req, res) => {
    res.status(503).json({ error: message });
  });
  return app;
}

function getApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = (async () => {
      if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {
        return errorApp('Set DATABASE_URL and SESSION_SECRET in the Vercel project settings, then redeploy.');
      }
      const { initMonitoring } = await import('./monitoring.js');
      await initMonitoring();
      const { createPool, migrateOnStart, runMigrations } = await import('./db.js');
      const { createApp } = await import('./app.js');
      const { seedDemoUser } = await import('./seed.js');
      const pool = createPool();
      if (migrateOnStart()) await runMigrations(pool);
      await seedDemoUser(pool);
      return createApp(pool);
    })().catch(async (error: unknown) => {
      appPromise = undefined;
      console.error('Vercel API failed to start:', error);
      const { reportError } = await import('./monitoring.js');
      await reportError(error, { path: 'startup' }).catch(() => undefined);
      const message = error instanceof Error ? error.message : 'Could not connect to the database.';
      return errorApp(message);
    });
  }
  return appPromise;
}

export function apiUrl(rawUrl: string): string {
  const url = new URL(rawUrl || '/', 'http://localhost');
  const rewrittenPath = url.searchParams.get('__path');
  url.searchParams.delete('__path');
  const pathname =
    rewrittenPath !== null ? `/api/${rewrittenPath.replace(/^\/+/, '')}` : url.pathname;
  const search = url.searchParams.toString();
  return `${pathname}${search ? `?${search}` : ''}`;
}

export function handleApi(req: IncomingMessage, res: ServerResponse): void {
  req.url = apiUrl(req.url || '/');
  getApp()
    .then((app) => {
      app(req, res);
    })
    .catch((error) => {
      console.error(error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'The API failed to start.' }));
    });
}
