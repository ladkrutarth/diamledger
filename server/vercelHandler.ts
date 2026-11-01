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
      const { createPool, applySchema } = await import('./db');
      const { createApp } = await import('./app');
      const { seedDemoUser } = await import('./seed');
      const pool = createPool();
      await applySchema(pool);
      await seedDemoUser(pool);
      return createApp(pool);
    })().catch((error: unknown) => {
      appPromise = undefined;
      console.error('Vercel API failed to start:', error);
      const message = error instanceof Error ? error.message : 'Could not connect to the database.';
      return errorApp(message);
    });
  }
  return appPromise;
}

export function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const search = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  req.url = `${pathname}${search}`;
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
