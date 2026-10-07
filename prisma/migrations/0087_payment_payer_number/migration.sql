-- ===========================================================================
-- 0087 — the number a non-cash payment came FROM (docs/21 D151, 2026-10-07).
--
-- ## What this adds
--
-- `payments.payer_number` VARCHAR(40) NULL: the phone or account number the
-- customer paid FROM, typed at the till for a bank or wallet payment (Bankily,
-- Masrvi, a bank transfer, ...). Optional. It is the sender's number as the
-- person at the till read it from the customer's screen or receipt — no
-- provider verified it, and nothing in the product claims one did.
--
-- Stored normalised by the server: an optional leading `+` and digits only
-- (spaces and hyphens typed at the till are presentation and are dropped;
-- no digit is ever added, removed or changed).
--
-- ## Why a column of its own
--
-- It is not the transaction reference (`reference`: the provider's id for the
-- transfer), not the customer's saved telephone (`customers.phone`: who bought
-- or who owes, often a different phone), and not the receiving account
-- (`receiving_account_id`: where the money LANDED). Overloading any of them
-- would make a dispute unanswerable — "which number paid?" and "which transfer
-- was it?" are separate questions with separate answers.
--
-- ## Cash never carries one
--
-- `ck_payments_cash_no_payer`: the drawer was paid in notes and there is no
-- number to record. The twin of `ck_payments_cash_no_account` (0045); the
-- service refuses the same thing before the database has to.
--
-- ## Nullable, and deliberately not backfilled
--
-- Every payment taken before this migration has no recorded payer number. NULL
-- means "not recorded", which is the truth. No total, balance, expected cash or
-- reconciliation figure reads this column.
--
-- ## Idempotence
--
-- Both statements are guarded on `information_schema`; re-running changes
-- nothing.
--
-- ## Reverse (for a database you would rather not restore; a Git rollback does
-- ## not roll back the database — docs/22 §3)
--
--   ALTER TABLE `payments`
--     DROP CHECK `ck_payments_cash_no_payer`,
--     DROP COLUMN `payer_number`;
-- ===========================================================================

SET @ddl := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM `information_schema`.`COLUMNS`
      WHERE `TABLE_SCHEMA` = DATABASE()
        AND `TABLE_NAME` = 'payments'
        AND `COLUMN_NAME` = 'payer_number'
    ),
    'SELECT 1',
    'ALTER TABLE `payments` ADD COLUMN `payer_number` VARCHAR(40) NULL AFTER `account_provider_snapshot`'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'payments'
      AND constraint_name = 'ck_payments_cash_no_payer') = 0,
  "ALTER TABLE `payments` ADD CONSTRAINT `ck_payments_cash_no_payer`
     CHECK (`method` <> 'cash' OR `payer_number` IS NULL)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
