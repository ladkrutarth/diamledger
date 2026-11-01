import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type Express } from 'express';
import { applySchema, createPool } from '../server/db';
import { createApp } from '../server/app';
import { seedDemoUser } from '../server/seed';

let appPromise: Promise<Express> | undefined;

function databaseError(message: string): Express {
  const app = express();
  app.use('/api', (_req, res) => {
    res.status(503).json({ error: message });
  });
  return app;
}

function getApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = startApp().catch((error) => {
      appPromise = undefined;
      console.error('Vercel API failed to start:', error);
      return databaseError('Could not connect to the database. Check DATABASE_URL in Vercel.');
    });
  }
  return appPromise;
}

async function startApp(): Promise<Express> {
  if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {
    return databaseError('Set DATABASE_URL and SESSION_SECRET in the Vercel project settings.');
  }
  const pool = createPool();
  await applySchema(pool);
  await seedDemoUser(pool);
  return createApp(pool);
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  getApp()
    .then((app) => {
      app(req, res);
    })
    .catch((error) => {
      console.error(error);
      res.statusCode = 500;
      res.end('The API failed to start.');
    });
}
