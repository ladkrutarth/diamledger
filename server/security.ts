import express, { type RequestHandler } from 'express';
import helmet from 'helmet';

export const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
  'img-src': ["'self'", 'data:', 'blob:'],
  'connect-src': ["'self'", 'https://*.ingest.sentry.io', 'https://*.ingest.us.sentry.io', 'https://*.ingest.de.sentry.io'],
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
  '/api/send-email': '25mb',
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

  return (req, res, next) => {
    if (req.body !== undefined || req.readableEnded) return next();
    return parserFor(LARGE_BODY_ROUTES[req.path] ?? DEFAULT_JSON_LIMIT)(req, res, next);
  };
}
