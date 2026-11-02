import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { DbPool } from './core/db.js';
import { defaultAssistantModel, type AssistantModel } from './assistant/agent.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { loadUser, registerAuthRoutes } from './modules/auth/auth.js';
import { registerTaxRoutes } from './modules/tax/tax.js';
import { registerFilingRoutes } from './modules/tax/filing.js';
import { registerBankRoutes } from './modules/banking/bank.js';
import { registerRealizationRoutes } from './modules/tax/realization.js';
import { registerForexRoutes } from './modules/tax/forex.js';
import { registerWorkspaceRoutes } from './modules/accountant/workspace.js';
import type { CurrentUser } from './core/http.js';
import { registerCompanyRoutes } from './modules/company/company.js';
import { registerDashboardRoutes } from './modules/invoices/dashboard.js';
import { registerHealthRoute } from './core/health.js';
import { reportError } from './core/monitoring.js';
import { createSmtpTransport, registerEmailRoutes, type CreateMailTransport } from './modules/collections/emailDispatch.js';
import { registerInvoiceRoutes } from './modules/invoices/invoices.js';
import { registerLegacyRoutes } from './modules/invoices/legacyRoutes.js';
import { sendPasswordResetEmail, type SendPasswordResetEmail } from './core/mailer.js';
import { registerPaymentRoutes } from './modules/invoices/payments.js';
import { registerRateLimits } from './core/rateLimit.js';
import { defaultReminderText, registerReminderRoutes, type DraftReminderText } from './modules/collections/reminders.js';
import { jsonBodyParser, securityHeaders } from './core/security.js';
import { registerTeamRoutes } from './modules/auth/team.js';
import { auditTrail, registerAuditRoutes } from './modules/activity/audit.js';
import { registerExportReportRoutes } from './modules/tax/exportReports.js';
import { registerParcelRoutes } from './modules/stock/parcels.js';
import { registerPortalRoutes } from './modules/invoices/portal.js';
import { registerRateRoutes } from './modules/tax/rates.js';
import { registerStatementReaderRoutes } from './modules/banking/statementReader.js';
import { registerAuditCheckRoutes } from './modules/tax/auditChecks.js';
import { registerAuditPackRoutes } from './modules/tax/auditPack.js';
import { registerBuyerRiskRoutes } from './modules/company/buyerRisk.js';
import { registerClientRequestRoutes } from './modules/accountant/clientRequests.js';
import { registerForeignPaymentRoutes } from './modules/tax/foreignPayments.js';
import { defaultNoticeReply, registerNoticeRoutes, type DraftNoticeReply } from './modules/tax/notices.js';
import { registerPracticeRoutes } from './modules/accountant/practice.js';
import { registerBillingRoutes, subscriptionGuard } from './modules/billing/billing.js';
import { registerPurchaseRoutes } from './modules/tax/purchases.js';
import { registerStockRoutes } from './modules/stock/stock.js';
import { registerTallySyncRoutes } from './modules/banking/tallySync.js';
import './core/types.js';

export type AppOptions = {
  sendPasswordResetEmail?: SendPasswordResetEmail;
  createMailTransport?: CreateMailTransport;
  draftReminderText?: DraftReminderText;
  assistantModel?: AssistantModel;
  fetchRates?: typeof fetch;
  draftNoticeReply?: DraftNoticeReply;
  razorpayFetch?: typeof fetch;
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
    path.startsWith('/api/practice/') ||
    path === '/api/requests' ||
    /^\/api\/requests\/[0-9a-f-]{36}\/(messages|status)$/.test(path) ||
    (path.startsWith('/api/notices') && req.method !== 'DELETE') ||
    /^\/api\/invoices\/[0-9a-f-]{36}\/review$/.test(path) ||
    /^\/api\/tax\/months\/\d{4}-\d{2}\/(close|open)$/.test(path);
  if (!allowed) {
    res.status(403).json({
      error: 'A chartered accountant account can review invoices, close months, raise requests, track notices, and use the assistant. It cannot change invoices, payments, buyers, or the team.',
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
  app.use(subscriptionGuard(pool));
  registerRateLimits(app, pool);
  app.use(auditTrail(pool));

  registerAuthRoutes(app, pool, options.sendPasswordResetEmail ?? sendPasswordResetEmail);
  registerInvoiceRoutes(app, pool);
  registerTaxRoutes(app, pool);
  registerFilingRoutes(app, pool);
  registerBankRoutes(app, pool);
  registerStatementReaderRoutes(app, pool);
  registerRateRoutes(app, pool, options.fetchRates ?? fetch);
  registerAuditRoutes(app, pool);
  registerExportReportRoutes(app, pool);
  registerParcelRoutes(app, pool);
  registerPortalRoutes(app, pool);
  registerBillingRoutes(app, pool, options.razorpayFetch ?? fetch);
  registerPurchaseRoutes(app, pool);
  registerStockRoutes(app, pool);
  registerAuditCheckRoutes(app, pool);
  registerAuditPackRoutes(app, pool);
  registerForeignPaymentRoutes(app, pool);
  registerTallySyncRoutes(app, pool);
  registerClientRequestRoutes(app, pool);
  registerNoticeRoutes(app, pool, options.draftNoticeReply ?? defaultNoticeReply);
  registerPracticeRoutes(app, pool);
  registerBuyerRiskRoutes(app, pool);
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
    options.draftReminderText ?? defaultReminderText,
    options.createMailTransport ?? createSmtpTransport,
  );
  registerAssistantRoutes(
    app,
    pool,
    options.assistantModel ?? defaultAssistantModel,
    options.draftReminderText ?? defaultReminderText,
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
