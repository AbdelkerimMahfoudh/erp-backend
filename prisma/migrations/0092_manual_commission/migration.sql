-- 0092_manual_commission — D164 (the owner, 2026-10-12): the money-agent commission is typed by the employee for
-- every exchange, paid by the customer, and never touches the provider's credit. There is no rate.
--
-- Additive and non-destructive:
--   * `agent_transactions.commission_source` ('manual' | 'legacy_rate'). Every row that exists when this runs was
--     priced by a rate, and takes 'legacy_rate' from the column's initial default — no UPDATE touches an exchange;
--     the default then becomes 'manual' for what the API records from now on. Stored commissions, legs, rates,
--     configuration versions and snapshots are kept exactly as recorded; nothing is recomputed.
--   * `commission_rate_bp`, `config_version_id`, `config_snapshot` become NULLable: a typed commission has no rate,
--     and a provider may have no configuration version (a provider is usable as soon as it is switched on).
--   * Two CHECKs: a manual commission is whole MRU, carries no rate and, giving cash, is never above the amount; a
--     legacy row keeps its rate and version.
--   * The append-only trigger is recreated with NULL-safe comparisons (`<=>`, now that three columns can be NULL),
--     with `commission_source` and `config_snapshot` among the columns that never change, and with exactly one new
--     permitted change: the account deletion's de-identification (customer number and last four emptied, a deleted
--     employee's name replaced by 'Deleted user') — no figure, no leg, no date.
-- `agent_provider_configs` keeps every column: the rate, destination and fee-mode fields of the versions written
-- before D164 are history; new versions set only `reference_rule` (the API writes the others NULL). Removing them
-- is a later, separate step, after a backup/restore rehearsal proves nothing reads them.
--
-- Reverse (only before any 'manual' row exists — a manual row has NULLs the old NOT NULL columns refuse):
--   DROP TRIGGER `agent_transactions_block_update`; recreate 0089's trigger;
--   ALTER TABLE `agent_transactions` DROP CHECK `ck_agent_transactions_commission_manual`,
--     DROP CHECK `ck_agent_transactions_commission_legacy`;
--   ALTER TABLE `agent_transactions` DROP FOREIGN KEY `fk_agent_transactions_config`;
--   ALTER TABLE `agent_transactions` MODIFY `commission_rate_bp` INT UNSIGNED NOT NULL,
--     MODIFY `config_version_id` BINARY(16) NOT NULL, MODIFY `config_snapshot` JSON NOT NULL, DROP COLUMN `commission_source`;
--   ALTER TABLE `agent_transactions` ADD CONSTRAINT `fk_agent_transactions_config` FOREIGN KEY (`config_version_id`)
--     REFERENCES `agent_provider_configs` (`id`);

-- 1. The source of every commission: the rows already here were priced by the rate.
ALTER TABLE `agent_transactions`
  ADD COLUMN `commission_source` ENUM('manual','legacy_rate') NOT NULL DEFAULT 'legacy_rate' AFTER `commission_amount`;
ALTER TABLE `agent_transactions` ALTER COLUMN `commission_source` SET DEFAULT 'manual';

-- 2. No rate, and possibly no configuration version, for a typed commission. The foreign key is dropped and put back
--    around the change so MySQL accepts the column's new nullability.
ALTER TABLE `agent_transactions` DROP FOREIGN KEY `fk_agent_transactions_config`;
ALTER TABLE `agent_transactions`
  MODIFY `commission_rate_bp` INT UNSIGNED NULL,
  MODIFY `config_version_id`  BINARY(16)   NULL,
  MODIFY `config_snapshot`    JSON         NULL;
ALTER TABLE `agent_transactions`
  ADD CONSTRAINT `fk_agent_transactions_config` FOREIGN KEY (`config_version_id`) REFERENCES `agent_provider_configs` (`id`);

-- 3. What a typed commission may be, and what a legacy row keeps.
ALTER TABLE `agent_transactions`
  ADD CONSTRAINT `ck_agent_transactions_commission_manual` CHECK (
    `commission_source` <> 'manual'
    OR (`commission_amount` = ROUND(`commission_amount`, 0)
        AND `commission_rate_bp` IS NULL
        AND (`direction` <> 'cash_out_credit_in' OR `commission_amount` <= `amount`))
  ),
  ADD CONSTRAINT `ck_agent_transactions_commission_legacy` CHECK (
    `commission_source` <> 'legacy_rate' OR (`commission_rate_bp` IS NOT NULL AND `config_version_id` IS NOT NULL)
  );

-- 4. A completed exchange is never rewritten: only its reversal fields may be set, once. NULL-safe now.
--    One more kind of change is allowed, and only this one: the de-identification the account deletion performs
--    (docs/64, the correction of 2026-10-12) — the customer's number (and its last four digits) emptied, and the name
--    of a deleted employee replaced by the neutral 'Deleted user'. It moves no money and changes no figure; a reversed
--    exchange stays final for everything else.
DROP TRIGGER IF EXISTS `agent_transactions_block_update`;
CREATE TRIGGER `agent_transactions_block_update`
BEFORE UPDATE ON `agent_transactions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    IF NOT (NEW.`amount` <=> OLD.`amount`) OR NOT (NEW.`direction` <=> OLD.`direction`)
       OR NOT (NEW.`provider_id` <=> OLD.`provider_id`)
       OR NOT (NEW.`commission_amount` <=> OLD.`commission_amount`) OR NOT (NEW.`commission_source` <=> OLD.`commission_source`)
       OR NOT (NEW.`commission_rate_bp` <=> OLD.`commission_rate_bp`) OR NOT (NEW.`config_version_id` <=> OLD.`config_version_id`)
       OR NOT (NEW.`config_snapshot` <=> OLD.`config_snapshot`)
       OR NOT (NEW.`business_date` <=> OLD.`business_date`) OR NOT (NEW.`recorded_at` <=> OLD.`recorded_at`)
       OR NOT (NEW.`recorded_by_id` <=> OLD.`recorded_by_id`) OR NOT (NEW.`client_uuid` <=> OLD.`client_uuid`)
       OR NOT (NEW.`branch_id` <=> OLD.`branch_id`) OR NOT (NEW.`company_id` <=> OLD.`company_id`)
       OR (NOT (NEW.`customer_number` <=> OLD.`customer_number`) AND NEW.`customer_number` <> '')
       OR (NOT (NEW.`customer_number_last4` <=> OLD.`customer_number_last4`) AND NEW.`customer_number_last4` <> '')
       OR (NOT (NEW.`recorded_by_name` <=> OLD.`recorded_by_name`) AND NEW.`recorded_by_name` <> 'Deleted user') THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'agent_transactions: a completed exchange is never edited — reverse it';
    END IF;
    IF OLD.`status` = 'reversed' AND NOT (
         NEW.`status` <=> OLD.`status` AND NEW.`reversed_at` <=> OLD.`reversed_at`
         AND NEW.`reversed_by_id` <=> OLD.`reversed_by_id` AND NEW.`reversal_reason` <=> OLD.`reversal_reason`
         AND NEW.`reversal_client_uuid` <=> OLD.`reversal_client_uuid` AND NEW.`provider_reference` <=> OLD.`provider_reference`
         AND (NEW.`reversed_by_name` <=> OLD.`reversed_by_name` OR NEW.`reversed_by_name` = 'Deleted user')) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'agent_transactions: a reversed exchange is final';
    END IF;
  END IF;
END;
