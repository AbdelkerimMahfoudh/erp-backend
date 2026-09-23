-- 0076 — the business day, the reopenable closing, and the two closing delegates.
--
-- WHY
-- Every "day" in this database was a UTC calendar day: a phone sold at 01:30
-- landed on tomorrow's figures, and the shop's evening was cut in two. A
-- business day now begins at 06:00 in the company's local timezone, and the
-- date each money record belongs to is STORED beside its immutable instant,
-- so a later change of rule or zone can never move history.
--
-- A signed-off day could never be reopened, so a sale made after the close was
-- either refused (a payment, an expense) or silently left a locked snapshot
-- wrong (a sale). A close is now a counted snapshot AND a history event; the
-- same business day may be reopened before its boundary, recounted and closed
-- again, with the first snapshot kept on the row and in `closing_events`.
--
-- Closing authority becomes the Owner plus at most two delegated assignments
-- per branch (`closing.perform` is delegatable; the Store Manager no longer
-- holds it by role). Only the Owner may start the next business date early
-- (`closing.start_early`).
--
-- EFFECTIVE-DATE / BACKFILL POLICY (docs/50 §3.1, docs/21 2026-09-23)
-- Existing rows are backfilled with the UTC calendar date they were ALWAYS
-- reported under — DATE(sold_at), DATE(paid_at) — never recomputed with the
-- 06:00 rule. Every past report, rollup and the one existing closing stay
-- identical. The rule applies to records written after this migration is
-- applied (`effective_from` = the instant of application, recorded in
-- CURRENT_HANDOFF.md and docs/21). Nothing historical is reassigned.
--
-- Additive: no column is dropped, no row is deleted (except the Store
-- Manager's `closing.perform` role mapping, which is the decision above).
-- Reverse SQL at the bottom.

-- 1. Stored business dates --------------------------------------------------

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sales' AND column_name = 'business_date') = 0,
  "ALTER TABLE `sales` ADD COLUMN `business_date` DATE NULL AFTER `sold_at`",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
UPDATE `sales` SET `business_date` = DATE(`sold_at`) WHERE `business_date` IS NULL;
ALTER TABLE `sales` MODIFY COLUMN `business_date` DATE NOT NULL;
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'sales' AND index_name = 'ix_sales_business_date') = 0,
  "ALTER TABLE `sales` ADD INDEX `ix_sales_business_date` (`company_id`, `branch_id`, `business_date`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'business_date') = 0,
  "ALTER TABLE `payments` ADD COLUMN `business_date` DATE NULL AFTER `paid_at`",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
UPDATE `payments` SET `business_date` = DATE(`paid_at`) WHERE `business_date` IS NULL;
ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NOT NULL;
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'payments' AND index_name = 'ix_payments_business_date') = 0,
  "ALTER TABLE `payments` ADD INDEX `ix_payments_business_date` (`company_id`, `business_date`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'supplier_payments' AND column_name = 'business_date') = 0,
  "ALTER TABLE `supplier_payments` ADD COLUMN `business_date` DATE NULL AFTER `paid_at`",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
UPDATE `supplier_payments` SET `business_date` = DATE(`paid_at`) WHERE `business_date` IS NULL;
ALTER TABLE `supplier_payments` MODIFY COLUMN `business_date` DATE NOT NULL;
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'supplier_payments' AND index_name = 'ix_supplier_payments_business_date') = 0,
  "ALTER TABLE `supplier_payments` ADD INDEX `ix_supplier_payments_business_date` (`company_id`, `business_date`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. The reopenable closing -------------------------------------------------

-- `reopened`: signed off once, then reopened before the day's boundary.
-- `ck_closings_status_locked` ((status='locked') = (is_locked=1)) still holds:
-- a reopened day is not locked, and MySQL refuses to alter a column a CHECK
-- refers to, so it is dropped around the change and put back unchanged. The
-- two counting constraints 0046 left in place (`ck_closings_count_attribution`,
-- `ck_closings_counted_started`) name only `counted_by_id`/`counted_at` and
-- survive the change; a reopened day keeps the count it had.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings'
      AND constraint_name = 'ck_closings_status_locked') = 1,
  "ALTER TABLE `daily_closings` DROP CHECK `ck_closings_status_locked`",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

ALTER TABLE `daily_closings`
  MODIFY COLUMN `status` ENUM('counting','counted','locked','reopened') NOT NULL DEFAULT 'locked';

ALTER TABLE `daily_closings` ADD CONSTRAINT `ck_closings_status_locked`
  CHECK ((`status` = 'locked') = (`is_locked` = 1));

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings' AND column_name = 'first_closed_at') = 0,
  "ALTER TABLE `daily_closings`
     ADD COLUMN `first_closed_at` DATETIME(6) NULL,
     ADD COLUMN `first_closed_by_id` BINARY(16) NULL,
     ADD COLUMN `reopened_at` DATETIME(6) NULL,
     ADD COLUMN `reopened_by_id` BINARY(16) NULL,
     ADD COLUMN `reopen_count` INT NOT NULL DEFAULT 0,
     ADD CONSTRAINT `fk_closings_first_closed_by` FOREIGN KEY (`first_closed_by_id`) REFERENCES `users` (`id`),
     ADD CONSTRAINT `fk_closings_reopened_by` FOREIGN KEY (`reopened_by_id`) REFERENCES `users` (`id`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Every day already signed off was signed off exactly once: its first close is
-- its only close.
UPDATE `daily_closings`
   SET `first_closed_at` = `closed_at`, `first_closed_by_id` = `closed_by`
 WHERE `status` = 'locked' AND `first_closed_at` IS NULL;

-- Cash only: the drawer's opening balance, carried forward as a balance and
-- never as income. Existing rows keep 0, which is what the closing assumed.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'closing_channel_counts' AND column_name = 'opening_balance') = 0,
  "ALTER TABLE `closing_channel_counts`
     ADD COLUMN `opening_balance` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `corrections_in`",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. The history of a business day -----------------------------------------

CREATE TABLE IF NOT EXISTS `closing_events` (
  `id`            BINARY(16)   NOT NULL,
  `company_id`    BINARY(16)   NOT NULL,
  `branch_id`     BINARY(16)   NOT NULL,
  `business_date` DATE         NOT NULL,
  -- NULL only for `day_started_early`, which precedes any closing row.
  `closing_id`    BINARY(16)   NULL,
  `kind`          ENUM('count_saved','closed','reopened','auto_reopened','reclosed','day_started_early') NOT NULL,
  `at`            DATETIME(6)  NOT NULL,
  `actor_id`      BINARY(16)   NULL,
  -- The figures the event froze and the outcome of the Owner notice it caused.
  -- Never a full identifier, a cost or a customer's number.
  `payload`       JSON         NULL,
  -- Stable server event id — what a retried notice deduplicates on.
  `dedupe_key`    VARCHAR(120) NULL,
  `created_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_closing_events_dedupe` (`company_id`, `dedupe_key`),
  KEY `ix_closing_events_day` (`branch_id`, `business_date`, `at`),
  KEY `closing_events_closing_id_idx` (`closing_id`),
  KEY `closing_events_actor_id_idx` (`actor_id`),
  CONSTRAINT `fk_closing_events_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_closing_events_branch`  FOREIGN KEY (`branch_id`)  REFERENCES `branches` (`id`),
  CONSTRAINT `fk_closing_events_closing` FOREIGN KEY (`closing_id`) REFERENCES `daily_closings` (`id`),
  CONSTRAINT `fk_closing_events_actor`   FOREIGN KEY (`actor_id`)   REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Closing authority: the Owner and two named delegates ------------------

-- Only the Owner may start the next business date before 06:00.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'closing.start_early', 'Start the next business day before 06:00'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'closing.start_early');

INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'closing.start_early'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- A Store Manager signs a day off only as one of the Owner's two named
-- delegates (a per-branch grant from Team), never by role. Counting
-- (`closing.count`) is untouched.
DELETE rp FROM `role_permissions` rp
JOIN `roles` r ON r.`id` = rp.`role_id`
JOIN `permissions` p ON p.`id` = rp.`permission_id`
WHERE r.`key` = 'store_manager'
  AND p.`key` = 'closing.perform';

-- Reverse SQL (not executed):
--   INSERT INTO `role_permissions` (company_id, role_id, permission_id)
--     SELECT r.company_id, r.id, p.id FROM roles r JOIN permissions p ON p.`key` = 'closing.perform'
--     WHERE r.`key` = 'store_manager';
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` = 'closing.start_early';
--   DELETE FROM `permissions` WHERE `key` = 'closing.start_early';
--   DROP TABLE IF EXISTS `closing_events`;
--   ALTER TABLE `closing_channel_counts` DROP COLUMN `opening_balance`;
--   ALTER TABLE `daily_closings`
--     DROP FOREIGN KEY `fk_closings_first_closed_by`, DROP FOREIGN KEY `fk_closings_reopened_by`,
--     DROP COLUMN `first_closed_at`, DROP COLUMN `first_closed_by_id`,
--     DROP COLUMN `reopened_at`, DROP COLUMN `reopened_by_id`, DROP COLUMN `reopen_count`,
--     MODIFY COLUMN `status` ENUM('counting','counted','locked') NOT NULL DEFAULT 'locked';
--   ALTER TABLE `supplier_payments` DROP INDEX `ix_supplier_payments_business_date`, DROP COLUMN `business_date`;
--   ALTER TABLE `payments` DROP INDEX `ix_payments_business_date`, DROP COLUMN `business_date`;
--   ALTER TABLE `sales` DROP INDEX `ix_sales_business_date`, DROP COLUMN `business_date`;
