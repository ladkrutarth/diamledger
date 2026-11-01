import express, { type Express } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { DbPool } from './db.js';
import { registerAuthRoutes } from './auth.js';
import { registerInvoiceRoutes } from './invoices.js';
import { registerLegacyRoutes } from './legacyRoutes.js';
import './types.js';

const PgSession = connectPgSimple(session);

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required.');
  }
  return 'dev-only-session-secret';
}

export function createApp(pool: DbPool): Express {
  const app = express();
  const onVercel = process.env.VERCEL === '1';
  const store = new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: false,
  });

  app.set('trust proxy', 1);
  app.set('sessionStore', store);
  const jsonParser = express.json({ limit: '50mb' });
  app.use((req, res, next) => {
    const bodyAlreadyRead = req.body !== undefined || req.readableEnded;
    if (bodyAlreadyRead) return next();
    return jsonParser(req, res, next);
  });
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(
    session({
      store,
      secret: sessionSecret(),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: onVercel,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  registerAuthRoutes(app, pool);
  registerInvoiceRoutes(app, pool);
  registerLegacyRoutes(app);

  app.use((req, res) => {
    res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl || req.url}` });
  });

  return app;
}
