-- 0044 — expenses become a reviewed workflow, and cash actually leaves the till
--
-- ## What the D0 audit found
--
-- Three things, and the second is a real accounting hole:
--
-- 1. **No lifecycle.** `POST /expenses` wrote a row that immediately reached
--    the day's profit. There was no report-then-confirm step, so "a report
--    changes nothing" could not be true — every submission was already final.
--
-- 2. **A cash expense never reduced expected cash.** Expenses fed
--    `rollup.expenses` and therefore net profit, but `closing.expectedCash`
--    subtracted refunds and supplier payments only. A shop that paid for
--    electricity out of the till reported a shortage that was not a shortage —
--    the same defect J1 fixed for supplier payments, still present here.
--
-- 3. **No channel at all.** Cash and bank transfer were indistinguishable, so
--    even once expenses reached the till figure there was no way to subtract
--    only the ones that actually touched the drawer.
--
-- Also: `expense.manage` is Owner-only, and `seed-data/permissions.ts` says why
-- — "the model cannot express submit separately from manage, so the narrower
-- reading wins". This migration makes the model able to express it.
--
-- Purely additive to `expenses`. `expense_templates` already carried the fixed
-- recurrence and is reused unchanged.
--
-- Rerun-safe: every statement is guarded.

-- 1. Lifecycle, channel and accounting class ---------------------------------
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'expenses'
      AND column_name = 'status') = 0,
  "ALTER TABLE `expenses`
     -- `reported` moves NO money and reaches no report. Only `confirmed` does.
     ADD COLUMN `status` ENUM('reported','confirmed','rejected') NOT NULL DEFAULT 'confirmed',

     /*
      * The accounting class, and it is not cosmetic.
      *   `variable` — electricity, food, supplies. Belongs to the day it is
      *                CONFIRMED.
      *   `fixed`    — rent, salaries, recurring owner-defined costs. Belongs to
      *                its DUE date, and is never spread across every day.
      */
     ADD COLUMN `expense_class` ENUM('variable','fixed') NOT NULL DEFAULT 'variable',
     -- Salaries stay separately reportable from other fixed costs.
     ADD COLUMN `is_salary` TINYINT(1) NOT NULL DEFAULT 0,
     -- The month a fixed expense is recognised in. NULL for variable.
     ADD COLUMN `due_date` DATE NULL,

     -- Which channel the money left by. Only `cash` touches the drawer.
     ADD COLUMN `method` ENUM('cash','account') NOT NULL DEFAULT 'cash',
     ADD COLUMN `receiving_account_id` BINARY(16) NULL,
     /*
      * Frozen when the expense is REPORTED. Renaming or deactivating an
      * account afterwards must not retitle a movement that already happened,
      * and must not strand a confirmation.
      */
     ADD COLUMN `account_label_snapshot` VARCHAR(80) NULL,

     ADD COLUMN `reference` VARCHAR(120) NULL,

     /*
      * An Owner may confirm without a detailed reason, but only deliberately.
      * Stored as an explicit state rather than invented placeholder copy —
      * \"Miscellaneous\" in a ledger is indistinguishable from a real category
      * a year later.
      */
     ADD COLUMN `reason_omitted` TINYINT(1) NOT NULL DEFAULT 0,

     ADD COLUMN `reported_by_id`  BINARY(16) NULL,
     ADD COLUMN `reported_at`     DATETIME(6) NULL,
     ADD COLUMN `confirmed_by_id` BINARY(16) NULL,
     ADD COLUMN `confirmed_at`    DATETIME(6) NULL,
     -- The business day the cash movement belongs to: the CONFIRMATION day.
     ADD COLUMN `confirmation_date` DATE NULL,
     ADD COLUMN `rejected_reason` VARCHAR(255) NULL,

     -- An offline retry must not record two expenses.
     ADD COLUMN `client_uuid` BINARY(16) NULL,
     ADD COLUMN `client_request_hash` CHAR(64) NULL,

     -- Optimistic concurrency: two owners deciding one report, one winner.
     ADD COLUMN `version` INT NOT NULL DEFAULT 0,

     ADD CONSTRAINT `fk_expenses_account`
       FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts` (`id`),
     ADD CONSTRAINT `fk_expenses_reported_by`
       FOREIGN KEY (`reported_by_id`) REFERENCES `users` (`id`),
     ADD CONSTRAINT `fk_expenses_confirmed_by`
       FOREIGN KEY (`confirmed_by_id`) REFERENCES `users` (`id`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

/*
 * Existing rows keep the meaning they already had. Every expense written before
 * this migration was final the moment it was created, so `confirmed` is the
 * honest backfill — and its confirmation day is the day it was recorded for,
 * which is exactly what the rollup already keyed on.
 *
 * Not left to the seed: `prisma migrate deploy` never runs it (the D2.1
 * lesson), so a deployed database would otherwise carry NULL confirmation
 * dates and silently drop those expenses out of every report.
 */
UPDATE `expenses`
   SET `confirmation_date` = `spent_on`,
       `confirmed_at`      = COALESCE(`confirmed_at`, `created_at`),
       `confirmed_by_id`   = COALESCE(`confirmed_by_id`, `created_by`),
       `reported_by_id`    = COALESCE(`reported_by_id`, `created_by`),
       `reported_at`       = COALESCE(`reported_at`, `created_at`)
 WHERE `status` = 'confirmed' AND `confirmation_date` IS NULL;

-- 2. Constraints --------------------------------------------------------------
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'expenses'
      AND constraint_name = 'ck_expenses_amount') = 0,
  'ALTER TABLE `expenses` ADD CONSTRAINT `ck_expenses_amount` CHECK (`amount` > 0)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- A channel expense names its account; a cash one never does.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'expenses'
      AND constraint_name = 'ck_expenses_method_account') = 0,
  "ALTER TABLE `expenses` ADD CONSTRAINT `ck_expenses_method_account` CHECK (
     (`method` = 'cash'    AND `receiving_account_id` IS NULL)
  OR (`method` = 'account' AND `receiving_account_id` IS NOT NULL))",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Decision fields are tied to status both ways, so a half-written confirmation
-- can never be read as a real one.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'expenses'
      AND constraint_name = 'ck_expenses_decision') = 0,
  "ALTER TABLE `expenses` ADD CONSTRAINT `ck_expenses_decision` CHECK (
     (`status` = 'reported'  AND `confirmed_at` IS NULL AND `confirmation_date` IS NULL)
  OR (`status` = 'rejected'  AND `confirmed_at` IS NULL AND `confirmation_date` IS NULL)
  OR (`status` = 'confirmed' AND `confirmed_at` IS NOT NULL AND `confirmation_date` IS NOT NULL))",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- A fixed expense is recognised on a due date; a variable one has none.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'expenses'
      AND constraint_name = 'ck_expenses_class_due') = 0,
  "ALTER TABLE `expenses` ADD CONSTRAINT `ck_expenses_class_due` CHECK (
     (`expense_class` = 'variable' AND `due_date` IS NULL)
  OR (`expense_class` = 'fixed'    AND `due_date` IS NOT NULL))",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Salary is a kind of fixed cost, never a variable one.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'expenses'
      AND constraint_name = 'ck_expenses_salary_fixed') = 0,
  "ALTER TABLE `expenses` ADD CONSTRAINT `ck_expenses_salary_fixed` CHECK (
     `is_salary` = 0 OR `expense_class` = 'fixed')",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Idempotency, and the reporting indexes the rollup now needs.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'expenses'
      AND index_name = 'ux_expenses_client_uuid') = 0,
  'ALTER TABLE `expenses`
     ADD UNIQUE KEY `ux_expenses_client_uuid` (`company_id`, `client_uuid`),
     ADD KEY `ix_expenses_confirmation` (`company_id`, `branch_id`, `confirmation_date`, `status`),
     ADD KEY `ix_expenses_due` (`company_id`, `branch_id`, `due_date`, `status`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. Append-only once confirmed ----------------------------------------------
-- A confirmed expense is money that left. Correcting one uses Milestone B's
-- append-only correction workflow, never a delete.
DROP TRIGGER IF EXISTS `expenses_block_delete`;
CREATE TRIGGER `expenses_block_delete`
BEFORE DELETE ON `expenses`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' AND OLD.`status` = 'confirmed' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A confirmed expense is never deleted: correct it instead';
  END IF;
END;

-- 4. Permissions --------------------------------------------------------------
-- Three narrow keys replace one broad one. `expense.manage` KEEPS its meaning
-- (categories, templates, settings) and is NOT widened.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'expense.submit', 'Submit an expense for review'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'expense.submit');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'expense.review', 'Confirm or reject a submitted expense'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'expense.review');

-- Submit: all three store roles. The person who spent the money is the one who
-- knows it happened. It does NOT reveal the shop's other expenses — the list
-- endpoint scopes a submitter to their own.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'expense.submit'
WHERE r.`key` IN ('owner', 'store_manager', 'store_employee')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Review: Owner ONLY. The approved decisions describe a narrow manager, and
-- confirming money out of the business is the Owner's call.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'expense.review'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- 5. Reconciliation columns ---------------------------------------------------
-- Expenses had no figure in the closing at all, which is finding 2 above.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'daily_rollups'
      AND column_name = 'expenses_cash') = 0,
  'ALTER TABLE `daily_rollups`
     ADD COLUMN `expenses_cash` DECIMAL(14,2) NOT NULL DEFAULT 0,
     ADD COLUMN `expenses_count` INT NOT NULL DEFAULT 0,
     ADD COLUMN `expenses_fixed` DECIMAL(14,2) NOT NULL DEFAULT 0,
     ADD COLUMN `expenses_salary` DECIMAL(14,2) NOT NULL DEFAULT 0',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings'
      AND column_name = 'expenses_cash') = 0,
  'ALTER TABLE `daily_closings`
     ADD COLUMN `expenses_cash` DECIMAL(14,2) NOT NULL DEFAULT 0',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Reverse SQL (not executed):
--   DROP TRIGGER IF EXISTS `expenses_block_delete`;
--   ALTER TABLE `expenses`
--     DROP CHECK `ck_expenses_amount`, DROP CHECK `ck_expenses_method_account`,
--     DROP CHECK `ck_expenses_decision`, DROP CHECK `ck_expenses_class_due`,
--     DROP CHECK `ck_expenses_salary_fixed`,
--     DROP INDEX `ux_expenses_client_uuid`, DROP INDEX `ix_expenses_confirmation`,
--     DROP INDEX `ix_expenses_due`,
--     DROP FOREIGN KEY `fk_expenses_account`,
--     DROP FOREIGN KEY `fk_expenses_reported_by`,
--     DROP FOREIGN KEY `fk_expenses_confirmed_by`,
--     DROP COLUMN `status`, DROP COLUMN `expense_class`, DROP COLUMN `is_salary`,
--     DROP COLUMN `due_date`, DROP COLUMN `method`,
--     DROP COLUMN `receiving_account_id`, DROP COLUMN `account_label_snapshot`,
--     DROP COLUMN `reference`, DROP COLUMN `reason_omitted`,
--     DROP COLUMN `reported_by_id`, DROP COLUMN `reported_at`,
--     DROP COLUMN `confirmed_by_id`, DROP COLUMN `confirmed_at`,
--     DROP COLUMN `confirmation_date`, DROP COLUMN `rejected_reason`,
--     DROP COLUMN `client_uuid`, DROP COLUMN `client_request_hash`,
--     DROP COLUMN `version`;
--   ALTER TABLE `daily_rollups` DROP COLUMN `expenses_cash`,
--     DROP COLUMN `expenses_count`, DROP COLUMN `expenses_fixed`,
--     DROP COLUMN `expenses_salary`;
--   ALTER TABLE `daily_closings` DROP COLUMN `expenses_cash`;
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` IN ('expense.submit', 'expense.review');
--   DELETE FROM `permissions` WHERE `key` IN ('expense.submit', 'expense.review');
