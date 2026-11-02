import express, { type RequestHandler } from 'express';
import helmet from 'helmet';

export const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  // Razorpay Checkout: its script, the payment frame, and its logging endpoint.
  'script-src': ["'self'", 'https://checkout.razorpay.com'],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
  'img-src': ["'self'", 'data:', 'blob:', 'https://cdn.razorpay.com'],
  'connect-src': [
    "'self'",
    'https://*.ingest.sentry.io',
    'https://*.ingest.us.sentry.io',
    'https://*.ingest.de.sentry.io',
    'https://api.razorpay.com',
    'https://lumberjack.razorpay.com',
  ],
  'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

export function contentSecurityPolicy(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

export function securityHeaders(): RequestHandler {
  const production = process.env.NODE_ENV === 'production';
  return helmet({
    contentSecurityPolicy: production ? { useDefaults: false, directives: CSP_DIRECTIVES } : false,
    strictTransportSecurity: production ? { maxAge: 63072000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

export const DEFAULT_JSON_LIMIT = '1mb';

const LARGE_BODY_ROUTES: Record<string, string> = {
  '/api/parse-manifest': '15mb',
  '/api/bank/parse-statement': '15mb',
  '/api/bank/import-lines': '3mb',
  '/api/send-email': '25mb',
  '/api/purchases/gstr2b': '3mb',
  '/api/tally/import': '4mb',
};

export function jsonBodyParser(): RequestHandler {
  const parsers = new Map<string, RequestHandler>();
  const parserFor = (limit: string) => {
    let parser = parsers.get(limit);
    if (!parser) {
      parser = express.json({ limit });
      parsers.set(limit, parser);
    }
    return parser;
  };

  // Razorpay signs the exact bytes of a webhook, so that body is kept raw. This runs before reading
  // req.body, because on Vercel reading it parses the body and the original bytes are lost.
  const rawWebhook = express.raw({ type: () => true, limit: '1mb' });

  return (req, res, next) => {
    if (req.path === '/api/billing/webhook' && !req.readableEnded) return rawWebhook(req, res, next);
    if (req.body !== undefined || req.readableEnded) return next();
    const documentUpload =
      /^\/api\/invoices\/[^/]+\/documents$/.test(req.path) || /^\/api\/requests\/[^/]+\/messages$/.test(req.path) ||
      req.path === '/api/bank/import' || req.path === '/api/tax/ebrc/import';
    return parserFor(LARGE_BODY_ROUTES[req.path] ?? (documentUpload ? '3mb' : DEFAULT_JSON_LIMIT))(req, res, next);
  };
}
