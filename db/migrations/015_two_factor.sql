-- Two-step sign-in: an authenticator app (TOTP) and/or a code texted to a phone, plus one-time recovery codes.

CREATE TABLE IF NOT EXISTS user_two_factor (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The authenticator app's shared secret, encrypted by the API (ENCRYPTION_KEY). NULL: no app.
  totp_secret_encrypted TEXT,
  -- A secret being set up, until the user proves the app shows the right code.
  totp_pending_encrypted TEXT,
  -- The last 30-second step a code was accepted for, so a code cannot be used twice.
  totp_last_step BIGINT NOT NULL DEFAULT 0,
  -- Confirmed phone number in E.164 (+919812345678). NULL: no phone.
  phone TEXT CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  phone_pending TEXT CHECK (phone_pending IS NULL OR phone_pending ~ '^\+[1-9][0-9]{7,14}$'),
  -- SHA-256 of each unused recovery code. A used code is removed.
  recovery_codes TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Codes sent by text message, for signing in or for confirming a new phone number.
CREATE TABLE IF NOT EXISTS two_factor_codes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('sign_in', 'phone_setup')),
  phone TEXT NOT NULL,
  -- HMAC of the code with the session secret; the code itself is never stored.
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS two_factor_codes_user_idx ON two_factor_codes (user_id, purpose, created_at DESC);
