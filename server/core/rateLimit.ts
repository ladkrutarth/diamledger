import type { Express, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit, type IncrementResponse, type Options, type Store } from 'express-rate-limit';
import type { DbPool } from './db.js';
import { normalizeEmail } from '../modules/auth/auth.js';
import type { CurrentUser } from './http.js';

class PostgresStore implements Store {
  localKeys = false;
  prefix: string;
  private windowMs = 60_000;

  constructor(
    private pool: DbPool,
    prefix: string,
  ) {
    this.prefix = `${prefix}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const result = await this.pool.query<{ hits: number; reset_at: Date }>(
      `INSERT INTO rate_limits (key, hits, reset_at)
       VALUES ($1, 1, now() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [this.prefix + key, this.windowMs / 1000],
    );
    return { totalHits: result.rows[0].hits, resetTime: result.rows[0].reset_at };
  }

  async decrement(key: string): Promise<void> {
    await this.pool.query('UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1', [this.prefix + key]);
  }

  async resetKey(key: string): Promise<void> {
    await this.pool.query('DELETE FROM rate_limits WHERE key = $1', [this.prefix + key]);
  }
}

function clientIp(req: Request): string {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown');
}

function userOrIp(req: Request, res: Response): string {
  const user = res.locals.user as CurrentUser | undefined;
  return user ? `user:${user.id}` : `ip:${clientIp(req)}`;
}

type LimitRule = {
  path: string;
  name: string;
  windowMinutes: number;
  limit: number;
  message: string;
  key: (req: Request, res: Response) => string;
  skipSuccessfulRequests?: boolean;
  method?: 'get' | 'post';
};

const RULES: LimitRule[] = [
  {
    path: '/api/auth/login',
    name: 'login',
    windowMinutes: 15,
    limit: 10,
    message: 'Too many failed sign-in attempts. Wait 15 minutes, or reset your password.',
    key: (req) => `${clientIp(req)}:${normalizeEmail(req.body?.email)}`,
    skipSuccessfulRequests: true,
  },
  {
    path: '/api/auth/register',
    name: 'register',
    windowMinutes: 60,
    limit: 5,
    message: 'Too many accounts created from this network. Try again in an hour.',
    key: (req) => clientIp(req),
  },
  {
    path: '/api/auth/forgot-password',
    name: 'forgot',
    windowMinutes: 60,
    limit: 5,
    message: 'Too many reset requests. Try again in an hour.',
    key: (req) => clientIp(req),
  },
  {
    path: '/api/auth/reset-password',
    name: 'reset',
    windowMinutes: 60,
    limit: 10,
    message: 'Too many reset attempts. Try again in an hour.',
    key: (req) => clientIp(req),
  },
  {
    path: '/api/send-email',
    name: 'send-email',
    windowMinutes: 60,
    limit: 30,
    message: 'Email limit reached: 30 emails per hour. Try again later.',
    key: userOrIp,
  },
  {
    path: '/api/verify-smtp',
    name: 'verify-smtp',
    windowMinutes: 60,
    limit: 20,
    message: 'Too many SMTP checks. Try again in an hour.',
    key: userOrIp,
  },
  {
    path: '/api/parse-manifest',
    name: 'parse-manifest',
    windowMinutes: 60,
    limit: 60,
    message: 'AI parsing limit reached: 60 manifests per hour. Try again later.',
    key: userOrIp,
  },
  {
    path: '/api/bank/parse-statement',
    name: 'parse-statement',
    windowMinutes: 60,
    limit: 30,
    message: 'AI statement reading limit reached: 30 statements per hour. Try again later.',
    key: userOrIp,
  },
  {
    path: '/api/portal/:token',
    name: 'buyer-portal',
    method: 'get',
    windowMinutes: 15,
    limit: 120,
    message: 'Too many requests. Try again in a few minutes.',
    key: (req) => clientIp(req),
  },
  {
    path: '/api/reminders/draft',
    name: 'reminder-draft',
    windowMinutes: 60,
    limit: 60,
    message: 'Reminder drafting limit reached: 60 drafts per hour. Try again later.',
    key: userOrIp,
  },
  {
    path: '/api/reminders/:id/send',
    name: 'reminder-send',
    windowMinutes: 60,
    limit: 30,
    message: 'Reminder limit reached: 30 reminders per hour. Try again later.',
    key: userOrIp,
  },
  {
    path: '/api/assistant/sessions/:id/messages',
    name: 'assistant-message',
    windowMinutes: 60,
    limit: 30,
    message: 'Assistant limit reached: 30 questions per hour. Try again later.',
    key: userOrIp,
  },
  {
    path: '/api/notices/:id/draft-reply',
    name: 'notice-draft',
    windowMinutes: 60,
    limit: 30,
    message: 'Notice drafting limit reached: 30 drafts per hour. Try again later.',
    key: userOrIp,
  },
  {
    path: '/api/billing/checkout',
    name: 'billing-checkout',
    windowMinutes: 60,
    limit: 20,
    message: 'Too many checkout attempts. Try again in an hour.',
    key: userOrIp,
  },
  {
    path: '/api/billing/paypal/order',
    name: 'paypal-order',
    windowMinutes: 60,
    limit: 20,
    message: 'Too many PayPal attempts. Try again in an hour.',
    key: userOrIp,
  },
  {
    path: '/api/billing/bank-transfer',
    name: 'bank-transfer',
    windowMinutes: 60,
    limit: 10,
    message: 'Too many bank transfer requests. Try again in an hour.',
    key: userOrIp,
  },
  {
    path: '/api/tally/import',
    name: 'tally-import',
    windowMinutes: 60,
    limit: 30,
    message: 'Too many Tally imports. Try again in an hour.',
    key: userOrIp,
  },
  {
    path: '/api/assistant/reviews',
    name: 'assistant-review',
    windowMinutes: 60,
    limit: 10,
    message: 'Month review limit reached: 10 reviews per hour. Try again later.',
    key: userOrIp,
  },
];

export function registerRateLimits(app: Express, pool: DbPool): void {
  for (const rule of RULES) {
    app[rule.method ?? 'post'](
      rule.path,
      rateLimit({
        windowMs: rule.windowMinutes * 60_000,
        limit: rule.limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skipSuccessfulRequests: rule.skipSuccessfulRequests ?? false,
        keyGenerator: rule.key,
        message: { error: rule.message },
        store: new PostgresStore(pool, rule.name),
      }),
    );
  }
}
