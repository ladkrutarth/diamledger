-- One subscription per company. A company without a row starts a free trial the first time it is used.
CREATE TABLE IF NOT EXISTS organization_subscriptions (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL DEFAULT 'trial' CHECK (plan_key IN ('trial', 'starter', 'growth', 'business', 'ca_firm')),
  billing_cycle TEXT CHECK (billing_cycle IS NULL OR billing_cycle IN ('monthly', 'yearly')),
  -- Razorpay subscription states, plus 'trialing' before any payment.
  status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired')),
  trial_ends_at TIMESTAMPTZ NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  razorpay_subscription_id TEXT UNIQUE,
  -- A checkout that has been started but not yet paid. It replaces the current plan once paid.
  pending_subscription_id TEXT UNIQUE,
  pending_plan_key TEXT CHECK (pending_plan_key IS NULL OR pending_plan_key IN ('starter', 'growth', 'business', 'ca_firm')),
  pending_cycle TEXT CHECK (pending_cycle IS NULL OR pending_cycle IN ('monthly', 'yearly')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Razorpay plan IDs, created on first use for each plan, cycle, and amount. A price change creates a new one.
CREATE TABLE IF NOT EXISTS razorpay_plans (
  plan_key TEXT NOT NULL,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  razorpay_plan_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_key, billing_cycle, amount_paise)
);

-- Charges received, for the billing history.
CREATE TABLE IF NOT EXISTS subscription_payments (
  razorpay_payment_id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  razorpay_subscription_id TEXT NOT NULL,
  razorpay_invoice_id TEXT,
  plan_key TEXT NOT NULL,
  billing_cycle TEXT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  status TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_payments_organization_idx ON subscription_payments (organization_id, paid_at DESC);

-- Webhook events already handled, so a retried delivery is not applied twice.
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- When an invoice was issued, for the monthly invoice allowance.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ;
UPDATE invoices SET issued_at = updated_at WHERE issued_at IS NULL AND status IN ('issued', 'paid');
CREATE INDEX IF NOT EXISTS invoices_organization_issued_idx ON invoices (organization_id, issued_at);
