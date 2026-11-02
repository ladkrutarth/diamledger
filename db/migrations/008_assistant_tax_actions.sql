ALTER TABLE assistant_actions DROP CONSTRAINT IF EXISTS assistant_actions_kind_check;

ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check
  CHECK (kind IN ('record_payment', 'draft_reminder', 'match_bank_line', 'close_month'));
