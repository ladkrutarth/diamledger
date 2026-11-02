import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { DbPool } from '../../core/db.js';
import { asyncHandler, currentUser, requireAdmin, requireUser, type CurrentUser } from '../../core/http.js';
import {
  FEATURE_LABELS,
  GRACE_DAYS,
  TRIAL_DAYS,
  TRIAL_PLAN,
  featureForPath,
  featureUsesHomeCompany,
  isCycle,
  planByKey,
  priceFor,
  publicPlans,
  type BillingCycle,
  type Plan,
  type PlanKey,
} from './plans.js';
import {
  RazorpayError,
  checkoutSignatureValid,
  razorpayClient,
  razorpayConfigured,
  razorpayKeyId,
  webhookSignatureValid,
  type RazorpayClient,
  type RazorpaySubscription,
} from './razorpay.js';
import { isPlatformAdmin, paymentOptions } from './providers.js';

const DAY_MS = 86_400_000;

type SubscriptionRow = {
  organization_id: string;
  plan_key: PlanKey | 'trial';
  billing_cycle: BillingCycle | null;
  status: string;
  trial_ends_at: Date;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  razorpay_subscription_id: string | null;
  pending_subscription_id: string | null;
  pending_plan_key: PlanKey | null;
  pending_cycle: BillingCycle | null;
  payment_method: PaymentProvider | null;
};

export type PaymentProvider = 'razorpay' | 'bank_transfer' | 'paypal';

export type Access = 'trial' | 'active' | 'grace' | 'lapsed';

/** The company's subscription, starting a free trial the first time a company is seen. */
export async function loadSubscription(pool: DbPool, organizationId: string): Promise<SubscriptionRow> {
  const found = await pool.query<SubscriptionRow>('SELECT * FROM organization_subscriptions WHERE organization_id = $1', [organizationId]);
  if (found.rows[0]) return found.rows[0];
  await pool.query(
    `INSERT INTO organization_subscriptions (organization_id, trial_ends_at)
     VALUES ($1, now() + make_interval(days => $2)) ON CONFLICT (organization_id) DO NOTHING`,
    [organizationId, TRIAL_DAYS],
  );
  return (await pool.query<SubscriptionRow>('SELECT * FROM organization_subscriptions WHERE organization_id = $1', [organizationId])).rows[0];
}

const LIVE_STATUSES = new Set(['active', 'authenticated', 'pending', 'halted']);

/**
 * What the company may do now. A paid plan keeps working until its period ends; after that there are
 * GRACE_DAYS while Razorpay retries a failed charge, then the company becomes read-only.
 */
export function accessOf(row: SubscriptionRow, now = new Date()): { access: Access; plan: Plan; daysLeft: number | null } {
  if (row.plan_key === 'trial') {
    const daysLeft = Math.ceil((row.trial_ends_at.getTime() - now.getTime()) / DAY_MS);
    return { access: daysLeft > 0 ? 'trial' : 'lapsed', plan: TRIAL_PLAN, daysLeft: Math.max(daysLeft, 0) };
  }
  const plan = planByKey(row.plan_key) ?? TRIAL_PLAN;
  const end = row.current_period_end;
  if (!end) return { access: LIVE_STATUSES.has(row.status) ? 'active' : 'lapsed', plan, daysLeft: null };
  const daysLeft = Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
  if (now <= end) return { access: 'active', plan, daysLeft };
  if (LIVE_STATUSES.has(row.status) && now.getTime() <= end.getTime() + GRACE_DAYS * DAY_MS) return { access: 'grace', plan, daysLeft };
  return { access: 'lapsed', plan, daysLeft };
}

export async function usageOf(pool: DbPool, organizationId: string) {
  const result = await pool.query<{ users: string; invoices: string; clients: string }>(
    `SELECT (SELECT COUNT(*) FROM users WHERE organization_id = $1) AS users,
            (SELECT COUNT(*) FROM invoices WHERE organization_id = $1 AND issued_at >= date_trunc('month', now())) AS invoices,
            (SELECT COUNT(DISTINCT a.organization_id) FROM organization_access a JOIN users u ON u.id = a.user_id
              WHERE u.organization_id = $1) AS clients`,
    [organizationId],
  );
  const row = result.rows[0];
  return { users: Number(row.users), invoicesThisMonth: Number(row.invoices), clients: Number(row.clients) };
}

export type LimitKind = 'users' | 'invoices' | 'clients';

/** A message when adding one more would go over the plan, or null when it fits. */
export async function limitMessage(pool: DbPool, organizationId: string, kind: LimitKind): Promise<string | null> {
  const { plan } = accessOf(await loadSubscription(pool, organizationId));
  const usage = await usageOf(pool, organizationId);
  if (kind === 'users' && usage.users >= plan.limits.users) {
    return `The ${plan.name} plan allows ${plan.limits.users} users. Upgrade under Plan & billing to add more.`;
  }
  if (kind === 'invoices' && plan.limits.invoicesPerMonth !== null && usage.invoicesThisMonth >= plan.limits.invoicesPerMonth) {
    return `The ${plan.name} plan allows ${plan.limits.invoicesPerMonth} issued invoices a month, and this month's are used. Upgrade under Plan & billing, or issue it next month.`;
  }
  if (kind === 'clients' && usage.clients >= (plan.limits.clients ?? 0)) {
    return plan.limits.clients
      ? `That accountant's plan allows ${plan.limits.clients} client companies, and they are all in use.`
      : `That accountant's firm is not on the CA Firm plan, so it cannot take client companies yet.`;
  }
  return null;
}

/** Paths that keep working with no plan, so a company can always sign in, pay, and leave. */
function alwaysAllowed(path: string): boolean {
  return /^\/api\/(auth|billing|health|workspace|platform)(\/|$)/.test(path);
}

const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Runs after the user is loaded: read-only once the plan lapses, and locks features the plan does not include. */
export function subscriptionGuard(pool: DbPool) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = res.locals.user as CurrentUser | undefined;
    if (!user || !req.path.startsWith('/api/') || alwaysAllowed(req.path)) {
      next();
      return;
    }
    (async () => {
      const own = accessOf(await loadSubscription(pool, user.organizationId));
      if (own.access === 'lapsed' && !READ.has(req.method)) {
        const ended = own.plan === TRIAL_PLAN ? 'The free trial has ended' : 'The subscription has ended';
        res.status(402).json({
          error: `${ended}, so this company is read-only. ${user.role === 'admin' ? 'Choose a plan under Plan & billing' : 'Ask a company admin to choose a plan'} to keep working. Your data is safe and can still be viewed and downloaded.`,
          code: 'subscription_lapsed',
        });
        return;
      }
      const feature = featureForPath(req.path);
      if (feature) {
        const checked =
          featureUsesHomeCompany(feature) && user.homeOrganizationId !== user.organizationId
            ? accessOf(await loadSubscription(pool, user.homeOrganizationId))
            : own;
        if (!checked.plan.features.includes(feature)) {
          const { label, plan } = FEATURE_LABELS[feature];
          res.status(402).json({ error: `${label} ${label.endsWith('s') ? 'are' : 'is'} on the ${plan} plan. Upgrade under Plan & billing.`, code: 'plan_feature', feature });
          return;
        }
      }
      next();
    })().catch(next);
  };
}

function toDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000) : null;
}

function addCycle(from: Date, cycle: BillingCycle): Date {
  const date = new Date(from);
  if (cycle === 'monthly') date.setMonth(date.getMonth() + 1);
  else date.setFullYear(date.getFullYear() + 1);
  return date;
}

/** Makes a paid subscription the company's plan, and cancels the one it replaces. */
async function activate(
  pool: DbPool,
  razorpay: RazorpayClient,
  organizationId: string,
  subscription: RazorpaySubscription,
  planKey: PlanKey,
  cycle: BillingCycle,
): Promise<void> {
  const start = toDate(subscription.current_start) ?? new Date();
  const end = toDate(subscription.current_end) ?? addCycle(start, cycle);
  const previous = await pool.query<{ razorpay_subscription_id: string | null }>(
    'SELECT razorpay_subscription_id FROM organization_subscriptions WHERE organization_id = $1',
    [organizationId],
  );
  await pool.query(
    `UPDATE organization_subscriptions
     SET plan_key = $2, billing_cycle = $3, status = $4, current_period_start = $5, current_period_end = $6,
         razorpay_subscription_id = $7, cancel_at_period_end = false, payment_method = 'razorpay',
         pending_subscription_id = NULL, pending_plan_key = NULL, pending_cycle = NULL, updated_at = now()
     WHERE organization_id = $1`,
    [organizationId, planKey, cycle, subscription.status === 'authenticated' ? 'authenticated' : 'active', start, end, subscription.id],
  );
  const old = previous.rows[0]?.razorpay_subscription_id;
  if (old && old !== subscription.id) {
    await razorpay.cancelSubscription(old, false).catch((error) => console.error(`Could not cancel replaced subscription ${old}:`, (error as Error).message));
  }
}

/**
 * Makes a plan paid by bank transfer or PayPal the company's plan for one period. Paying again for the same
 * plan before it ends adds a period after the current one. Any Razorpay renewal is stopped, so the company
 * is not charged twice.
 */
export async function activateOnePeriod(
  pool: DbPool,
  razorpay: RazorpayClient,
  organizationId: string,
  planKey: PlanKey,
  cycle: BillingCycle,
  provider: Exclude<PaymentProvider, 'razorpay'>,
): Promise<{ start: Date; end: Date }> {
  const row = await loadSubscription(pool, organizationId);
  const now = new Date();
  const extends_ = row.plan_key === planKey && row.billing_cycle === cycle && row.current_period_end !== null && row.current_period_end > now;
  const start = extends_ ? row.current_period_end! : now;
  const end = addCycle(start, cycle);
  await pool.query(
    `UPDATE organization_subscriptions
     SET plan_key = $2, billing_cycle = $3, status = 'active', current_period_start = $4, current_period_end = $5,
         payment_method = $6, razorpay_subscription_id = NULL, cancel_at_period_end = false,
         pending_subscription_id = NULL, pending_plan_key = NULL, pending_cycle = NULL, updated_at = now()
     WHERE organization_id = $1`,
    [organizationId, planKey, cycle, extends_ ? row.current_period_start ?? now : now, end, provider],
  );
  if (row.razorpay_subscription_id) {
    await razorpay
      .cancelSubscription(row.razorpay_subscription_id, false)
      .catch((error) => console.error(`Could not stop Razorpay renewal ${row.razorpay_subscription_id}:`, (error as Error).message));
  }
  return { start, end };
}

export async function recordPayment(
  pool: DbPool,
  organizationId: string,
  payment: { id: string; amount: number; status: string; method?: string; invoice_id?: string | null; created_at?: number },
  subscriptionId: string,
  planKey: string,
  cycle: string | null,
  provider: PaymentProvider = 'razorpay',
  currency: 'INR' | 'USD' = 'INR',
) {
  await pool.query(
    `INSERT INTO subscription_payments (razorpay_payment_id, organization_id, razorpay_subscription_id, razorpay_invoice_id, plan_key,
       billing_cycle, amount_paise, status, method, paid_at, provider, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (razorpay_payment_id) DO UPDATE SET status = EXCLUDED.status`,
    [payment.id, organizationId, subscriptionId, payment.invoice_id ?? null, planKey, cycle, payment.amount, payment.status, payment.method ?? '',
      toDate(payment.created_at) ?? new Date(), provider, currency],
  );
}

export async function billingSummary(pool: DbPool, organizationId: string, includeHistory: boolean) {
  const row = await loadSubscription(pool, organizationId);
  const { access, plan, daysLeft } = accessOf(row);
  const [usage, history] = await Promise.all([
    usageOf(pool, organizationId),
    includeHistory
      ? pool.query<{ razorpay_payment_id: string; plan_key: string; billing_cycle: string | null; amount_paise: number; status: string; method: string; paid_at: Date; provider: PaymentProvider; currency: 'INR' | 'USD' }>(
          `SELECT razorpay_payment_id, plan_key, billing_cycle, amount_paise, status, method, paid_at, provider, currency FROM subscription_payments
           WHERE organization_id = $1 ORDER BY paid_at DESC LIMIT 50`,
          [organizationId],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  return {
    planKey: row.plan_key,
    planName: plan.name,
    cycle: row.billing_cycle,
    status: row.status,
    access,
    daysLeft,
    trialEndsAt: row.plan_key === 'trial' ? row.trial_ends_at.toISOString() : null,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    paymentMethod: row.payment_method,
    limits: plan.limits,
    features: plan.features,
    usage,
    paymentOptions: paymentOptions(),
    paymentsEnabled: Object.values(paymentOptions()).some(Boolean),
    payments: history.rows.map((payment) => ({
      id: payment.razorpay_payment_id,
      planKey: payment.plan_key,
      cycle: payment.billing_cycle,
      amount: payment.amount_paise / 100,
      currency: payment.currency,
      provider: payment.provider,
      status: payment.status,
      method: payment.method,
      paidAt: payment.paid_at.toISOString(),
    })),
  };
}

type WebhookPayload = {
  event?: string;
  payload?: {
    subscription?: { entity?: RazorpaySubscription };
    payment?: { entity?: { id: string; amount: number; status: string; method?: string; invoice_id?: string | null; created_at?: number } };
  };
};

export function registerBillingRoutes(app: Express, pool: DbPool, fetcher: typeof fetch = fetch): void {
  const razorpay = razorpayClient(fetcher);

  const sendError = (res: Response, error: unknown) => {
    if (error instanceof RazorpayError) return res.status(error.status).json({ error: error.message });
    throw error;
  };

  app.get('/api/billing/plans', (_req, res) => {
    const options = paymentOptions();
    res.json({ plans: publicPlans(), gstRate: 0.18, trialDays: TRIAL_DAYS, paymentOptions: options, paymentsEnabled: Object.values(options).some(Boolean) });
  });

  app.get('/api/billing', requireUser, asyncHandler(async (_req, res) => {
    const user = currentUser(res);
    return res.json({ ...(await billingSummary(pool, user.organizationId, user.role === 'admin')), platformAdmin: isPlatformAdmin(user.email) });
  }));

  /** Starts a Razorpay subscription for the chosen plan. The browser opens Razorpay Checkout with it. */
  app.post('/api/billing/checkout', requireAdmin, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const plan = planByKey(req.body?.plan);
    const cycle = req.body?.cycle;
    if (!plan || !isCycle(cycle)) return res.status(400).json({ error: 'Choose a plan and monthly or yearly billing.' });
    const current = await loadSubscription(pool, user.organizationId);
    const { access } = accessOf(current);
    if (
      current.payment_method === 'razorpay' && current.plan_key === plan.key && current.billing_cycle === cycle &&
      (access === 'active' || access === 'grace') && !current.cancel_at_period_end
    ) {
      return res.status(409).json({ error: `You are already on ${plan.name} (${cycle}).` });
    }
    const usage = await usageOf(pool, user.organizationId);
    if (usage.users > plan.limits.users) {
      return res.status(409).json({ error: `${plan.name} allows ${plan.limits.users} users and this company has ${usage.users}. Remove some team members first, or choose a larger plan.` });
    }
    try {
      const planId = await razorpay.planId(pool, plan, cycle);
      const subscription = await razorpay.createSubscription(planId, cycle, {
        organization_id: user.organizationId,
        plan_key: plan.key,
        billing_cycle: cycle,
      });
      await pool.query(
        `UPDATE organization_subscriptions SET pending_subscription_id = $2, pending_plan_key = $3, pending_cycle = $4, updated_at = now()
         WHERE organization_id = $1`,
        [user.organizationId, subscription.id, plan.key, cycle],
      );
      const price = priceFor(plan, cycle);
      return res.status(201).json({
        subscriptionId: subscription.id,
        keyId: razorpayKeyId(),
        name: 'DiamondX-A1005',
        description: `${plan.name} plan, billed ${cycle === 'monthly' ? 'monthly' : 'yearly'}`,
        amountInr: price.totalInr,
        prefill: { email: user.email, name: user.organizationName },
      });
    } catch (error) {
      return sendError(res, error);
    }
  }));

  /** Confirms the first payment from Checkout, so the plan starts at once instead of waiting for the webhook. */
  app.post('/api/billing/verify', requireAdmin, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const paymentId = String(req.body?.razorpay_payment_id ?? '');
    const subscriptionId = String(req.body?.razorpay_subscription_id ?? '');
    const signature = String(req.body?.razorpay_signature ?? '');
    if (!checkoutSignatureValid(paymentId, subscriptionId, signature)) {
      return res.status(400).json({ error: 'The payment could not be verified. If money was taken, it will show here within a few minutes.' });
    }
    const row = await loadSubscription(pool, user.organizationId);
    if (row.razorpay_subscription_id === subscriptionId) return res.json(await billingSummary(pool, user.organizationId, true));
    if (row.pending_subscription_id !== subscriptionId || !row.pending_plan_key || !row.pending_cycle) {
      return res.status(409).json({ error: 'That payment is not for the plan you chose last. Refresh and try again.' });
    }
    try {
      const subscription = await razorpay.fetchSubscription(subscriptionId);
      const plan = planByKey(row.pending_plan_key)!;
      await activate(pool, razorpay, user.organizationId, subscription, plan.key, row.pending_cycle);
      await recordPayment(pool, user.organizationId, { id: paymentId, amount: priceFor(plan, row.pending_cycle).totalPaise, status: 'captured' }, subscriptionId, plan.key, row.pending_cycle);
      return res.json(await billingSummary(pool, user.organizationId, true));
    } catch (error) {
      return sendError(res, error);
    }
  }));

  /** Stops renewal. The plan keeps working until the paid period ends. */
  app.post('/api/billing/cancel', requireAdmin, asyncHandler(async (_req, res) => {
    const user = currentUser(res);
    const row = await loadSubscription(pool, user.organizationId);
    if (row.payment_method === 'bank_transfer' || row.payment_method === 'paypal') {
      return res.status(409).json({ error: 'This plan was paid for one period and does not renew on its own, so there is nothing to cancel.' });
    }
    if (!row.razorpay_subscription_id || row.plan_key === 'trial') return res.status(409).json({ error: 'There is no paid plan to cancel.' });
    if (row.cancel_at_period_end) return res.json(await billingSummary(pool, user.organizationId, true));
    try {
      await razorpay.cancelSubscription(row.razorpay_subscription_id, true);
      await pool.query('UPDATE organization_subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE organization_id = $1', [user.organizationId]);
      return res.json(await billingSummary(pool, user.organizationId, true));
    } catch (error) {
      return sendError(res, error);
    }
  }));

  /**
   * Razorpay webhook. Point it at https://<your site>/api/billing/webhook with the events
   * subscription.activated, .charged, .pending, .halted, .cancelled, .completed, and .resumed.
   */
  app.post('/api/billing/webhook', asyncHandler(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    if (!webhookSignatureValid(raw, req.header('x-razorpay-signature'))) return res.status(400).json({ error: 'Bad signature.' });
    let body: WebhookPayload;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Bad body.' });
    }
    const event = body.event ?? '';
    const subscription = body.payload?.subscription?.entity;
    const eventId = req.header('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex');
    if (!subscription?.id) return res.json({ ok: true, ignored: event });

    const owner = await pool.query<SubscriptionRow>(
      `SELECT * FROM organization_subscriptions
       WHERE razorpay_subscription_id = $1 OR pending_subscription_id = $1 OR organization_id::text = $2 LIMIT 1`,
      [subscription.id, subscription.notes?.organization_id ?? ''],
    );
    const row = owner.rows[0];
    const fresh = await pool.query(
      `INSERT INTO billing_events (event_id, event, organization_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, event, row?.organization_id ?? null],
    );
    if (!fresh.rowCount) return res.json({ ok: true, duplicate: true });
    if (!row) return res.json({ ok: true, ignored: 'unknown subscription' });

    const isPending = row.pending_subscription_id === subscription.id;
    const isCurrent = row.razorpay_subscription_id === subscription.id;
    const planKey = (isPending ? row.pending_plan_key : row.plan_key) ?? (subscription.notes?.plan_key as PlanKey | undefined);
    const cycle = (isPending ? row.pending_cycle : row.billing_cycle) ?? (isCycle(subscription.notes?.billing_cycle) ? subscription.notes!.billing_cycle as BillingCycle : null);

    if (['subscription.activated', 'subscription.charged', 'subscription.resumed', 'subscription.authenticated'].includes(event)) {
      if (isPending && planKey && planKey !== 'trial' && cycle) {
        await activate(pool, razorpay, row.organization_id, subscription, planKey, cycle);
      } else if (isCurrent) {
        await pool.query(
          `UPDATE organization_subscriptions SET status = $2, current_period_start = COALESCE($3, current_period_start),
             current_period_end = COALESCE($4, current_period_end), updated_at = now() WHERE organization_id = $1`,
          [row.organization_id, subscription.status, toDate(subscription.current_start), toDate(subscription.current_end)],
        );
      }
      const payment = body.payload?.payment?.entity;
      if (event === 'subscription.charged' && payment?.id && planKey) {
        await recordPayment(pool, row.organization_id, payment, subscription.id, planKey, cycle);
      }
    } else if (['subscription.pending', 'subscription.halted'].includes(event) && isCurrent) {
      await pool.query('UPDATE organization_subscriptions SET status = $2, updated_at = now() WHERE organization_id = $1', [row.organization_id, subscription.status]);
    } else if (['subscription.cancelled', 'subscription.completed', 'subscription.expired'].includes(event)) {
      if (isCurrent) {
        await pool.query(
          `UPDATE organization_subscriptions SET status = $2, cancel_at_period_end = true, updated_at = now() WHERE organization_id = $1`,
          [row.organization_id, subscription.status],
        );
      } else if (isPending) {
        await pool.query(
          `UPDATE organization_subscriptions SET pending_subscription_id = NULL, pending_plan_key = NULL, pending_cycle = NULL, updated_at = now()
           WHERE organization_id = $1`,
          [row.organization_id],
        );
      }
    }
    return res.json({ ok: true });
  }));
}
