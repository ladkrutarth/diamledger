-- How the current plan was paid: Razorpay renews itself; bank transfer and PayPal pay one period at a time.
ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS payment_method TEXT
  CHECK (payment_method IS NULL OR payment_method IN ('razorpay', 'bank_transfer', 'paypal'));

-- Payments can now be in rupees (Razorpay, bank transfer) or US dollars (PayPal). amount_paise holds the
-- amount in the smallest unit of that currency: paise or cents.
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'razorpay'
  CHECK (provider IN ('razorpay', 'bank_transfer', 'paypal'));

-- A plan paid by NEFT, RTGS, or IMPS. The company quotes the reference code, then enters the bank's UTR;
-- the site operator checks the money arrived and approves it.
CREATE TABLE IF NOT EXISTS bank_transfer_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL CHECK (plan_key IN ('starter', 'growth', 'business', 'ca_firm')),
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  amount_inr INTEGER NOT NULL CHECK (amount_inr > 0),
  reference_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'submitted', 'approved', 'rejected', 'cancelled')),
  utr TEXT NOT NULL DEFAULT '',
  paid_on DATE,
  payer_bank TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_email TEXT NOT NULL DEFAULT '',
  reviewed_by_email TEXT NOT NULL DEFAULT '',
  reviewed_at TIMESTAMPTZ,
  review_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_transfer_requests_organization_idx ON bank_transfer_requests (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bank_transfer_requests_status_idx ON bank_transfer_requests (status);
-- A UTR can only pay for one plan.
CREATE UNIQUE INDEX IF NOT EXISTS bank_transfer_requests_utr_idx ON bank_transfer_requests (UPPER(utr)) WHERE utr <> '';

-- PayPal orders for customers outside India, in US dollars.
CREATE TABLE IF NOT EXISTS paypal_orders (
  order_id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL CHECK (plan_key IN ('starter', 'growth', 'business', 'ca_firm')),
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  amount_usd NUMERIC(10, 2) NOT NULL CHECK (amount_usd > 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'captured', 'failed')),
  capture_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS paypal_orders_organization_idx ON paypal_orders (organization_id, created_at DESC);
