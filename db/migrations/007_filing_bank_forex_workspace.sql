ALTER TABLE invoice_tax ADD COLUMN IF NOT EXISTS port_code TEXT NOT NULL DEFAULT '';
ALTER TABLE invoice_tax ADD COLUMN IF NOT EXISTS sb_invoice_number TEXT NOT NULL DEFAULT '';
ALTER TABLE invoice_tax ADD COLUMN IF NOT EXISTS sb_value_usd NUMERIC(14, 2);

CREATE TABLE IF NOT EXISTS invoice_einvoices (
  invoice_id UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  irn TEXT NOT NULL CHECK (irn ~ '^[0-9a-f]{64}$'),
  ack_no TEXT NOT NULL DEFAULT '',
  ack_date DATE,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_rate_inr NUMERIC(12, 4)
  CHECK (bank_rate_inr IS NULL OR bank_rate_inr > 0);

CREATE TABLE IF NOT EXISTS bank_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  line_date DATE NOT NULL,
  amount_usd NUMERIC(14, 2) NOT NULL CHECK (amount_usd > 0),
  bank_rate_inr NUMERIC(12, 4) CHECK (bank_rate_inr IS NULL OR bank_rate_inr > 0),
  reference TEXT NOT NULL DEFAULT '',
  narration TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'ignored')),
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS bank_lines_organization_status_idx ON bank_lines (organization_id, status);

CREATE TABLE IF NOT EXISTS invoice_brcs (
  invoice_id UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brc_number TEXT NOT NULL,
  realised_on DATE NOT NULL,
  amount_usd NUMERIC(14, 2) NOT NULL CHECK (amount_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_tax_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  realization_months INTEGER NOT NULL DEFAULT 9 CHECK (realization_months BETWEEN 1 AND 36),
  lut_valid_until DATE,
  einvoice_required BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_access (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ca', 'tax')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);
