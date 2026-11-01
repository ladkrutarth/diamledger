import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { DbPool } from './db.js';
import { loadUser, registerAuthRoutes } from './auth.js';
import { registerCompanyRoutes } from './company.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerHealthRoute } from './health.js';
import { reportError } from './monitoring.js';
import { createSmtpTransport, registerEmailRoutes, type CreateMailTransport } from './emailDispatch.js';
import { registerInvoiceRoutes } from './invoices.js';
import { registerLegacyRoutes } from './legacyRoutes.js';
import { sendPasswordResetEmail, type SendPasswordResetEmail } from './mailer.js';
import { registerPaymentRoutes } from './payments.js';
import { registerRateLimits } from './rateLimit.js';
import { jsonBodyParser, securityHeaders } from './security.js';
import { registerTeamRoutes } from './team.js';
import './types.js';

export type AppOptions = {
  sendPasswordResetEmail?: SendPasswordResetEmail;
  createMailTransport?: CreateMailTransport;
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
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.use(jsonBodyParser());
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  registerHealthRoute(app, pool);
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
  registerRateLimits(app, pool);

  registerAuthRoutes(app, pool, options.sendPasswordResetEmail ?? sendPasswordResetEmail);
  registerInvoiceRoutes(app, pool);
  registerPaymentRoutes(app, pool);
  registerCompanyRoutes(app, pool);
  registerDashboardRoutes(app, pool);
  registerTeamRoutes(app, pool);
  registerLegacyRoutes(app);
  registerEmailRoutes(app, pool, options.createMailTransport ?? createSmtpTransport);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl || req.url}` });
  });

  app.use(async (error: any, req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) {
      console.error('API error:', error);
      const user = res.locals.user;
      await reportError(error, {
        method: req.method,
        path: req.path,
        userId: user?.id,
        organizationId: user?.organizationId,
      }).catch(() => undefined);
    }
    if (res.headersSent) return;
    const message =
      status === 500
        ? 'Something went wrong. Please try again.'
        : error?.type === 'entity.too.large'
          ? 'The request is too large.'
          : error.message;
    res.status(status).json({ error: message });
  });

  return app;
}
