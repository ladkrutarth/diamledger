import crypto from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { runMigrations, type DbPool } from '../core/db.js';
import { accessOf } from '../modules/billing/billing.js';
import { featureForPath, priceFor, PLANS, planByKey } from '../modules/billing/plans.js';
import { SURAT_TO_ANTWERP_PRESET } from '../../src/data/sampleInvoices.js';
import type { InvoiceState } from '../../src/types/invoice.js';

const port = 54337;
const databaseDir = path.join(os.tmpdir(), `diamondx-billing-${process.pid}`);
const testUrl = `postgresql://diamondx:diamondx@127.0.0.1:${port}/diamondx_test`;

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';

function invoice(): InvoiceState {
  const item = { ...SURAT_TO_ANTWERP_PRESET.items[0], carats: 1, ratePerCarat: 1000, totalAmount: 1000 };
  return {
    ...SURAT_TO_ANTWERP_PRESET,
    items: [item],
    freightUsd: 0,
    insuranceUsd: 0,
    otherChargesUsd: 0,
    shipment: { ...SURAT_TO_ANTWERP_PRESET.shipment, invoiceNumber: '', invoiceDate: new Date().toISOString().slice(0, 10) },
  };
}

/** A stand-in for the Razorpay API that records what was asked of it. */
function fakeRazorpay() {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  let plans = 0;
  let subscriptions = 0;
  const now = Math.floor(Date.now() / 1000);
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname.replace('/v1', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: pathname, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (method === 'POST' && pathname === '/plans') return json({ id: `plan_${++plans}` });
    if (method === 'POST' && pathname === '/subscriptions') return json({ id: `sub_${++subscriptions}`, plan_id: body.plan_id, status: 'created', current_start: null, current_end: null, notes: body.notes });
    const fetched = /^\/subscriptions\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && fetched) return json({ id: fetched[1], status: 'active', current_start: now, current_end: now + 30 * 86400 });
    const cancelled = /^\/subscriptions\/([^/]+)\/cancel$/.exec(pathname);
    if (method === 'POST' && cancelled) return json({ id: cancelled[1], status: 'cancelled' });
    return json({ error: { description: 'not found' } }, 404);
  }) as typeof fetch;
  return { fetcher, calls };
}

/** A stand-in for PayPal: hands out a token, creates orders, and captures them for the stored amount. */
function fakePaypal(options: { captureAmount?: string; prefix?: string } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const orders = new Map<string, string>();
  let next = 0;
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init?.body ?? null;
    calls.push({ method, path: pathname, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (pathname === '/v1/oauth2/token') return json({ access_token: 'paypal-token' });
    if (method === 'POST' && pathname === '/v2/checkout/orders') {
      const id = `${options.prefix ?? 'ORDER'}${++next}`;
      orders.set(id, body.purchase_units[0].amount.value);
      return json({ id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] }, 201);
    }
    const capture = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(pathname);
    if (method === 'POST' && capture) {
      const value = options.captureAmount ?? orders.get(capture[1]) ?? '0.00';
      return json({ id: capture[1], status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAP-${capture[1]}`, status: 'COMPLETED', amount: { value, currency_code: 'USD' } }] } }] }, 201);
    }
    return json({ message: 'not found' }, 404);
  }) as typeof fetch;
  return { fetcher, calls };
}

const checkoutSignature = (paymentId: string, subscriptionId: string) =>
  crypto.createHmac('sha256', KEY_SECRET).update(`${paymentId}|${subscriptionId}`).digest('hex');

describe('plans and access rules', () => {
  it('prices plans in rupees with 18% GST and two months free on yearly', () => {
    expect(priceFor(planByKey('growth')!, 'monthly')).toEqual({ baseInr: 3999, gstInr: 720, totalInr: 4719, totalPaise: 471900 });
    for (const plan of PLANS) expect(plan.yearlyInr).toBe(plan.monthlyInr * 10);
  });

  it('maps paths to the features that unlock them', () => {
    expect(featureForPath('/api/purchases/itc-match')).toBe('advanced_tax');
    expect(featureForPath('/api/tax/audit-pack/zip')).toBe('audit');
    expect(featureForPath('/api/practice/clients')).toBe('practice');
    expect(featureForPath('/api/reminders/draft')).toBeNull();
    expect(featureForPath('/api/invoices')).toBeNull();
  });

  it('keeps a lapsed payment working for the grace days, then goes read-only', () => {
    const base = {
      organization_id: 'x', plan_key: 'growth' as const, billing_cycle: 'monthly' as const, status: 'halted', trial_ends_at: new Date(0),
      current_period_start: null, cancel_at_period_end: false, razorpay_subscription_id: 'sub', pending_subscription_id: null,
      pending_plan_key: null, pending_cycle: null, payment_method: 'razorpay' as const,
    };
    const day = 86_400_000;
    expect(accessOf({ ...base, current_period_end: new Date(Date.now() + day) }).access).toBe('active');
    expect(accessOf({ ...base, current_period_end: new Date(Date.now() - day) }).access).toBe('grace');
    expect(accessOf({ ...base, current_period_end: new Date(Date.now() - 5 * day) }).access).toBe('lapsed');
    expect(accessOf({ ...base, status: 'cancelled', current_period_end: new Date(Date.now() - day) }).access).toBe('lapsed');
    expect(accessOf({ ...base, plan_key: 'trial', trial_ends_at: new Date(Date.now() + 3 * day), current_period_end: null }).access).toBe('trial');
  });
});

describe('subscriptions with Razorpay', () => {
  let pool: DbPool;
  let app: ReturnType<typeof createApp>;
  let postgres: EmbeddedPostgres | undefined;
  const razorpay = fakeRazorpay();
  const paypal = fakePaypal();
  let owner: ReturnType<typeof request.agent>;
  let organizationId: string;

  const webhook = (event: string, payload: unknown, eventId: string, secret = WEBHOOK_SECRET) => {
    const raw = JSON.stringify({ event, payload });
    const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .set('X-Razorpay-Event-Id', eventId)
      .send(raw);
  };

  // Sign-up is limited to 5 an hour per IP; these tests create more companies than that.
  const register = async (agent: ReturnType<typeof request.agent>, email: string, companyName: string) => {
    await pool.query('DELETE FROM rate_limits');
    return agent.post('/api/auth/register').send({ email, password: 'password123', companyName });
  };

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-session-secret';
    fs.mkdirSync(databaseDir, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir, user: 'diamondx', password: 'diamondx', port, persistent: false, autoRehydrateSymlinks: true,
      onLog: () => undefined, onError: (message) => console.error(message),
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase('diamondx_test');
    pool = new pg.Pool({ connectionString: testUrl });
    await runMigrations(pool);
    app = createApp(pool, { razorpayFetch: razorpay.fetcher, paypalFetch: paypal.fetcher });
    owner = request.agent(app);
    const registered = await register(owner, 'owner@example.com', 'Meridian Diamond Exports');
    expect(registered.status).toBe(201);
    organizationId = registered.body.user.organizationId;
  }, 60000);

  afterAll(async () => {
    for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'BILLING_BANK_ACCOUNT_NUMBER', 'BILLING_BANK_IFSC',
      'BILLING_BANK_ACCOUNT_NAME', 'PLATFORM_ADMIN_EMAILS', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']) delete process.env[key];
    (app?.get('sessionStore') as { close?: () => void } | undefined)?.close?.();
    if (pool) await pool.end();
    if (postgres) await postgres.stop();
  });

  it('shows public plans and starts every new company on a 14-day trial', async () => {
    const plans = await request(app).get('/api/billing/plans');
    expect(plans.status).toBe(200);
    expect(plans.body.plans.map((plan: { key: string }) => plan.key)).toEqual(['starter', 'growth', 'business', 'ca_firm']);
    expect(plans.body.plans[1].prices.yearly).toEqual(expect.objectContaining({ baseInr: 39990, totalInr: 47188 }));
    expect(plans.body.paymentsEnabled).toBe(false);

    const billing = await owner.get('/api/billing');
    expect(billing.body).toEqual(expect.objectContaining({ planKey: 'trial', access: 'trial', daysLeft: 14, paymentsEnabled: false }));
    expect(billing.body.features).toContain('audit');
  });

  it('refuses checkout until Razorpay keys are set', async () => {
    const checkout = await owner.post('/api/billing/checkout').send({ plan: 'growth', cycle: 'monthly' });
    expect(checkout.status).toBe(503);
    expect(checkout.body.error).toContain('not set up');
  });

  it('subscribes through Checkout, verifies the signature, and switches the plan', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

    expect((await owner.post('/api/billing/checkout').send({ plan: 'gold', cycle: 'monthly' })).status).toBe(400);
    const checkout = await owner.post('/api/billing/checkout').send({ plan: 'growth', cycle: 'monthly' });
    expect(checkout.status).toBe(201);
    expect(checkout.body).toEqual(expect.objectContaining({ subscriptionId: 'sub_1', keyId: 'rzp_test_key', amountInr: 4719 }));
    const planCall = razorpay.calls.find((call) => call.path === '/plans');
    expect(planCall?.body).toEqual(expect.objectContaining({ period: 'monthly', interval: 1, item: expect.objectContaining({ amount: 471900, currency: 'INR' }) }));
    expect(razorpay.calls.find((call) => call.path === '/subscriptions')?.body).toEqual(
      expect.objectContaining({ plan_id: 'plan_1', total_count: 120, notes: expect.objectContaining({ organization_id: organizationId, plan_key: 'growth' }) }),
    );

    // Still on the trial until the payment is confirmed.
    expect((await owner.get('/api/billing')).body.planKey).toBe('trial');

    const bad = await owner.post('/api/billing/verify').send({ razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_1', razorpay_signature: 'forged' });
    expect(bad.status).toBe(400);
    const verified = await owner.post('/api/billing/verify').send({
      razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_1', razorpay_signature: checkoutSignature('pay_1', 'sub_1'),
    });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual(expect.objectContaining({ planKey: 'growth', cycle: 'monthly', access: 'active' }));
    expect(verified.body.payments).toEqual([expect.objectContaining({ id: 'pay_1', amount: 4719, currency: 'INR', provider: 'razorpay' })]);

    // Checking out the plan you are already on is refused.
    const again = await owner.post('/api/billing/checkout').send({ plan: 'growth', cycle: 'monthly' });
    expect(again.status).toBe(409);
  });

  it('locks features the plan does not include', async () => {
    expect((await owner.get('/api/purchases')).status).toBe(200);
    const audit = await owner.get('/api/tax/audit-checks');
    expect(audit.status).toBe(402);
    expect(audit.body).toEqual(expect.objectContaining({ code: 'plan_feature', feature: 'audit' }));
    expect(audit.body.error).toContain('Business');
    expect((await owner.get('/api/practice/clients')).status).toBe(402);
  });

  it('handles webhooks: checks the signature, records charges once, and upgrades on activation', async () => {
    expect((await webhook('subscription.charged', {}, 'evt_bad', 'wrong-secret')).status).toBe(400);

    const charged = {
      subscription: { entity: { id: 'sub_1', status: 'active', current_start: 1, current_end: Math.floor(Date.now() / 1000) + 60 * 86400 } },
      payment: { entity: { id: 'pay_2', amount: 471900, status: 'captured', method: 'upi', created_at: Math.floor(Date.now() / 1000) + 60 } },
    };
    expect((await webhook('subscription.charged', charged, 'evt_1')).body).toEqual({ ok: true });
    expect((await webhook('subscription.charged', charged, 'evt_1')).body).toEqual({ ok: true, duplicate: true });
    let billing = (await owner.get('/api/billing')).body;
    expect(billing.payments.map((payment: { id: string }) => payment.id)).toEqual(['pay_2', 'pay_1']);
    expect(billing.payments[0].method).toBe('upi');

    const upgrade = await owner.post('/api/billing/checkout').send({ plan: 'business', cycle: 'yearly' });
    expect(upgrade.body.subscriptionId).toBe('sub_2');
    expect(razorpay.calls.filter((call) => call.path === '/subscriptions').at(-1)?.body).toEqual(expect.objectContaining({ total_count: 10 }));
    const activated = { subscription: { entity: { id: 'sub_2', status: 'active', current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 365 * 86400, notes: { organization_id: organizationId } } } };
    expect((await webhook('subscription.activated', activated, 'evt_2')).status).toBe(200);
    billing = (await owner.get('/api/billing')).body;
    expect(billing).toEqual(expect.objectContaining({ planKey: 'business', cycle: 'yearly', access: 'active' }));
    // The replaced monthly subscription is cancelled at Razorpay straight away.
    expect(razorpay.calls).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/subscriptions/sub_1/cancel', body: { cancel_at_cycle_end: 0 } })]));
    expect((await owner.get('/api/tax/audit-checks')).status).toBe(200);
  });

  it('turns off renewal but keeps the plan until the period ends', async () => {
    const cancelled = await owner.post('/api/billing/cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual(expect.objectContaining({ cancelAtPeriodEnd: true, access: 'active' }));
    expect(razorpay.calls.at(-1)).toEqual(expect.objectContaining({ path: '/subscriptions/sub_2/cancel', body: { cancel_at_cycle_end: 1 } }));
  });

  it('enforces user and monthly invoice limits on Starter', async () => {
    await pool.query(
      `UPDATE organization_subscriptions SET plan_key = 'starter', billing_cycle = 'monthly', status = 'active',
         current_period_end = now() + interval '20 days', cancel_at_period_end = false WHERE organization_id = $1`,
      [organizationId],
    );
    expect((await owner.post('/api/team/members').send({ email: 'one@example.com', password: 'password123', role: 'member' })).status).toBe(201);
    const third = await owner.post('/api/team/members').send({ email: 'two@example.com', password: 'password123', role: 'member' });
    expect(third.status).toBe(402);
    expect(third.body.error).toContain('2 users');

    const created = await owner.post('/api/invoices').send({ invoice: invoice() });
    expect(created.status).toBe(201);
    await pool.query(
      `INSERT INTO invoices (user_id, organization_id, invoice_number, data, status, issued_at)
       SELECT user_id, organization_id, invoice_number || '-' || n, data, 'issued', now()
       FROM invoices, generate_series(1, 30) AS n WHERE id = $1`,
      [created.body.id],
    );
    const issued = await owner.patch(`/api/invoices/${created.body.id}/status`).send({ status: 'issued' });
    expect(issued.status).toBe(402);
    expect(issued.body.error).toContain('30 issued invoices');
  });

  it('makes a company read-only after the trial or the paid period ends, and still lets it pay', async () => {
    const other = request.agent(app);
    const registered = await register(other, 'late@example.com', 'Late Gems');
    await pool.query(`UPDATE organization_subscriptions SET trial_ends_at = now() - interval '1 day' WHERE organization_id = $1`, [registered.body.user.organizationId]);
    // The row is created on first use; make sure it exists, then expire it.
    await other.get('/api/billing');
    await pool.query(`UPDATE organization_subscriptions SET trial_ends_at = now() - interval '1 day' WHERE organization_id = $1`, [registered.body.user.organizationId]);

    expect((await other.get('/api/billing')).body.access).toBe('lapsed');
    const write = await other.post('/api/buyers').send({ consignee: { companyName: 'Blocked BVBA' } });
    expect(write.status).toBe(402);
    expect(write.body).toEqual(expect.objectContaining({ code: 'subscription_lapsed' }));
    expect(write.body.error).toContain('free trial has ended');
    expect((await other.get('/api/invoices')).status).toBe(200);
    expect((await other.post('/api/billing/checkout').send({ plan: 'starter', cycle: 'monthly' })).status).toBe(201);
    expect((await other.post('/api/auth/logout')).status).toBeLessThan(400);
  });

  it('counts client companies against the accountant firm plan', async () => {
    const firm = request.agent(app);
    const registered = await register(firm, 'partner@firm.example', 'Shah & Co');
    await firm.get('/api/billing');
    await pool.query(
      `UPDATE organization_subscriptions SET plan_key = 'growth', status = 'active', current_period_end = now() + interval '20 days' WHERE organization_id = $1`,
      [registered.body.user.organizationId],
    );
    const invite = await owner.post('/api/team/accountants').send({ email: 'partner@firm.example', role: 'ca' });
    // The owner is on Starter now, which does not include outside accountants.
    expect(invite.status).toBe(402);
    await pool.query(`UPDATE organization_subscriptions SET plan_key = 'business' WHERE organization_id = $1`, [organizationId]);
    const blocked = await owner.post('/api/team/accountants').send({ email: 'partner@firm.example', role: 'ca' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toContain('not on the CA Firm plan');
    await pool.query(`UPDATE organization_subscriptions SET plan_key = 'ca_firm' WHERE organization_id = $1`, [registered.body.user.organizationId]);
    expect((await owner.post('/api/team/accountants').send({ email: 'partner@firm.example', role: 'ca' })).status).toBe(201);
  });
  it('pays by bank transfer: shows the account, takes the UTR, and the operator approves it', async () => {
    const company = request.agent(app);
    const registered = await register(company, 'neft@example.com', 'Neft Gems');
    const orgId = registered.body.user.organizationId;
    expect((await company.post('/api/billing/bank-transfer').send({ plan: 'growth', cycle: 'yearly' })).status).toBe(503);

    process.env.BILLING_BANK_ACCOUNT_NAME = 'DiamondX Software Pvt Ltd';
    process.env.BILLING_BANK_ACCOUNT_NUMBER = '50200012345678';
    process.env.BILLING_BANK_IFSC = 'hdfc0000123';
    process.env.PLATFORM_ADMIN_EMAILS = 'ops@example.com';
    expect((await company.get('/api/billing/plans')).body.paymentOptions).toEqual(expect.objectContaining({ bankTransfer: true, upi: true }));

    const started = await company.post('/api/billing/bank-transfer').send({ plan: 'growth', cycle: 'yearly' });
    expect(started.status).toBe(201);
    expect(started.body.account).toEqual(expect.objectContaining({ accountNumber: '50200012345678', ifsc: 'HDFC0000123' }));
    expect(started.body.transfer).toEqual(expect.objectContaining({ amountInr: 47188, status: 'awaiting', referenceCode: expect.stringMatching(/^DX-[A-Z2-9]{6}$/) }));
    const id = started.body.transfer.id;

    expect((await company.post(`/api/billing/bank-transfer/${id}/submit`).send({ utr: 'abc', paidOn: '2026-11-01' })).status).toBe(400);
    const sent = await company.post(`/api/billing/bank-transfer/${id}/submit`).send({ utr: 'hdfcr 5202611011234', paidOn: '2026-11-01', payerBank: 'HDFC' });
    expect(sent.status).toBe(200);
    expect(sent.body.transfer).toEqual(expect.objectContaining({ status: 'submitted', utr: 'HDFCR5202611011234' }));
    expect((await company.get('/api/billing')).body.planKey).toBe('trial');

    // Only the site operator can approve.
    expect((await company.get('/api/platform/bank-transfers')).status).toBe(403);
    const ops = request.agent(app);
    await register(ops, 'ops@example.com', 'DiamondX Ops');
    expect((await ops.get('/api/billing')).body.platformAdmin).toBe(true);
    const queue = await ops.get('/api/platform/bank-transfers');
    expect(queue.body.transfers).toEqual([expect.objectContaining({ id, organizationName: 'Neft Gems', utr: 'HDFCR5202611011234' })]);
    expect((await ops.post(`/api/platform/bank-transfers/${id}/reject`).send({})).status).toBe(400);
    const approved = await ops.post(`/api/platform/bank-transfers/${id}/approve`).send({ note: 'Credit seen' });
    expect(approved.status).toBe(200);
    expect((await ops.post(`/api/platform/bank-transfers/${id}/approve`).send({})).status).toBe(409);

    const billing = (await company.get('/api/billing')).body;
    expect(billing).toEqual(expect.objectContaining({ planKey: 'growth', cycle: 'yearly', access: 'active', paymentMethod: 'bank_transfer' }));
    expect(billing.payments[0]).toEqual(expect.objectContaining({ provider: 'bank_transfer', amount: 47188, currency: 'INR' }));
    const end = new Date(billing.currentPeriodEnd);
    expect(end.getTime() - Date.now()).toBeGreaterThan(360 * 86_400_000);
    expect((await company.post('/api/billing/cancel')).status).toBe(409);

    // The same UTR cannot pay twice.
    const again = await company.post('/api/billing/bank-transfer').send({ plan: 'growth', cycle: 'yearly' });
    expect((await company.post(`/api/billing/bank-transfer/${again.body.transfer.id}/submit`).send({ utr: 'HDFCR5202611011234', paidOn: '2026-11-02' })).status).toBe(409);

    // Paying for the same plan again before it ends adds a year after the current one.
    await company.post(`/api/billing/bank-transfer/${again.body.transfer.id}/submit`).send({ utr: 'HDFCR5202611029999', paidOn: '2026-11-02' });
    await ops.post(`/api/platform/bank-transfers/${again.body.transfer.id}/approve`).send({});
    const renewed = new Date((await company.get('/api/billing')).body.currentPeriodEnd);
    expect(renewed.getTime() - end.getTime()).toBeGreaterThan(360 * 86_400_000);
    expect(orgId).toBeTruthy();
  });

  it('pays by PayPal in US dollars for customers outside India', async () => {
    const company = request.agent(app);
    await register(company, 'dubai@example.com', 'Dubai Diamonds FZE');
    expect((await company.post('/api/billing/paypal/order').send({ plan: 'business', cycle: 'monthly' })).status).toBe(503);
    process.env.PAYPAL_CLIENT_ID = 'client';
    process.env.PAYPAL_CLIENT_SECRET = 'secret';

    const order = await company.post('/api/billing/paypal/order').send({ plan: 'business', cycle: 'monthly' });
    expect(order.status).toBe(201);
    expect(order.body).toEqual({ orderId: 'ORDER1', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1', amountUsd: 99 });
    const created = paypal.calls.find((call) => call.path === '/v2/checkout/orders')?.body as { purchase_units: Array<{ amount: unknown }>; payment_source: { paypal: { experience_context: { return_url: string } } } };
    expect(created.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '99.00' });
    expect(created.payment_source.paypal.experience_context.return_url).toMatch(/\/\?billing=paypal$/);

    // Another company cannot capture this order.
    expect((await owner.post('/api/billing/paypal/capture').send({ orderId: 'ORDER1' })).status).toBe(404);
    const captured = await company.post('/api/billing/paypal/capture').send({ orderId: 'ORDER1' });
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual(expect.objectContaining({ planKey: 'business', cycle: 'monthly', paymentMethod: 'paypal', access: 'active' }));
    expect(captured.body.payments[0]).toEqual(expect.objectContaining({ provider: 'paypal', amount: 99, currency: 'USD' }));
    // A repeated capture is harmless.
    expect((await company.post('/api/billing/paypal/capture').send({ orderId: 'ORDER1' })).body.payments).toHaveLength(1);
  });

  it('refuses a PayPal capture for less than the plan price', async () => {
    const short = fakePaypal({ captureAmount: '1.00', prefix: 'SHORT' });
    const shortApp = createApp(pool, { razorpayFetch: razorpay.fetcher, paypalFetch: short.fetcher });
    const company = request.agent(shortApp);
    await register(company, 'short@example.com', 'Short Pay LLC');
    const order = await company.post('/api/billing/paypal/order').send({ plan: 'starter', cycle: 'monthly' });
    const captured = await company.post('/api/billing/paypal/capture').send({ orderId: order.body.orderId });
    expect(captured.status).toBe(402);
    expect((await company.get('/api/billing')).body.planKey).toBe('trial');
    (shortApp.get('sessionStore') as { close?: () => void } | undefined)?.close?.();
  });
});
