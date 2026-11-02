-- Purchases: imports against a Bill of Entry and local purchases, with the GST paid that can be claimed as credit.
CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'local')),
  supplier_name TEXT NOT NULL,
  supplier_gstin TEXT NOT NULL DEFAULT '',
  supplier_country TEXT NOT NULL DEFAULT '',
  document_no TEXT NOT NULL,
  document_date DATE NOT NULL,
  port_code TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  carats NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (carats >= 0),
  parcel_id TEXT NOT NULL DEFAULT '',
  taxable_inr NUMERIC(14, 2) NOT NULL CHECK (taxable_inr >= 0),
  igst_inr NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (igst_inr >= 0),
  cgst_inr NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (cgst_inr >= 0),
  sgst_inr NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (sgst_inr >= 0),
  related_party BOOLEAN NOT NULL DEFAULT false,
  notes TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS purchases_document_idx
  ON purchases (organization_id, kind, supplier_gstin, UPPER(document_no));
CREATE INDEX IF NOT EXISTS purchases_organization_date_idx ON purchases (organization_id, document_date);

-- Lines from the GSTR-2B statement, imported per return month. A new import replaces that month.
CREATE TABLE IF NOT EXISTS gstr2b_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  section TEXT NOT NULL CHECK (section IN ('b2b', 'impg')),
  supplier_gstin TEXT NOT NULL DEFAULT '',
  supplier_name TEXT NOT NULL DEFAULT '',
  document_no TEXT NOT NULL,
  document_date DATE,
  taxable_inr NUMERIC(14, 2) NOT NULL DEFAULT 0,
  igst_inr NUMERIC(14, 2) NOT NULL DEFAULT 0,
  cgst_inr NUMERIC(14, 2) NOT NULL DEFAULT 0,
  sgst_inr NUMERIC(14, 2) NOT NULL DEFAULT 0,
  itc_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gstr2b_lines_organization_month_idx ON gstr2b_lines (organization_id, month);

-- Stock: rough and polished parcels, their cost, and which rough parcel a polished one was cut from.
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS stock_kind TEXT NOT NULL DEFAULT 'polished'
  CHECK (stock_kind IN ('rough', 'polished'));
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS cost_inr NUMERIC(14, 2) CHECK (cost_inr IS NULL OR cost_inr >= 0);
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS made_from TEXT NOT NULL DEFAULT '';
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS rough_carats_used NUMERIC(12, 3)
  CHECK (rough_carats_used IS NULL OR rough_carats_used > 0);

-- Questions and document requests between the accountant and the company.
CREATE TABLE IF NOT EXISTS client_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_email TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_requests_organization_idx ON client_requests (organization_id, status);

CREATE TABLE IF NOT EXISTS client_request_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES client_requests(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  file_name TEXT,
  content_type TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
  content BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_request_messages_request_idx ON client_request_messages (request_id, created_at);

-- Notices from GST, income tax, customs, DGFT, or RBI, with their reply deadlines.
CREATE TABLE IF NOT EXISTS tax_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  authority TEXT NOT NULL CHECK (authority IN ('gst', 'income_tax', 'customs', 'dgft', 'rbi', 'other')),
  form_type TEXT NOT NULL DEFAULT '',
  reference_no TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '',
  issued_on DATE,
  reply_due DATE,
  amount_inr NUMERIC(16, 2) CHECK (amount_inr IS NULL OR amount_inr >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replied', 'closed')),
  summary TEXT NOT NULL DEFAULT '',
  reply TEXT NOT NULL DEFAULT '',
  reply_source TEXT NOT NULL DEFAULT '',
  invoice_ids UUID[] NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tax_notices_organization_idx ON tax_notices (organization_id, status);

-- Payments to parties outside India (brokers, freight, labs), with TDS and Form 15CA / 15CB details.
CREATE TABLE IF NOT EXISTS foreign_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payee_name TEXT NOT NULL,
  payee_country TEXT NOT NULL DEFAULT '',
  nature TEXT NOT NULL CHECK (nature IN ('commission', 'freight', 'professional', 'royalty', 'interest', 'other')),
  paid_on DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  amount_fc NUMERIC(14, 2) NOT NULL CHECK (amount_fc > 0),
  rate_inr NUMERIC(12, 4) NOT NULL CHECK (rate_inr > 0),
  taxable_in_india BOOLEAN NOT NULL DEFAULT true,
  tds_rate NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (tds_rate >= 0 AND tds_rate <= 100),
  tds_inr NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (tds_inr >= 0),
  dtaa_applied BOOLEAN NOT NULL DEFAULT false,
  trc_received BOOLEAN NOT NULL DEFAULT false,
  form_15ca_ack TEXT NOT NULL DEFAULT '',
  form_15cb_no TEXT NOT NULL DEFAULT '',
  related_party BOOLEAN NOT NULL DEFAULT false,
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS foreign_payments_organization_idx ON foreign_payments (organization_id, paid_on);

-- Vouchers read from a Tally day book export, to compare the books with the app.
CREATE TABLE IF NOT EXISTS tally_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  voucher_date DATE NOT NULL,
  voucher_type TEXT NOT NULL DEFAULT '',
  voucher_kind TEXT NOT NULL CHECK (voucher_kind IN ('sales', 'receipt', 'purchase', 'other')),
  voucher_number TEXT NOT NULL DEFAULT '',
  party TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  amount_inr NUMERIC(16, 2) NOT NULL DEFAULT 0,
  amount_usd NUMERIC(14, 2),
  narration TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS tally_vouchers_organization_date_idx ON tally_vouchers (organization_id, voucher_date);

-- An accountant firm's own records about each client: fee, time spent, and fee bills.
CREATE TABLE IF NOT EXISTS ca_engagements (
  firm_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fee_inr NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (fee_inr >= 0),
  billing TEXT NOT NULL DEFAULT 'monthly' CHECK (billing IN ('monthly', 'quarterly', 'yearly', 'per_task')),
  notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (firm_id, client_id)
);

CREATE TABLE IF NOT EXISTS ca_time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL DEFAULT '',
  work_date DATE NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  task TEXT NOT NULL,
  billable BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ca_time_entries_firm_idx ON ca_time_entries (firm_id, client_id, work_date);

CREATE TABLE IF NOT EXISTS ca_fee_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bill_no TEXT NOT NULL,
  bill_date DATE NOT NULL,
  amount_inr NUMERIC(14, 2) NOT NULL CHECK (amount_inr > 0),
  paid_on DATE,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, bill_no)
);

-- Buyer credit limit, used to warn before shipping more to a slow payer.
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS credit_limit_usd NUMERIC(14, 2)
  CHECK (credit_limit_usd IS NULL OR credit_limit_usd >= 0);
