-- ===========================================================================
-- 0038_refund_payout  (Phase I3)
--
-- Recording that a refund was handed back — reported by whoever handed it over,
-- and CONFIRMED by a manager or owner. The confirmation is the record; the
-- report is a claim.
--
-- The application never moves money. No provider, no balance, no credential, no
-- API. It records what the shop says happened.
--
-- ---------------------------------------------------------------------------
-- WHY NOT `payments`
-- ---------------------------------------------------------------------------
-- `payments.sale_id` is REQUIRED, so a refund would have to attach itself to a
-- sale it merely reverses — making that sale's payment history untrue, when the
-- original sale is immutable by decision. Worse, the only consumer of that table
-- computes `expected_cash` as the SUM of cash payments, so a refund row would be
-- counted as money the shop RECEIVED. A negative amount would silently flip the
-- sign of a column every other reader assumes is positive.
--
-- `receiving_accounts` IS reused: it holds a provider, a label and an active
-- flag — no balance and no direction — and answers "through which channel?",
-- which is the same question either way. The audit is `docs/27` §17.
--
-- ---------------------------------------------------------------------------
-- ONE PAYOUT PER APPROVED RETURN
-- ---------------------------------------------------------------------------
-- `return_request_id` is UNIQUE. A return is settled once or not at all: there
-- is no partial payout in I3, and a second settlement is not a state the
-- business has.
--
-- The lifecycle is deliberately two words long:
--
--   reported_pending_confirmation   somebody says the money was handed over
--   confirmed                       a manager or owner agrees it was
--
-- There is no `paid` or `settled` reachable before confirmation, because a
-- state that does not exist cannot be displayed by mistake.
--
-- ---------------------------------------------------------------------------
-- THE AMOUNT IS NOT THE CLIENT'S
-- ---------------------------------------------------------------------------
-- `amount` must equal the immutable `net_refund_due` on the I2 reversal. The
-- application validates that before insert, and the CHECK below refuses a
-- negative in any case. There is no partial refund and no customer debt: both
-- would be new product decisions, and neither is approved.
--
-- ---------------------------------------------------------------------------
-- CASH CARRIES NO ACCOUNT, AND AN ACCOUNT IS NOT CASH
-- ---------------------------------------------------------------------------
-- Enforced in the application rather than by CHECK: `receiving_account_id` is a
-- foreign key, and MySQL error 3823 forbids a CHECK over a column that
-- participates in one — the limitation `0002` documents. The rule is: cash must
-- have no account, and a configured channel must have one.
--
-- ---------------------------------------------------------------------------
-- REVERSE SQL (executed against a restored copy, not merely written down)
--
--   DROP TRIGGER IF EXISTS `refund_payouts_block_delete`;
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` IN ('refund.report','refund.confirm');
--   DELETE FROM `permissions` WHERE `key` IN ('refund.report','refund.confirm');
--   ALTER TABLE `daily_closings` DROP COLUMN `refunds_paid_cash`, DROP COLUMN `refunds_paid_total`;
--   ALTER TABLE `daily_rollups` DROP COLUMN `refunds_paid_cash`, DROP COLUMN `refunds_paid_total`,
--     DROP COLUMN `refunds_paid_count`;
--   DROP TABLE IF EXISTS `refund_payouts`;
--
-- RERUN SAFETY: CREATE TABLE IF NOT EXISTS, guarded ALTERs through prepared
-- statements, DROP/CREATE for the trigger, and INSERT … WHERE NOT EXISTS for
-- permissions — the same shape as 0036 and 0037.
-- ===========================================================================

-- 1. The payout ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `refund_payouts` (
  `id`                BINARY(16) NOT NULL,
  `company_id`        BINARY(16) NOT NULL,
  `branch_id`         BINARY(16) NOT NULL,
  `return_request_id` BINARY(16) NOT NULL,
  `return_reversal_id` BINARY(16) NOT NULL,

  `status` ENUM('reported_pending_confirmation','confirmed')
    NOT NULL DEFAULT 'reported_pending_confirmation',

  /* The immutable figure this settles, copied from the reversal so the payout
     is readable on its own and cannot drift from what was owed. */
  `net_amount_due`    DECIMAL(14,2) NOT NULL,
  /* What the reporter says was handed over. Validated to equal the above. */
  `reported_amount`   DECIMAL(14,2) NOT NULL,

  `method` ENUM('cash','account') NOT NULL,
  `receiving_account_id` BINARY(16) NULL,
  /* Snapshotted at confirmation, so a receipt printed months later still reads
     what the employee chose even if the Owner has since renamed the account. */
  `account_label_snapshot` VARCHAR(80) NULL,

  `transaction_reference` VARCHAR(120) NULL,
  `note`                  VARCHAR(255) NULL,

  `reported_by_id`   BINARY(16) NULL,
  `reported_at`      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `confirmed_by_id`  BINARY(16) NULL,
  `confirmed_at`     DATETIME(6) NULL,
  /* The business date the cash movement belongs to — the confirmation day. */
  `confirmation_date` DATE NULL,

  `client_uuid`         BINARY(16) NOT NULL,
  `client_request_hash` CHAR(64) NOT NULL,

  `version`    INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (`id`),
  /* Settled once, or not at all. */
  UNIQUE KEY `ux_refund_payouts_request` (`return_request_id`),
  UNIQUE KEY `ux_refund_payouts_reversal` (`return_reversal_id`),
  UNIQUE KEY `ux_refund_payouts_client_uuid` (`company_id`, `client_uuid`),
  KEY `ix_refund_payouts_branch_status` (`branch_id`, `status`),
  KEY `ix_refund_payouts_confirmation_date` (`branch_id`, `confirmation_date`),
  KEY `ix_refund_payouts_company` (`company_id`, `status`),
  CONSTRAINT `fk_refund_payouts_company`  FOREIGN KEY (`company_id`)  REFERENCES `companies` (`id`),
  CONSTRAINT `fk_refund_payouts_branch`   FOREIGN KEY (`branch_id`)   REFERENCES `branches` (`id`),
  CONSTRAINT `fk_refund_payouts_request`  FOREIGN KEY (`return_request_id`)  REFERENCES `return_requests` (`id`),
  CONSTRAINT `fk_refund_payouts_reversal` FOREIGN KEY (`return_reversal_id`) REFERENCES `return_reversals` (`id`),
  CONSTRAINT `fk_refund_payouts_account`  FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts` (`id`),
  CONSTRAINT `fk_refund_payouts_reporter`  FOREIGN KEY (`reported_by_id`)  REFERENCES `users` (`id`),
  CONSTRAINT `fk_refund_payouts_confirmer` FOREIGN KEY (`confirmed_by_id`) REFERENCES `users` (`id`),
  /* Non-FK columns only, per the 0002 limitation. */
  CONSTRAINT `refund_payouts_due_nonneg_chk`      CHECK (`net_amount_due` >= 0),
  CONSTRAINT `refund_payouts_reported_nonneg_chk` CHECK (`reported_amount` >= 0),
  /* No partial payout in I3: what was reported must be what was owed. */
  CONSTRAINT `refund_payouts_amount_match_chk`    CHECK (`reported_amount` = `net_amount_due`),
  /* A confirmed payout must carry who and when; an unconfirmed one must not. */
  CONSTRAINT `refund_payouts_confirmation_chk` CHECK (
    (`status` = 'confirmed' AND `confirmed_at` IS NOT NULL AND `confirmation_date` IS NOT NULL)
    OR (`status` = 'reported_pending_confirmation' AND `confirmed_at` IS NULL AND `confirmation_date` IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. A confirmed payout is never deleted -------------------------------------
-- Only DELETE is blocked, not UPDATE: a payout is legitimately corrected while
-- it is still awaiting confirmation, and freezing it is the application's job
-- once confirmed. Deleting a settlement, however, is never a correction — it is
-- the disappearance of a record that money left the till.
--
-- Same shape as audit_logs (0028): tests USER() at run time, so it blocks the
-- application account and leaves the migrator free, which is what keeps the
-- docs/22 restore path working.

DROP TRIGGER IF EXISTS `refund_payouts_block_delete`;

CREATE TRIGGER `refund_payouts_block_delete` BEFORE DELETE ON `refund_payouts`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'refund_payouts cannot be deleted by the application user';
  END IF;
END;

-- 3. Reporting ----------------------------------------------------------------
-- Cash paid out on the CONFIRMATION day, so a closing written afterwards
-- carries it. Positive magnitudes; consumers subtract explicitly. There is
-- deliberately no profit column: profit was reversed at approval, and taking it
-- again here is the double-count this phase exists to avoid.

SET @needed := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'daily_rollups' AND column_name = 'refunds_paid_total'
);
SET @ddl := IF(@needed, 'ALTER TABLE `daily_rollups` ADD COLUMN `refunds_paid_total` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `returns_count`, ADD COLUMN `refunds_paid_cash` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `refunds_paid_total`, ADD COLUMN `refunds_paid_count` INT NOT NULL DEFAULT 0 AFTER `refunds_paid_cash`', 'DO 0');
PREPARE add_refunds_paid FROM @ddl;
EXECUTE add_refunds_paid;
DEALLOCATE PREPARE add_refunds_paid;

SET @needed := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'daily_closings' AND column_name = 'refunds_paid_total'
);
SET @ddl := IF(@needed, 'ALTER TABLE `daily_closings` ADD COLUMN `refunds_paid_total` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `total_returns_cogs_credited`, ADD COLUMN `refunds_paid_cash` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `refunds_paid_total`', 'DO 0');
PREPARE add_closing_refunds FROM @ddl;
EXECUTE add_closing_refunds;
DEALLOCATE PREPARE add_closing_refunds;

-- 4. Permissions ---------------------------------------------------------------
-- `migrate deploy` never runs the seed, so the grants live here. Both keys are
-- absent from COMPANY_PERMISSIONS and are therefore branch-scoped, fail-closed.

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'refund.report', 'Report that a refund was handed to the customer'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'refund.report');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'refund.confirm', 'Confirm a refund was actually paid'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'refund.confirm');

-- Reporting: every store role. Whoever hands the money over records it.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'refund.report'
WHERE r.`key` IN ('owner', 'store_manager', 'store_employee')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Confirming: Owner and Store Manager only. The person who says money left the
-- till must not also be the person who certifies it — that separation is the
-- entire reason this phase has two steps.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'refund.confirm'
WHERE r.`key` IN ('owner', 'store_manager')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
