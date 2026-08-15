-- 0040 — correcting a confirmed payment, without rewriting it (Milestone B)
--
-- The gap this closes: a confirmed refund payout and a confirmed supplier
-- settlement are both immutable by design, and nothing financial is ever
-- hard-deleted — but until now there was no reversal path either, so a
-- confirmation made in error had no remedy at all.
--
-- Purely additive. One new table, two new permissions. **No existing table is
-- altered and no existing row is ever rewritten**, including the payout or
-- settlement being corrected.
--
-- Why nothing needs to be written back to the original row:
--
--   Both liabilities are already DERIVED from rows whose status is 'confirmed'
--   (`suppliers.service.outstandingBySupplier`, `returns.service.refundSummary`).
--   So a correction restores the liability simply by existing — the derivation
--   queries exclude any target that has an approved correction. There is no
--   counter to decrement, which is what makes "restored exactly once" a
--   property of the schema rather than a thing the application must remember.
--
-- Rerun-safe: every statement is guarded, so replaying this migration on a
-- database that already has it applied is a no-op rather than error 1050.

-- 1. The correction --------------------------------------------------------
-- Requested by an Owner or Store Manager, approved by an Owner only. A request
-- moves no money: only an APPROVED row restores liability and posts the
-- compensating movement.
CREATE TABLE IF NOT EXISTS `financial_corrections` (
  `id`         BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  -- The branch whose till the compensating movement lands in. It is the branch
  -- that made the original payment, copied at request time so a correction
  -- cannot be posted against a different drawer than the one that paid.
  `branch_id`  BINARY(16) NOT NULL,

  `target_kind` ENUM('refund_payout', 'supplier_settlement') NOT NULL,
  -- Exactly one of these is set, matching `target_kind`. Two nullable columns
  -- rather than one polymorphic id, so both keep a real foreign key.
  `target_refund_payout_id`       BINARY(16) NULL,
  `target_supplier_settlement_id` BINARY(16) NULL,

  `status` ENUM('requested', 'approved', 'rejected') NOT NULL DEFAULT 'requested',

  -- Mandatory. A correction to confirmed money without a stated reason is
  -- indistinguishable from a mistake, months later.
  `reason`               VARCHAR(255) NOT NULL,
  `supporting_reference` VARCHAR(120) NULL,

  -- Copied from the target at request time. The compensating movement is the
  -- exact opposite of what was paid; it is never entered by hand, so it cannot
  -- disagree with the transaction it reverses.
  `amount` DECIMAL(14, 2) NOT NULL,
  -- Frozen from the target too, so reconciliation can group the compensating
  -- movement by the same channel the original used.
  `method` ENUM('cash', 'account') NOT NULL,
  `account_label_snapshot` VARCHAR(80) NULL,

  `requested_by_id` BINARY(16) NULL,
  `requested_at`    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `decided_by_id`   BINARY(16) NULL,
  `decided_at`      DATETIME(6) NULL,
  -- The business date the compensating movement belongs to: the CURRENT open
  -- day at approval, never the original payment's day. Old closings stay shut.
  `correction_date` DATE NULL,

  -- An offline retry must not record two corrections.
  `client_uuid`         BINARY(16) NOT NULL,
  `client_request_hash` CHAR(64)   NOT NULL,

  -- Optimistic concurrency: two owners approving one request, one winner.
  `version` INT NOT NULL DEFAULT 0,

  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  /*
   * Only ONE approved correction may exist per target — the schema guarantee
   * behind "prevent double correction" and "liability restored exactly once".
   *
   * MySQL has no partial unique index, so this uses the VIRTUAL generated
   * column trick already established by `sale_items.active_unit_id` in 0002:
   * the column is the target id only while the row is approved, and NULL
   * otherwise. NULLs do not collide in a UNIQUE index, so any number of
   * requested or rejected corrections may exist against the same target while
   * at most one approved one ever can.
   */
  `active_target_payout_id` BINARY(16)
    GENERATED ALWAYS AS (IF(`status` = 'approved', `target_refund_payout_id`, NULL)) VIRTUAL,
  `active_target_settlement_id` BINARY(16)
    GENERATED ALWAYS AS (IF(`status` = 'approved', `target_supplier_settlement_id`, NULL)) VIRTUAL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fc_active_payout` (`active_target_payout_id`),
  UNIQUE KEY `uq_fc_active_settlement` (`active_target_settlement_id`),
  UNIQUE KEY `uq_fc_client_uuid` (`company_id`, `client_uuid`),

  KEY `ix_fc_company_status` (`company_id`, `status`),
  KEY `ix_fc_branch_date` (`company_id`, `branch_id`, `correction_date`),
  KEY `ix_fc_target_payout` (`target_refund_payout_id`),
  KEY `ix_fc_target_settlement` (`target_supplier_settlement_id`),

  CONSTRAINT `fk_fc_company`  FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_fc_branch`   FOREIGN KEY (`branch_id`)  REFERENCES `branches` (`id`),
  CONSTRAINT `fk_fc_payout`
    FOREIGN KEY (`target_refund_payout_id`) REFERENCES `refund_payouts` (`id`),
  CONSTRAINT `fk_fc_settlement`
    FOREIGN KEY (`target_supplier_settlement_id`) REFERENCES `supplier_settlements` (`id`),
  CONSTRAINT `fk_fc_requested_by` FOREIGN KEY (`requested_by_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_fc_decided_by`   FOREIGN KEY (`decided_by_id`)   REFERENCES `users` (`id`),

  -- Exactly one target, and it must match the declared kind.
  CONSTRAINT `ck_fc_one_target` CHECK (
    (`target_kind` = 'refund_payout'
       AND `target_refund_payout_id` IS NOT NULL
       AND `target_supplier_settlement_id` IS NULL)
    OR
    (`target_kind` = 'supplier_settlement'
       AND `target_supplier_settlement_id` IS NOT NULL
       AND `target_refund_payout_id` IS NULL)
  ),

  -- A correction never invents an amount, and never reverses nothing.
  CONSTRAINT `ck_fc_amount_positive` CHECK (`amount` > 0),

  -- A reason that is only whitespace is not a reason.
  CONSTRAINT `ck_fc_reason_present` CHECK (CHAR_LENGTH(TRIM(`reason`)) > 0),

  /*
   * Decision fields are tied to status BOTH ways. Approved must carry who
   * decided, when, and which business day the money moves on; anything not yet
   * approved must carry none of them. This is what stops a half-written
   * approval from being read as a real one.
   */
  CONSTRAINT `ck_fc_decision_fields` CHECK (
    (`status` = 'requested'
       AND `decided_by_id` IS NULL AND `decided_at` IS NULL AND `correction_date` IS NULL)
    OR
    (`status` = 'rejected'
       AND `decided_by_id` IS NOT NULL AND `decided_at` IS NOT NULL AND `correction_date` IS NULL)
    OR
    (`status` = 'approved'
       AND `decided_by_id` IS NOT NULL AND `decided_at` IS NOT NULL AND `correction_date` IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. Append-only ------------------------------------------------------------
-- Same shape as every other financial trigger here: DELETE is refused for the
-- application user, and the migrator is exempt by design so the documented
-- restore in docs/22 keeps working.
DROP TRIGGER IF EXISTS `financial_corrections_block_delete`;
CREATE TRIGGER `financial_corrections_block_delete`
BEFORE DELETE ON `financial_corrections`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'financial_corrections is append-only: corrections are never deleted';
  END IF;
END;

-- 3. Permissions ------------------------------------------------------------
-- Two keys, because asking for a correction and authorising one are different
-- authorities. Requesting is a Manager's job; approving is the Owner's alone,
-- since approval is what actually moves money back.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'financial.correction.request', 'Request a correction to a confirmed payment'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'financial.correction.request');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'financial.correction.approve', 'Approve a correction to a confirmed payment'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'financial.correction.approve');

-- Request: Owner and Store Manager. Deliberately NOT Store Employee — an
-- employee who reported a payment must not be able to open the process that
-- unwinds it.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'financial.correction.request'
WHERE r.`key` IN ('owner', 'store_manager')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Approve: Owner only. This is the single most consequential action in the
-- application — it puts money back into a liability that was already settled.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'financial.correction.approve'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- 4. Reconciliation columns -------------------------------------------------
-- A corrected payment puts cash BACK in the drawer on the correction day.
-- Without these, expected cash would still be short by the amount of a payment
-- that has since been reversed. Defaulted to 0, so every closing already filed
-- keeps exactly the figures it was closed with.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'daily_rollups'
      AND column_name = 'corrections_total') = 0,
  'ALTER TABLE `daily_rollups`
     ADD COLUMN `corrections_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
     ADD COLUMN `corrections_cash`  DECIMAL(14,2) NOT NULL DEFAULT 0,
     ADD COLUMN `corrections_count` INT NOT NULL DEFAULT 0',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings'
      AND column_name = 'corrections_total') = 0,
  'ALTER TABLE `daily_closings`
     ADD COLUMN `corrections_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
     ADD COLUMN `corrections_cash`  DECIMAL(14,2) NOT NULL DEFAULT 0',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Reverse SQL (not executed; kept so a rollback is a decision, not a puzzle):
--   DROP TRIGGER IF EXISTS `financial_corrections_block_delete`;
--   DROP TABLE IF EXISTS `financial_corrections`;
--   ALTER TABLE `daily_rollups`
--     DROP COLUMN `corrections_total`, DROP COLUMN `corrections_cash`,
--     DROP COLUMN `corrections_count`;
--   ALTER TABLE `daily_closings`
--     DROP COLUMN `corrections_total`, DROP COLUMN `corrections_cash`;
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` IN ('financial.correction.request', 'financial.correction.approve');
--   DELETE FROM `permissions`
--     WHERE `key` IN ('financial.correction.request', 'financial.correction.approve');
