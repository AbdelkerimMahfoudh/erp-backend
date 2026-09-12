-- 0069 — freeze the PROVIDER beside the label on every payment (4a).
--
-- WHAT THIS ADDS
--
-- `payments.account_provider_snapshot`: which service the money came through at
-- the moment it was taken — `bankily`, `sedad`, `bim_bank`, or the configured
-- name when the provider is `other`.
--
-- WHY THE LABEL WAS NOT ENOUGH
--
-- `account_label_snapshot` already freezes what the till displayed, so renaming
-- an account does not retitle money that already arrived. But the label is free
-- text a shop chooses: renaming "Bankily – Main Counter" to "Counter 1" leaves a
-- reprinted receipt unable to say which service was used, and an account edited
-- from one provider to another would make every earlier payment appear to have
-- used the new one. The provider is the fact a customer dispute actually turns
-- on, so it is frozen beside the label rather than read live from the account.
--
-- NULLABLE, AND DELIBERATELY NOT BACKFILLED
--
-- Every payment taken before this migration has no recorded provider. Guessing
-- one from the account's CURRENT provider is exactly the error this column
-- exists to prevent — that value may already have changed. NULL means "not
-- recorded", which is the truth, and is reported as such rather than shown as a
-- provider nobody verified. Cash is always NULL: the drawer has no provider.
--
-- IDEMPOTENCE
--
-- Guarded on `information_schema`, so re-running changes nothing.

SET @ddl := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM `information_schema`.`COLUMNS`
      WHERE `TABLE_SCHEMA` = DATABASE()
        AND `TABLE_NAME` = 'payments'
        AND `COLUMN_NAME` = 'account_provider_snapshot'
    ),
    'SELECT 1',
    'ALTER TABLE `payments` ADD COLUMN `account_provider_snapshot` VARCHAR(60) NULL AFTER `account_label_snapshot`'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
