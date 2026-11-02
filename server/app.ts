import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { DbPool } from './db.js';
import { geminiAssistantModel, type AssistantModel } from './assistant/agent.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { loadUser, registerAuthRoutes } from './auth.js';
import { registerTaxRoutes } from './tax.js';
import { registerFilingRoutes } from './filing.js';
import { registerBankRoutes } from './bank.js';
import { registerRealizationRoutes } from './realization.js';
import { registerForexRoutes } from './forex.js';
import { registerWorkspaceRoutes } from './workspace.js';
import type { CurrentUser } from './http.js';
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
import { geminiReminderText, registerReminderRoutes, type DraftReminderText } from './reminders.js';
import { jsonBodyParser, securityHeaders } from './security.js';
import { registerTeamRoutes } from './team.js';
import './types.js';

export type AppOptions = {
  sendPasswordResetEmail?: SendPasswordResetEmail;
  createMailTransport?: CreateMailTransport;
  draftReminderText?: DraftReminderText;
  assistantModel?: AssistantModel;
};

const PgSession = connectPgSimple(session);

function charteredAccountantGuard(req: Request, res: Response, next: NextFunction): void {
  const user = res.locals.user as CurrentUser | undefined;
  if (!user || user.role !== 'ca' || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const path = req.path;
  const allowed =
    path === '/api/auth/logout' ||
    path === '/api/auth/change-password' ||
    path === '/api/workspace/switch' ||
    path.startsWith('/api/assistant/') ||
    /^\/api\/invoices\/[0-9a-f-]{36}\/review$/.test(path) ||
    /^\/api\/tax\/months\/\d{4}-\d{2}\/(close|open)$/.test(path);
  if (!allowed) {
    res.status(403).json({
      error: 'A chartered accountant account can review invoices, close months, and use the assistant. It cannot change invoices, payments, buyers, or the team.',
    });
    return;
  }
  next();
}

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
  app.use(charteredAccountantGuard);
  registerRateLimits(app, pool);

  registerAuthRoutes(app, pool, options.sendPasswordResetEmail ?? sendPasswordResetEmail);
  registerInvoiceRoutes(app, pool);
  registerTaxRoutes(app, pool);
  registerFilingRoutes(app, pool);
  registerBankRoutes(app, pool);
  registerRealizationRoutes(app, pool);
  registerForexRoutes(app, pool);
  registerWorkspaceRoutes(app, pool);
  registerPaymentRoutes(app, pool);
  registerCompanyRoutes(app, pool);
  registerDashboardRoutes(app, pool);
  registerTeamRoutes(app, pool);
  registerLegacyRoutes(app, pool);
  registerEmailRoutes(app, pool, options.createMailTransport ?? createSmtpTransport);
  registerReminderRoutes(
    app,
    pool,
    options.draftReminderText ?? geminiReminderText,
    options.createMailTransport ?? createSmtpTransport,
  );
  registerAssistantRoutes(
    app,
    pool,
    options.assistantModel ?? geminiAssistantModel,
    options.draftReminderText ?? geminiReminderText,
  );

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
