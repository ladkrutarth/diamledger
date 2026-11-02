-- Daily USD/INR reference rates fetched from the public rate source. Shared by every company.
CREATE TABLE IF NOT EXISTS reference_rates (
  currency TEXT NOT NULL DEFAULT 'USD',
  rate_date DATE NOT NULL,
  rate_inr NUMERIC(12, 4) NOT NULL CHECK (rate_inr > 0),
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (currency, rate_date)
);

-- Rates a company enters itself, such as the customs notified rate. These win over reference rates.
CREATE TABLE IF NOT EXISTS organization_rates (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'USD',
  rate_date DATE NOT NULL,
  rate_inr NUMERIC(12, 4) NOT NULL CHECK (rate_inr > 0),
  note TEXT NOT NULL DEFAULT '',
  entered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, currency, rate_date)
);

-- Who changed what, and when.
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_organization_created_idx ON audit_events (organization_id, created_at DESC);

-- Parcels received into stock. Carats out are read from the invoices that name the parcel.
CREATE TABLE IF NOT EXISTS parcels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parcel_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  received_on DATE,
  source TEXT NOT NULL DEFAULT '',
  pieces_in INTEGER NOT NULL DEFAULT 0 CHECK (pieces_in >= 0),
  carats_in NUMERIC(12, 3) NOT NULL CHECK (carats_in > 0),
  notes TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, parcel_id)
);

-- Private read-only links that let a buyer see their own invoices.
CREATE TABLE IF NOT EXISTS buyer_portal_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  buyer_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_viewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS buyer_portal_links_organization_idx ON buyer_portal_links (organization_id);
