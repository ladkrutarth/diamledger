import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { DbPool } from '../../core/db.js';
import { formReader } from '../../core/formInput.js';
import { asyncHandler, currentUser, isUuid, requireAdmin } from '../../core/http.js';
import { activateOnePeriod, billingSummary, recordPayment } from './billing.js';
import { isCycle, planByKey, priceFor, usdPriceFor, type BillingCycle, type PlanKey } from './plans.js';
import { isPlatformAdmin, paypalConfigured, sellerBankAccount } from './providers.js';
import { razorpayClient } from './razorpay.js';

// ---------- PayPal (customers outside India, US dollars) ----------

class PaypalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function paypalBase(): string {
  return process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

/** PayPal Orders v2 (https://developer.paypal.com/docs/api/orders/v2/). One payment per plan period. */
export function paypalClient(fetcher: typeof fetch) {
  const token = async (): Promise<string> => {
    if (!paypalConfigured()) throw new PaypalError('PayPal is not set up on this server.', 503);
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await fetcher(`${paypalBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!response.ok) throw new PaypalError('PayPal did not accept the server credentials.', 502);
    return ((await response.json()) as { access_token: string }).access_token;
  };

  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> => {
    const response = await fetcher(`${paypalBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'PayPal-Request-Id': idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => null)) as T & { message?: string; details?: Array<{ issue?: string }> };
    if (!response.ok) {
      const issue = parsed?.details?.[0]?.issue;
      console.error(`PayPal ${method} ${path} failed (${response.status}): ${issue ?? parsed?.message ?? ''}`);
      throw new PaypalError(issue === 'INSTRUMENT_DECLINED' ? 'PayPal declined that payment method. Try another one.' : 'PayPal did not complete the payment. Try again.', 502);
    }
    return parsed;
  };

  return {
    createOrder: (body: unknown, requestId: string) =>
      call<{ id: string; status: string; links?: Array<{ rel: string; href: string }> }>('POST', '/v2/checkout/orders', body, requestId),
    captureOrder: (orderId: string) =>
      call<{
        id: string;
        status: string;
        purchase_units?: Array<{ payments?: { captures?: Array<{ id: string; status: string; amount: { value: string; currency_code: string } }> } }>;
      }>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `capture-${orderId}`),
  };
}

function siteOrigin(req: Request): string {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, '');
  if (configured && /^https?:\/\//.test(configured)) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

// ---------- Bank transfer ----------

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A short code the customer writes in the transfer remarks, so the operator can match the credit. */
function referenceCode(): string {
  const bytes = crypto.randomBytes(6);
  return `DX-${Array.from(bytes, (byte) => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]).join('')}`;
}

type TransferRow = {
  id: string; organization_id: string; organization_name?: string; plan_key: PlanKey; billing_cycle: BillingCycle; amount_inr: number;
  reference_code: string; status: string; utr: string; paid_on: string | null; payer_bank: string; note: string; created_by_email: string;
  reviewed_by_email: string; reviewed_at: Date | null; review_note: string; created_at: Date;
};

function toTransfer(row: TransferRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    planKey: row.plan_key,
    planName: planByKey(row.plan_key)?.name ?? row.plan_key,
    cycle: row.billing_cycle,
    amountInr: row.amount_inr,
    referenceCode: row.reference_code,
    status: row.status,
    utr: row.utr,
    paidOn: row.paid_on,
    payerBank: row.payer_bank,
    note: row.note,
    createdByEmail: row.created_by_email,
    reviewedByEmail: row.reviewed_by_email,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reviewNote: row.review_note,
    createdAt: row.created_at.toISOString(),
  };
}

const TRANSFER_COLUMNS = `t.id, t.organization_id, t.plan_key, t.billing_cycle, t.amount_inr, t.reference_code, t.status, t.utr,
  to_char(t.paid_on, 'YYYY-MM-DD') AS paid_on, t.payer_bank, t.note, t.created_by_email, t.reviewed_by_email, t.reviewed_at, t.review_note, t.created_at`;

/** The company's latest bank transfer that is still waiting on someone. */
export async function openBankTransfer(pool: DbPool, organizationId: string) {
  const result = await pool.query<TransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM bank_transfer_requests t
     WHERE t.organization_id = $1 AND t.status IN ('awaiting', 'submitted', 'rejected')
     ORDER BY t.created_at DESC LIMIT 1`,
    [organizationId],
  );
  return result.rows[0] ? toTransfer(result.rows[0]) : null;
}

function platformAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = res.locals.user;
  if (!user) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  if (!isPlatformAdmin(user.email)) {
    res.status(403).json({ error: 'Only the people who run this site can do this.' });
    return;
  }
  next();
}

export function registerPaymentMethodRoutes(
  app: Express,
  pool: DbPool,
  fetchers: { razorpay: typeof fetch; paypal: typeof fetch },
): void {
  const razorpay = razorpayClient(fetchers.razorpay);
  const paypal = paypalClient(fetchers.paypal);
  const fail = (res: Response, error: unknown) => {
    if (error instanceof PaypalError) return res.status(error.status).json({ error: error.message });
    throw error;
  };

  app.get('/api/billing/bank-transfer', requireAdmin, asyncHandler(async (_req, res) => {
    return res.json({ transfer: await openBankTransfer(pool, currentUser(res).organizationId), account: sellerBankAccount() });
  }));

  // Bank transfer: 1) ask for the account and a reference code, 2) enter the UTR after paying, 3) the operator approves.
  app.post('/api/billing/bank-transfer', requireAdmin, asyncHandler(async (req, res) => {
    const account = sellerBankAccount();
    if (!account) return res.status(503).json({ error: 'Payment by bank transfer is not set up on this site.' });
    const plan = planByKey(req.body?.plan);
    const cycle = req.body?.cycle;
    if (!plan || !isCycle(cycle)) return res.status(400).json({ error: 'Choose a plan and monthly or yearly billing.' });
    const user = currentUser(res);
    // One open request at a time; starting a new one replaces any that has not been paid.
    await pool.query(
      `UPDATE bank_transfer_requests SET status = 'cancelled' WHERE organization_id = $1 AND status IN ('awaiting', 'rejected')`,
      [user.organizationId],
    );
    const submitted = await pool.query(`SELECT 1 FROM bank_transfer_requests WHERE organization_id = $1 AND status = 'submitted'`, [user.organizationId]);
    if (submitted.rowCount) return res.status(409).json({ error: 'A bank transfer is already waiting to be checked. You will see the plan change once it is approved.' });
    const inserted = await pool.query<TransferRow>(
      `INSERT INTO bank_transfer_requests (organization_id, plan_key, billing_cycle, amount_inr, reference_code, created_by, created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${TRANSFER_COLUMNS.replace(/t\./g, '')}`,
      [user.organizationId, plan.key, cycle, priceFor(plan, cycle).totalInr, referenceCode(), user.id, user.email],
    );
    return res.status(201).json({ transfer: toTransfer(inserted.rows[0]), account });
  }));

  app.post('/api/billing/bank-transfer/:id/submit', requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Transfer not found.' });
    const form = formReader(req.body);
    const utr = form.required('utr', 'Enter the UTR or transaction reference from your bank.', 40).toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9]{8,30}$/.test(utr)) return res.status(400).json({ error: 'A UTR is 8 to 30 letters and digits, like HDFCR52026110112345678 or 412345678901.' });
    const paidOn = form.date('paidOn', 'Enter the date you paid as YYYY-MM-DD.') as string;
    const user = currentUser(res);
    try {
      const updated = await pool.query<TransferRow>(
        `UPDATE bank_transfer_requests SET status = 'submitted', utr = $3, paid_on = $4, payer_bank = $5, note = $6
         WHERE id = $1 AND organization_id = $2 AND status IN ('awaiting', 'rejected')
         RETURNING ${TRANSFER_COLUMNS.replace(/t\./g, '')}`,
        [req.params.id, user.organizationId, utr, paidOn, form.text('payerBank', 100), form.text('note', 500)],
      );
      if (!updated.rows[0]) return res.status(409).json({ error: 'This transfer has already been sent for checking.' });
      return res.json({ transfer: toTransfer(updated.rows[0]) });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: 'That UTR has already been used for a payment.' });
      throw error;
    }
  }));

  app.post('/api/billing/bank-transfer/:id/cancel', requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Transfer not found.' });
    const updated = await pool.query(
      `UPDATE bank_transfer_requests SET status = 'cancelled' WHERE id = $1 AND organization_id = $2 AND status IN ('awaiting', 'rejected')`,
      [req.params.id, currentUser(res).organizationId],
    );
    if (!updated.rowCount) return res.status(409).json({ error: 'Only a transfer that has not been sent for checking can be cancelled.' });
    return res.json({ cancelled: true });
  }));

  // The site operator's queue of transfers to check against the bank statement.
  app.get('/api/platform/bank-transfers', platformAdmin, asyncHandler(async (req, res) => {
    const status = req.query.status === 'all' ? null : 'submitted';
    const result = await pool.query<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS}, o.name AS organization_name FROM bank_transfer_requests t JOIN organizations o ON o.id = t.organization_id
       WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.created_at DESC LIMIT 200`,
      [status],
    );
    return res.json({ transfers: result.rows.map(toTransfer) });
  }));

  app.post('/api/platform/bank-transfers/:id/approve', platformAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Transfer not found.' });
    const reviewer = currentUser(res).email;
    const claimed = await pool.query<TransferRow>(
      `UPDATE bank_transfer_requests SET status = 'approved', reviewed_by_email = $2, reviewed_at = now(), review_note = $3
       WHERE id = $1 AND status = 'submitted' RETURNING ${TRANSFER_COLUMNS.replace(/t\./g, '')}`,
      [req.params.id, reviewer, typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : ''],
    );
    const transfer = claimed.rows[0];
    if (!transfer) return res.status(409).json({ error: 'Only a transfer waiting to be checked can be approved.' });
    const period = await activateOnePeriod(pool, razorpay, transfer.organization_id, transfer.plan_key, transfer.billing_cycle, 'bank_transfer');
    await recordPayment(
      pool,
      transfer.organization_id,
      { id: `bank_${transfer.utr}`, amount: transfer.amount_inr * 100, status: 'captured', method: 'neft/rtgs/imps' },
      transfer.reference_code,
      transfer.plan_key,
      transfer.billing_cycle,
      'bank_transfer',
      'INR',
    );
    return res.json({ transfer: toTransfer(transfer), periodEnd: period.end.toISOString() });
  }));

  app.post('/api/platform/bank-transfers/:id/reject', platformAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Transfer not found.' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    if (!note) return res.status(400).json({ error: 'Say why, for example "No credit with this UTR" or "Amount short by ₹500".' });
    const updated = await pool.query(
      `UPDATE bank_transfer_requests SET status = 'rejected', reviewed_by_email = $2, reviewed_at = now(), review_note = $3
       WHERE id = $1 AND status = 'submitted'`,
      [req.params.id, currentUser(res).email, note],
    );
    if (!updated.rowCount) return res.status(409).json({ error: 'Only a transfer waiting to be checked can be rejected.' });
    return res.json({ rejected: true });
  }));

  // PayPal: create an order, send the buyer to PayPal, then capture it when they come back.
  app.post('/api/billing/paypal/order', requireAdmin, asyncHandler(async (req, res) => {
    const plan = planByKey(req.body?.plan);
    const cycle = req.body?.cycle;
    if (!plan || !isCycle(cycle)) return res.status(400).json({ error: 'Choose a plan and monthly or yearly billing.' });
    const user = currentUser(res);
    const amount = usdPriceFor(plan, cycle);
    const origin = siteOrigin(req);
    try {
      const order = await paypal.createOrder(
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: user.organizationId,
              custom_id: `${user.organizationId}|${plan.key}|${cycle}`,
              description: `DiamondX-A1005 ${plan.name} plan, ${cycle === 'monthly' ? '1 month' : '1 year'}`,
              amount: { currency_code: 'USD', value: amount.toFixed(2) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'DiamondX-A1005',
                user_action: 'PAY_NOW',
                shipping_preference: 'NO_SHIPPING',
                return_url: `${origin}/?billing=paypal`,
                cancel_url: `${origin}/?billing=paypal-cancelled`,
              },
            },
          },
        },
        crypto.randomUUID(),
      );
      const approveUrl = order.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href;
      if (!approveUrl) return res.status(502).json({ error: 'PayPal did not return a payment page. Try again.' });
      await pool.query(
        `INSERT INTO paypal_orders (order_id, organization_id, plan_key, billing_cycle, amount_usd) VALUES ($1, $2, $3, $4, $5)`,
        [order.id, user.organizationId, plan.key, cycle, amount],
      );
      return res.status(201).json({ orderId: order.id, approveUrl, amountUsd: amount });
    } catch (error) {
      return fail(res, error);
    }
  }));

  app.post('/api/billing/paypal/capture', requireAdmin, asyncHandler(async (req, res) => {
    const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim().slice(0, 40) : '';
    const user = currentUser(res);
    const found = await pool.query<{ order_id: string; plan_key: PlanKey; billing_cycle: BillingCycle; amount_usd: string; status: string }>(
      `SELECT order_id, plan_key, billing_cycle, amount_usd, status FROM paypal_orders WHERE order_id = $1 AND organization_id = $2`,
      [orderId, user.organizationId],
    );
    const order = found.rows[0];
    if (!order) return res.status(404).json({ error: 'That PayPal payment was not started from this company.' });
    if (order.status === 'captured') return res.json(await billingSummary(pool, user.organizationId, true));
    try {
      const captured = await paypal.captureOrder(order.order_id);
      const capture = captured.purchase_units?.[0]?.payments?.captures?.[0];
      const paidUsd = Number(capture?.amount.value);
      if (captured.status !== 'COMPLETED' || capture?.status !== 'COMPLETED' || capture.amount.currency_code !== 'USD' || Math.abs(paidUsd - Number(order.amount_usd)) > 0.001) {
        await pool.query(`UPDATE paypal_orders SET status = 'failed' WHERE order_id = $1`, [order.order_id]);
        return res.status(402).json({ error: 'PayPal did not confirm the full payment, so the plan was not changed.' });
      }
      // Claim the order so a second capture request cannot apply it twice.
      const claimed = await pool.query(
        `UPDATE paypal_orders SET status = 'captured', capture_id = $2, captured_at = now() WHERE order_id = $1 AND status = 'created'`,
        [order.order_id, capture.id],
      );
      if (claimed.rowCount) {
        await activateOnePeriod(pool, razorpay, user.organizationId, order.plan_key, order.billing_cycle, 'paypal');
        await recordPayment(
          pool,
          user.organizationId,
          { id: `paypal_${capture.id}`, amount: Math.round(paidUsd * 100), status: 'captured', method: 'paypal' },
          order.order_id,
          order.plan_key,
          order.billing_cycle,
          'paypal',
          'USD',
        );
      }
      return res.json(await billingSummary(pool, user.organizationId, true));
    } catch (error) {
      return fail(res, error);
    }
  }));
}
