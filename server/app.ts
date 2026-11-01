import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { DbPool } from './db.js';
import { loadUser, registerAuthRoutes } from './auth.js';
import { registerCompanyRoutes } from './company.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerInvoiceRoutes } from './invoices.js';
import { registerLegacyRoutes } from './legacyRoutes.js';
import { sendPasswordResetEmail, type SendPasswordResetEmail } from './mailer.js';
import { registerPaymentRoutes } from './payments.js';
import { registerTeamRoutes } from './team.js';
import './types.js';

export type AppOptions = {
  sendPasswordResetEmail?: SendPasswordResetEmail;
};

const PgSession = connectPgSimple(session);

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required.');
  }
  return 'dev-only-session-secret';
}

export function createApp(pool: DbPool, options: AppOptions = {}): Express {
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

  app.use(loadUser(pool));

  registerAuthRoutes(app, pool, options.sendPasswordResetEmail ?? sendPasswordResetEmail);
  registerInvoiceRoutes(app, pool);
  registerPaymentRoutes(app, pool);
  registerCompanyRoutes(app, pool);
  registerDashboardRoutes(app, pool);
  registerTeamRoutes(app, pool);
  registerLegacyRoutes(app);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl || req.url}` });
  });

  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error('API error:', error);
    if (res.headersSent) return;
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : error.message });
  });

  return app;
}
