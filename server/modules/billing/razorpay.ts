import crypto from 'node:crypto';
import type { DbPool } from '../../core/db.js';
import { priceFor, type BillingCycle, type Plan } from './plans.js';

/**
 * Razorpay Subscriptions over its REST API (https://razorpay.com/docs/api/payments/subscriptions/).
 * Needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET; webhooks also need RAZORPAY_WEBHOOK_SECRET.
 * Use test-mode keys (rzp_test_...) until you are ready to take real payments.
 */

const API = 'https://api.razorpay.com/v1';

/** Monthly subscriptions renew for up to 10 years, yearly ones for 10 years. Either can be cancelled any time. */
const TOTAL_COUNT: Record<BillingCycle, number> = { monthly: 120, yearly: 10 };

export class RazorpayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function razorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function razorpayKeyId(): string {
  return process.env.RAZORPAY_KEY_ID ?? '';
}

export type RazorpaySubscription = {
  id: string;
  plan_id: string;
  status: string;
  current_start: number | null;
  current_end: number | null;
  short_url?: string;
  notes?: Record<string, string>;
};

export type RazorpayClient = ReturnType<typeof razorpayClient>;

export function razorpayClient(fetcher: typeof fetch) {
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    if (!razorpayConfigured()) throw new RazorpayError('Online payments are not set up on this server yet.', 503);
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const response = await fetcher(`${API}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const description = (parsed as { error?: { description?: string } } | null)?.error?.description;
      console.error(`Razorpay ${method} ${path} failed (${response.status}): ${description ?? text.slice(0, 200)}`);
      throw new RazorpayError(description ? `Razorpay: ${description}` : 'The payment service did not answer. Try again in a minute.', 502);
    }
    return parsed as T;
  };

  /** The Razorpay plan for this plan, cycle, and price, created the first time it is needed. */
  const planId = async (pool: DbPool, plan: Plan, cycle: BillingCycle): Promise<string> => {
    const price = priceFor(plan, cycle);
    const found = await pool.query<{ razorpay_plan_id: string }>(
      'SELECT razorpay_plan_id FROM razorpay_plans WHERE plan_key = $1 AND billing_cycle = $2 AND amount_paise = $3',
      [plan.key, cycle, price.totalPaise],
    );
    if (found.rows[0]) return found.rows[0].razorpay_plan_id;
    const created = await call<{ id: string }>('POST', '/plans', {
      period: cycle,
      interval: 1,
      item: {
        name: `DiamondX ${plan.name} (${cycle})`,
        amount: price.totalPaise,
        currency: 'INR',
        description: `₹${price.baseInr} + 18% GST ₹${price.gstInr}`,
      },
      notes: { plan_key: plan.key, billing_cycle: cycle },
    });
    await pool.query(
      `INSERT INTO razorpay_plans (plan_key, billing_cycle, amount_paise, razorpay_plan_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (plan_key, billing_cycle, amount_paise) DO NOTHING`,
      [plan.key, cycle, price.totalPaise, created.id],
    );
    // Another server may have created one at the same moment; use whichever was stored first.
    const stored = await pool.query<{ razorpay_plan_id: string }>(
      'SELECT razorpay_plan_id FROM razorpay_plans WHERE plan_key = $1 AND billing_cycle = $2 AND amount_paise = $3',
      [plan.key, cycle, price.totalPaise],
    );
    return stored.rows[0].razorpay_plan_id;
  };

  return {
    planId,
    createSubscription: (razorpayPlanId: string, cycle: BillingCycle, notes: Record<string, string>) =>
      call<RazorpaySubscription>('POST', '/subscriptions', {
        plan_id: razorpayPlanId,
        total_count: TOTAL_COUNT[cycle],
        quantity: 1,
        customer_notify: 1,
        notes,
      }),
    fetchSubscription: (id: string) => call<RazorpaySubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`),
    cancelSubscription: (id: string, atCycleEnd: boolean) =>
      call<RazorpaySubscription>('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 }),
  };
}

function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The signature Checkout returns after the first payment: HMAC-SHA256 of "payment_id|subscription_id". */
export function checkoutSignatureValid(paymentId: string, subscriptionId: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !paymentId || !subscriptionId || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${paymentId}|${subscriptionId}`).digest('hex');
  return safeEqual(expected, signature);
}

/** The X-Razorpay-Signature header on a webhook: HMAC-SHA256 of the exact request body. */
export function webhookSignatureValid(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}
