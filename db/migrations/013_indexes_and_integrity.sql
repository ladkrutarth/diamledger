-- Indexes for queries the app runs on every screen, and database-level guards for rules that were
-- only checked in application code. Everything here is idempotent and safe inside the migration
-- transaction behind a pooler (no CONCURRENTLY). The tables are small enough per company that the
-- brief lock while an index builds is acceptable; on a very large database build these by hand first.

-- GET /api/invoices orders one company's invoices by updated_at, newest first.
CREATE INDEX IF NOT EXISTS invoices_organization_updated_idx ON invoices (organization_id, updated_at DESC);

-- Dashboard and list filters by status.
CREATE INDEX IF NOT EXISTS invoices_organization_status_idx ON invoices (organization_id, status);

-- The buyer portal matches LOWER(TRIM(buyer_name)); a plain buyer_name index cannot serve that.
CREATE INDEX IF NOT EXISTS invoices_organization_buyer_idx ON invoices (organization_id, lower(btrim(buyer_name)));

-- Dashboard "collected this month" filters payments by company and date.
CREATE INDEX IF NOT EXISTS payments_organization_paid_on_idx ON payments (organization_id, paid_on);

-- Password change, reset, and removing a user delete sessions with sess->>'userId'. Without an index
-- each of those scans the whole session table.
CREATE INDEX IF NOT EXISTS session_user_id_idx ON session ((sess->>'userId'));

-- Lets the cleanup job find expired rows, and a user delete find its reset tokens, without a scan.
CREATE INDEX IF NOT EXISTS rate_limits_reset_at_idx ON rate_limits (reset_at);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);

-- One invoice number per company, ignoring case. The app checks this before inserting, but two
-- requests at the same moment can both pass that check. If old data already holds duplicates the
-- index is skipped with a warning instead of stopping the deploy; fix those rows, then add the index.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM invoices WHERE invoice_number <> ''
    GROUP BY organization_id, lower(invoice_number) HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'invoices_organization_number_key not created: duplicate invoice numbers exist. Resolve them, then create a UNIQUE index on (organization_id, lower(invoice_number)) WHERE invoice_number <> ''''.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_organization_number_key
      ON invoices (organization_id, lower(invoice_number)) WHERE invoice_number <> '';
  END IF;
END $$;

-- Allowed values. NOT VALID checks every new or changed row without scanning (or failing on) old rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_status_check') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
      CHECK (status IN ('draft', 'issued', 'paid', 'cancelled')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'member', 'tax', 'ca')) NOT VALID;
  END IF;
END $$;
