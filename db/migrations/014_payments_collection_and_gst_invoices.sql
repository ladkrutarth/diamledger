-- Buyers paying export invoices online, and GST tax invoices for subscription payments.

-- A company's own Razorpay account. Buyers' money goes straight to it; this site never holds it.
-- Secrets are encrypted by the API (ENCRYPTION_KEY) before they are stored.
CREATE TABLE IF NOT EXISTS payment_gateways (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'razorpay' CHECK (provider = 'razorpay'),
  key_id TEXT NOT NULL,
  key_secret_encrypted TEXT NOT NULL,
  webhook_secret_encrypted TEXT,
  -- Random part of this company's webhook URL; tells the webhook whose secret to check.
  webhook_token TEXT NOT NULL UNIQUE,
  -- Rupees per US dollar used to turn a USD balance into the INR amount the buyer pays.
  -- NULL means the company's own rate, else the reference rate, on the day of payment.
  inr_rate NUMERIC(12, 4) CHECK (inr_rate IS NULL OR (inr_rate > 0 AND inr_rate < 1000)),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One Razorpay order per attempt to pay an invoice from the buyer portal.
CREATE TABLE IF NOT EXISTS collection_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  portal_link_id UUID REFERENCES buyer_portal_links(id) ON DELETE SET NULL,
  razorpay_order_id TEXT NOT NULL UNIQUE,
  amount_usd NUMERIC(14, 2) NOT NULL CHECK (amount_usd > 0),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  rate_inr NUMERIC(12, 4) NOT NULL CHECK (rate_inr > 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid')),
  razorpay_payment_id TEXT UNIQUE,
  method TEXT NOT NULL DEFAULT '',
  -- The payment recorded on the invoice. NULL on a paid order means the money arrived but could not be
  -- recorded (for example the invoice's month is closed); record_error says why.
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  record_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS collection_orders_organization_idx ON collection_orders (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collection_orders_invoice_idx ON collection_orders (invoice_id);

-- A buyer saying "I have sent a bank transfer". Nothing is recorded until the exporter confirms it.
CREATE TABLE IF NOT EXISTS payment_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  portal_link_id UUID REFERENCES buyer_portal_links(id) ON DELETE SET NULL,
  amount_usd NUMERIC(14, 2) NOT NULL CHECK (amount_usd > 0),
  paid_on DATE NOT NULL,
  reference TEXT NOT NULL,
  payer_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'confirmed', 'rejected')),
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_claims_organization_idx ON payment_claims (organization_id, status, created_at DESC);
-- The same bank reference can only be claimed once per company while it is open or confirmed.
CREATE UNIQUE INDEX IF NOT EXISTS payment_claims_reference_idx
  ON payment_claims (organization_id, UPPER(reference)) WHERE status <> 'rejected';

-- GST tax invoices for subscription payments, numbered per Indian financial year without gaps.
CREATE TABLE IF NOT EXISTS subscription_invoice_counters (
  financial_year TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL CHECK (last_number >= 0)
);

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_payment_id TEXT NOT NULL UNIQUE REFERENCES subscription_payments(razorpay_payment_id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL UNIQUE,
  financial_year TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Everything printed on the invoice, frozen when it is issued: later profile or price changes do not alter it.
  data JSONB NOT NULL,
  UNIQUE (financial_year, sequence)
);

CREATE INDEX IF NOT EXISTS subscription_invoices_organization_idx ON subscription_invoices (organization_id, issued_at DESC);
