ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credit_days INTEGER NOT NULL DEFAULT 30
  CHECK (credit_days BETWEEN 0 AND 365);

CREATE TABLE IF NOT EXISTS payment_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'discarded')),
  message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS payment_reminders_invoice_idx
  ON payment_reminders (organization_id, invoice_id, created_at DESC);
