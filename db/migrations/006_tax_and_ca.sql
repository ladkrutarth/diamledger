CREATE TABLE IF NOT EXISTS invoice_tax (
  invoice_id UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  export_scheme TEXT NOT NULL DEFAULT 'lut' CHECK (export_scheme IN ('lut', 'igst')),
  shipping_bill_no TEXT NOT NULL DEFAULT '',
  shipping_bill_date DATE,
  igst_usd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (igst_usd >= 0)
);

CREATE INDEX IF NOT EXISTS invoice_tax_organization_id_idx ON invoice_tax (organization_id);

CREATE TABLE IF NOT EXISTS invoice_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shipping_bill', 'airway_bill', 'lut')),
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  content BYTEA NOT NULL,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, kind)
);

CREATE INDEX IF NOT EXISTS invoice_documents_organization_id_idx ON invoice_documents (organization_id);

CREATE TABLE IF NOT EXISTS invoice_reviews (
  invoice_id UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('query', 'accepted')),
  comment TEXT NOT NULL DEFAULT '',
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS closed_months (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, month)
);
