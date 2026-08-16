-- 0045 — the closing becomes progressive, per-channel, and answerable
--
-- ## What the E0 audit found
--
-- Three things, and the first is the one that stops an Employee working:
--
-- 1. **An Employee cannot enter a count at all.** `closing.perform` both
--    records the count AND locks the day, and it is held only by Owner and
--    Manager. So the person who actually holds the drawer at the end of the
--    shift cannot report what is in it — somebody senior has to be standing
--    there. That is a permission modelling problem, not a policy one.
--
-- 2. **The closing is cash-only.** `expected_cash` / `counted_cash` /
--    `difference` are single figures. A shop taking Bankily has no expected
--    figure for it, so an account can drift indefinitely and nothing notices.
--
-- 3. **A difference has nowhere to go.** `difference` is a number on a locked
--    row. There is no investigation, no decision, no record of who was held
--    responsible, and no ledger if somebody agreed to repay. So the shortage
--    is either silently absorbed or settled verbally.
--
-- ## The asymmetry this migration had to fix first
--
-- Money going OUT is attributed to an account: `refund_payouts`,
-- `supplier_settlements` and `expenses` all carry `receiving_account_id`.
-- Money coming IN is not — `payments` records only a `method`
-- (cash/card/mobile/bank/other), so there was no way to say which Bankily
-- account a Bankily sale landed in.
--
-- A per-account expected figure is arithmetically impossible without that, so
-- part 1 adds it. Historical rows stay NULL and are reported as **unattributed**
-- rather than being guessed into an account — inventing which account a sale
-- from six months ago landed in would be fabricating a financial record.
--
-- Rerun-safe: every statement is guarded.

-- 1. Attribute incoming money to an account -----------------------------------
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'payments'
      AND column_name = 'receiving_account_id') = 0,
  "ALTER TABLE `payments`
     /*
      * Which account the money landed in. NULL means unattributed:
      *   - every payment taken before this migration, and
      *   - any non-cash payment where the till did not identify an account.
      * NULL is never silently folded into a real account's expected figure.
      */
     ADD COLUMN `receiving_account_id` BINARY(16) NULL,
     /*
      * Frozen at the moment of payment. Renaming or deactivating an account
      * later must not retitle money that already came in.
      */
     ADD COLUMN `account_label_snapshot` VARCHAR(80) NULL,
     ADD CONSTRAINT `fk_payments_account`
       FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts` (`id`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'payments'
      AND index_name = 'ix_payments_account') = 0,
  'ALTER TABLE `payments` ADD KEY `ix_payments_account` (`company_id`, `receiving_account_id`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Cash never belongs to an account. Stated once, here, so no code path has to
-- remember it.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'payments'
      AND constraint_name = 'ck_payments_cash_no_account') = 0,
  "ALTER TABLE `payments` ADD CONSTRAINT `ck_payments_cash_no_account`
     CHECK (`method` <> 'cash' OR `receiving_account_id` IS NULL)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. The closing gains a lifecycle --------------------------------------------
-- Counting and locking become two separate acts by two possibly different
-- people. `locked` is the DEFAULT so that every closing written before this
-- migration keeps exactly the meaning it had: somebody counted and signed off
-- in one step.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings'
      AND column_name = 'status') = 0,
  "ALTER TABLE `daily_closings`
     /*
      *   `counting` — open. Figures move as the day's work is confirmed.
      *   `counted`  — a count has been entered. Still not signed off.
      *   `locked`   — signed off. The figures are a snapshot and never move.
      */
     ADD COLUMN `status` ENUM('counting','counted','locked') NOT NULL DEFAULT 'locked',
     ADD COLUMN `counted_by_id` BINARY(16) NULL,
     ADD COLUMN `counted_at` DATETIME(6) NULL,
     -- Optimistic concurrency: two people finishing one day, one winner.
     ADD COLUMN `version` INT NOT NULL DEFAULT 0,
     ADD CONSTRAINT `fk_closings_counted_by`
       FOREIGN KEY (`counted_by_id`) REFERENCES `users` (`id`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- `is_locked` predates the lifecycle and both are read by existing code. Tie
-- them together in the schema rather than trusting every future writer to keep
-- them in step.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings'
      AND constraint_name = 'ck_closings_status_locked') = 0,
  "ALTER TABLE `daily_closings` ADD CONSTRAINT `ck_closings_status_locked`
     CHECK ((`status` = 'locked') = (`is_locked` = 1))",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- A count that exists must say who entered it and when; one that does not must
-- claim neither. Both directions, so neither half can be forgotten.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings'
      AND constraint_name = 'ck_closings_counted_fields') = 0,
  "ALTER TABLE `daily_closings` ADD CONSTRAINT `ck_closings_counted_fields`
     CHECK ((`status` = 'counting') = (`counted_at` IS NULL))",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. Per-channel expected and counted ------------------------------------------
-- One row per channel the branch actually used that day: cash, plus each
-- receiving account with movement. Each row carries its own components, so a
-- channel can explain its own expected figure without recomputing anything —
-- the same reason the cash closing snapshots its components.
CREATE TABLE IF NOT EXISTS `closing_channel_counts` (
  `id`         BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `closing_id` BINARY(16) NOT NULL,

  `channel` ENUM('cash','account') NOT NULL,
  -- NULL for cash, and NULL for the unattributed bucket of a method whose
  -- payments never named an account.
  `receiving_account_id` BINARY(16) NULL,
  -- Frozen, like every other account reference in this schema.
  `label_snapshot` VARCHAR(80) NOT NULL,

  /*
   * The same five movements the cash equation is built from, per channel:
   *   expected = sales_in − refunds_out − supplier_out − expenses_out
   *            + corrections_in
   * Stored individually so the figure is answerable, not just assertable.
   */
  `sales_in`      DECIMAL(14,2) NOT NULL DEFAULT 0,
  `refunds_out`   DECIMAL(14,2) NOT NULL DEFAULT 0,
  `supplier_out`  DECIMAL(14,2) NOT NULL DEFAULT 0,
  `expenses_out`  DECIMAL(14,2) NOT NULL DEFAULT 0,
  `corrections_in` DECIMAL(14,2) NOT NULL DEFAULT 0,

  `expected` DECIMAL(14,2) NOT NULL DEFAULT 0,
  /*
   * NULL means genuinely not counted yet — distinct from counted as zero.
   * A shop that has not counted its Bankily balance must not read as balanced.
   */
  `counted`    DECIMAL(14,2) NULL,
  `difference` DECIMAL(14,2) NULL,

  /*
   * An account balance is a running total, not a daily till. It is reconcilable
   * only when the shop can actually read the figure, so a channel may be
   * skipped with a reason instead of being counted — and skipping is recorded,
   * never inferred from a missing count.
   */
  `is_skipped`    TINYINT(1) NOT NULL DEFAULT 0,
  `skip_reason`   VARCHAR(255) NULL,

  `counted_by_id` BINARY(16) NULL,
  `counted_at`    DATETIME(6) NULL,

  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  /*
   * MySQL has no partial unique index, and a NULL account would let the same
   * channel be inserted twice. The generated key collapses both cases into one
   * comparable value — the `active_unit_id` precedent from 0002.
   */
  `channel_key` VARCHAR(40) AS (CONCAT(`channel`, ':', IFNULL(HEX(`receiving_account_id`), 'NONE'))) VIRTUAL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_channel_counts_closing_channel` (`closing_id`, `channel_key`),
  KEY `ix_channel_counts_company` (`company_id`),
  KEY `ix_channel_counts_account` (`receiving_account_id`),
  CONSTRAINT `fk_channel_counts_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_channel_counts_closing` FOREIGN KEY (`closing_id`) REFERENCES `daily_closings` (`id`),
  CONSTRAINT `fk_channel_counts_account` FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts` (`id`),
  CONSTRAINT `fk_channel_counts_counted_by` FOREIGN KEY (`counted_by_id`) REFERENCES `users` (`id`),

  -- Cash is the drawer and belongs to no account.
  CONSTRAINT `ck_channel_counts_cash` CHECK (`channel` <> 'cash' OR `receiving_account_id` IS NULL),
  -- A skip states why. A count does not pretend to be a skip.
  CONSTRAINT `ck_channel_counts_skip`
    CHECK ((`is_skipped` = 0 AND `skip_reason` IS NULL)
        OR (`is_skipped` = 1 AND `counted` IS NULL AND TRIM(COALESCE(`skip_reason`, '')) <> '')),
  -- A difference exists exactly when a count does.
  CONSTRAINT `ck_channel_counts_difference`
    CHECK ((`counted` IS NULL) = (`difference` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. A difference becomes a question, not a number ------------------------------
CREATE TABLE IF NOT EXISTS `closing_discrepancies` (
  `id`         BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id`  BINARY(16) NOT NULL,
  `closing_id` BINARY(16) NOT NULL,
  -- Which channel was out. NULL only for a legacy cash-only closing.
  `channel_count_id` BINARY(16) NULL,

  -- Signed: negative is a shortage, positive is a surplus. A surplus is
  -- investigated too — unexplained extra money is a mis-recorded sale until
  -- somebody proves otherwise.
  `amount` DECIMAL(14,2) NOT NULL,

  /*
   * Opens `pending_investigation` and is NEVER auto-assigned to anybody. The
   * system observes that the drawer is short; it does not accuse the person who
   * happened to be counting.
   */
  `status` ENUM('pending_investigation','resolved') NOT NULL DEFAULT 'pending_investigation',

  /*
   *   `employee_debt`  — a person accepted responsibility. Writes a ledger row.
   *   `store_absorbed` — the business takes the loss.
   *   `error_corrected`— the money was never missing; a record was wrong.
   *   `forgiven`       — responsibility identified, then waived.
   */
  `resolution` ENUM('employee_debt','store_absorbed','error_corrected','forgiven') NULL,
  `responsible_user_id` BINARY(16) NULL,
  -- Mandatory on resolution. There is no resolving a shortage silently.
  `resolution_reason` VARCHAR(255) NULL,

  `opened_at`     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `resolved_by_id` BINARY(16) NULL,
  `resolved_at`   DATETIME(6) NULL,

  `version` INT NOT NULL DEFAULT 0,

  PRIMARY KEY (`id`),
  KEY `ix_discrepancies_company` (`company_id`, `branch_id`, `status`),
  KEY `ix_discrepancies_closing` (`closing_id`),
  KEY `ix_discrepancies_user` (`responsible_user_id`),
  KEY `ix_discrepancies_channel` (`channel_count_id`),
  KEY `ix_discrepancies_resolved_by` (`resolved_by_id`),
  CONSTRAINT `fk_discrepancies_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_discrepancies_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_discrepancies_closing` FOREIGN KEY (`closing_id`) REFERENCES `daily_closings` (`id`),
  CONSTRAINT `fk_discrepancies_channel` FOREIGN KEY (`channel_count_id`) REFERENCES `closing_channel_counts` (`id`),
  CONSTRAINT `fk_discrepancies_user` FOREIGN KEY (`responsible_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_discrepancies_resolved_by` FOREIGN KEY (`resolved_by_id`) REFERENCES `users` (`id`),

  -- A discrepancy of zero is not a discrepancy.
  CONSTRAINT `ck_discrepancies_amount` CHECK (`amount` <> 0),
  /*
   * Resolved implies all four decision fields; pending implies none of them.
   * Both directions, so a half-written resolution cannot exist.
   */
  CONSTRAINT `ck_discrepancies_resolution`
    CHECK ((`status` = 'pending_investigation'
              AND `resolution` IS NULL AND `resolved_at` IS NULL
              AND `resolved_by_id` IS NULL AND `resolution_reason` IS NULL)
        OR (`status` = 'resolved'
              AND `resolution` IS NOT NULL AND `resolved_at` IS NOT NULL
              AND `resolved_by_id` IS NOT NULL
              AND TRIM(COALESCE(`resolution_reason`, '')) <> '')),
  -- Holding a person responsible requires naming them.
  CONSTRAINT `ck_discrepancies_responsible`
    CHECK (`resolution` IS NULL
        OR `resolution` IN ('store_absorbed', 'error_corrected')
        OR `responsible_user_id` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. The debt ledger, append-only ------------------------------------------------
-- What somebody owes is DERIVED from these rows and stored nowhere:
--   balance = charges − repayments − deductions − forgiveness
-- A stored balance can disagree with its own history. A derived one cannot.
CREATE TABLE IF NOT EXISTS `employee_debt_entries` (
  `id`         BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id`  BINARY(16) NOT NULL,
  `user_id`    BINARY(16) NOT NULL,
  -- Where it came from. NULL for a repayment against an older balance.
  `discrepancy_id` BINARY(16) NULL,

  /*
   *   `charge`     — a shortage the person accepted. Increases what is owed.
   *   `repayment`  — money handed back. Decreases it.
   *   `deduction`  — withheld from pay. Decreases it.
   *   `forgiveness`— written off. Decreases it, and the business bears it.
   */
  `kind` ENUM('charge','repayment','deduction','forgiveness') NOT NULL,
  -- Always a positive magnitude. `kind` carries the direction, so no row can
  -- be ambiguous about which way the money went.
  `amount` DECIMAL(14,2) NOT NULL,

  -- Mandatory, every kind, no exception. A ledger row nobody can explain is
  -- worse than no ledger at all.
  `reason` VARCHAR(255) NOT NULL,
  -- How a repayment arrived. NULL for the other kinds.
  `method` ENUM('cash','account','payroll') NULL,
  `reference` VARCHAR(120) NULL,

  `entry_date` DATE NOT NULL,
  `created_by_id` BINARY(16) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  -- An offline retry must not charge somebody twice.
  `client_uuid` BINARY(16) NULL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_debt_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_debt_user` (`company_id`, `user_id`, `entry_date`),
  KEY `ix_debt_discrepancy` (`discrepancy_id`),
  KEY `ix_debt_branch` (`branch_id`),
  KEY `ix_debt_created_by` (`created_by_id`),
  CONSTRAINT `fk_debt_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_debt_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_debt_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_debt_discrepancy` FOREIGN KEY (`discrepancy_id`) REFERENCES `closing_discrepancies` (`id`),
  CONSTRAINT `fk_debt_created_by` FOREIGN KEY (`created_by_id`) REFERENCES `users` (`id`),

  CONSTRAINT `ck_debt_amount` CHECK (`amount` > 0),
  CONSTRAINT `ck_debt_reason` CHECK (TRIM(`reason`) <> ''),
  -- Only a repayment arrives by a method.
  CONSTRAINT `ck_debt_method` CHECK (`kind` = 'repayment' OR `method` IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only, enforced where it cannot be bypassed. A correction is another
-- row, exactly as Milestone B established for every other financial record.
--
-- The migrator is exempt so `docs/22` restore still works; the application user
-- is not.
DROP TRIGGER IF EXISTS `debt_entries_block_update`;
CREATE TRIGGER `debt_entries_block_update`
BEFORE UPDATE ON `employee_debt_entries`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'The debt ledger is append-only: add a correcting entry instead';
  END IF;
END;

DROP TRIGGER IF EXISTS `debt_entries_block_delete`;
CREATE TRIGGER `debt_entries_block_delete`
BEFORE DELETE ON `employee_debt_entries`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'The debt ledger is append-only: a ledger row is never deleted';
  END IF;
END;

-- 6. Permissions ------------------------------------------------------------------
-- `closing.count` — the E0 finding. Separating counting from locking is the
-- whole point: the Employee reports what is in the drawer, and signing the day
-- off stays exactly where it was, with `closing.perform`.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'closing.count', 'Enter an end-of-day count'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'closing.count');

-- `debt.manage` — deliberately NOT folded into `closing.perform`, which a
-- Manager holds. Deciding that a named person owes the business money, or
-- writing that debt off, is the Owner's call and nobody else's.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'debt.manage', 'Assign, collect or forgive a cash discrepancy'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'debt.manage');

-- Count: all three store roles. The person holding the drawer is the person
-- who can count it.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'closing.count'
WHERE r.`key` IN ('owner', 'store_manager', 'store_employee')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Debt: Owner ONLY.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'debt.manage'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Reverse SQL (not executed):
--   DROP TRIGGER IF EXISTS `debt_entries_block_update`;
--   DROP TRIGGER IF EXISTS `debt_entries_block_delete`;
--   DROP TABLE IF EXISTS `employee_debt_entries`;
--   DROP TABLE IF EXISTS `closing_discrepancies`;
--   DROP TABLE IF EXISTS `closing_channel_counts`;
--   ALTER TABLE `daily_closings`
--     DROP CHECK `ck_closings_status_locked`, DROP CHECK `ck_closings_counted_fields`,
--     DROP FOREIGN KEY `fk_closings_counted_by`,
--     DROP COLUMN `status`, DROP COLUMN `counted_by_id`, DROP COLUMN `counted_at`,
--     DROP COLUMN `version`;
--   ALTER TABLE `payments`
--     DROP CHECK `ck_payments_cash_no_account`,
--     DROP FOREIGN KEY `fk_payments_account`, DROP INDEX `ix_payments_account`,
--     DROP COLUMN `receiving_account_id`, DROP COLUMN `account_label_snapshot`;
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` IN ('closing.count', 'debt.manage');
--   DELETE FROM `permissions` WHERE `key` IN ('closing.count', 'debt.manage');
