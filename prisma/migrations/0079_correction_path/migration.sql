-- 0079_correction_path — the full correction path for sales, payments, expenses and purchases
-- (docs/51 §15, D12–D20; the user's follow-up of 2026-09-25).
--
-- WHY THIS SCHEMA CHANGE
-- ----------------------
-- A confirmed financial record is never edited. Correcting one means appending a
-- compensating record that posts to the CURRENT open business day, so the original
-- day, its rollup and every closing snapshot stay exactly as they were. Milestone B
-- and 0078 built that for refund payouts, supplier settlements and a payment in the
-- wrong channel. This migration extends the same record to the four things a shop
-- actually gets wrong:
--
--   sale_payment · reverse     a payment recorded but never received (all or part)
--   sale         · cancel      a sale that should not exist as recorded
--   expense      · reverse     a confirmed expense that was wrong (all or part)
--   supplier_payment · reclassify  a purchase payment in the wrong channel
--   purchase     · cancel      a purchase that should not exist as recorded
--
-- 1. `financial_corrections` gains the four target kinds, an `action`, one target
--    column per kind with an approved-only unique key (one approved correction per
--    record, the 0040 pattern), and a NULL-able `method` for a cancellation, whose
--    money may sit in several channels and is carried by its legs.
-- 2. `financial_correction_legs` — ONE ledger of the money a correction moves:
--    direction, channel, account, amount, and the payment / purchase payment /
--    expense it came from. The closing reads it as `correctionsIn` / `correctionsOut`.
--    The 0078 reclassification is backfilled as its two legs.
-- 3. `sale_items.released_by_correction_id` — a cancelled sale's line no longer holds
--    its unit in the sold-once index, so the phone can be sold again. `voided` keeps
--    its old meaning; history keyed on the sale's day is untouched.
-- 4. `units.status` gains `voided`: a phone whose purchase was cancelled never entered
--    the books. IMEI uniqueness is NOT changed — receiving the same IMEI again
--    reactivates that record instead of creating a second one.
-- 5. `daily_rollups` gains the correction day's cancelled revenue and cost and its
--    reversed expenses, so net profit subtracts them on the day they were decided.
--
-- Every statement is re-runnable. Reverse: restore the 0079 backup (docs/22).

-- 1. financial_corrections ----------------------------------------------------------

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'financial_corrections' AND constraint_name = 'ck_fc_one_target') = 1,
  'ALTER TABLE `financial_corrections` DROP CHECK `ck_fc_one_target`', 'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'financial_corrections' AND constraint_name = 'ck_fc_destination') = 1,
  'ALTER TABLE `financial_corrections` DROP CHECK `ck_fc_destination`', 'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'financial_corrections' AND constraint_name = 'ck_fc_amount_positive') = 1,
  'ALTER TABLE `financial_corrections` DROP CHECK `ck_fc_amount_positive`', 'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'financial_corrections' AND constraint_name = 'ck_fc_action') = 1,
  'ALTER TABLE `financial_corrections` DROP CHECK `ck_fc_action`', 'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'financial_corrections' AND constraint_name = 'ck_fc_method') = 1,
  'ALTER TABLE `financial_corrections` DROP CHECK `ck_fc_method`', 'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

ALTER TABLE `financial_corrections`
  MODIFY COLUMN `target_kind`
    ENUM('refund_payout', 'supplier_settlement', 'sale_payment', 'sale', 'expense', 'supplier_payment', 'purchase') NOT NULL,
  MODIFY COLUMN `method` ENUM('cash', 'account') NULL;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'financial_corrections' AND column_name = 'action') = 0,
  "ALTER TABLE `financial_corrections`
     ADD COLUMN `action` ENUM('reverse', 'reclassify', 'cancel') NOT NULL DEFAULT 'reverse' AFTER `target_kind`,
     ADD COLUMN `target_sale_id` BINARY(16) NULL AFTER `target_payment_id`,
     ADD COLUMN `target_expense_id` BINARY(16) NULL AFTER `target_sale_id`,
     ADD COLUMN `target_supplier_payment_id` BINARY(16) NULL AFTER `target_expense_id`,
     ADD COLUMN `target_purchase_id` BINARY(16) NULL AFTER `target_supplier_payment_id`,
     ADD COLUMN `active_target_sale_id` BINARY(16)
       GENERATED ALWAYS AS (IF(`status` = 'approved', `target_sale_id`, NULL)) VIRTUAL,
     ADD COLUMN `active_target_expense_id` BINARY(16)
       GENERATED ALWAYS AS (IF(`status` = 'approved', `target_expense_id`, NULL)) VIRTUAL,
     ADD COLUMN `active_target_supplier_payment_id` BINARY(16)
       GENERATED ALWAYS AS (IF(`status` = 'approved', `target_supplier_payment_id`, NULL)) VIRTUAL,
     ADD COLUMN `active_target_purchase_id` BINARY(16)
       GENERATED ALWAYS AS (IF(`status` = 'approved', `target_purchase_id`, NULL)) VIRTUAL,
     ADD UNIQUE KEY `uq_fc_active_sale` (`active_target_sale_id`),
     ADD UNIQUE KEY `uq_fc_active_expense` (`active_target_expense_id`),
     ADD UNIQUE KEY `uq_fc_active_supplier_payment` (`active_target_supplier_payment_id`),
     ADD UNIQUE KEY `uq_fc_active_purchase` (`active_target_purchase_id`),
     ADD KEY `ix_fc_target_sale` (`target_sale_id`),
     ADD KEY `ix_fc_target_expense` (`target_expense_id`),
     ADD KEY `ix_fc_target_supplier_payment` (`target_supplier_payment_id`),
     ADD KEY `ix_fc_target_purchase` (`target_purchase_id`),
     ADD CONSTRAINT `fk_fc_sale` FOREIGN KEY (`target_sale_id`) REFERENCES `sales` (`id`),
     ADD CONSTRAINT `fk_fc_expense` FOREIGN KEY (`target_expense_id`) REFERENCES `expenses` (`id`),
     ADD CONSTRAINT `fk_fc_supplier_payment` FOREIGN KEY (`target_supplier_payment_id`) REFERENCES `supplier_payments` (`id`),
     ADD CONSTRAINT `fk_fc_purchase` FOREIGN KEY (`target_purchase_id`) REFERENCES `purchases` (`id`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- A 0078 correction of a sale payment was always a move to another channel.
UPDATE `financial_corrections` SET `action` = 'reclassify' WHERE `target_kind` = 'sale_payment' AND `to_method` IS NOT NULL;

ALTER TABLE `financial_corrections` ADD CONSTRAINT `ck_fc_one_target` CHECK (
  (`target_refund_payout_id` IS NOT NULL) + (`target_supplier_settlement_id` IS NOT NULL) + (`target_payment_id` IS NOT NULL)
    + (`target_sale_id` IS NOT NULL) + (`target_expense_id` IS NOT NULL) + (`target_supplier_payment_id` IS NOT NULL)
    + (`target_purchase_id` IS NOT NULL) = 1
  AND (
       (`target_kind` = 'refund_payout'       AND `target_refund_payout_id` IS NOT NULL)
    OR (`target_kind` = 'supplier_settlement' AND `target_supplier_settlement_id` IS NOT NULL)
    OR (`target_kind` = 'sale_payment'        AND `target_payment_id` IS NOT NULL)
    OR (`target_kind` = 'sale'                AND `target_sale_id` IS NOT NULL)
    OR (`target_kind` = 'expense'             AND `target_expense_id` IS NOT NULL)
    OR (`target_kind` = 'supplier_payment'    AND `target_supplier_payment_id` IS NOT NULL)
    OR (`target_kind` = 'purchase'            AND `target_purchase_id` IS NOT NULL)
  )
);

-- What each kind may do.
ALTER TABLE `financial_corrections` ADD CONSTRAINT `ck_fc_action` CHECK (
     (`target_kind` IN ('refund_payout', 'supplier_settlement', 'expense') AND `action` = 'reverse')
  OR (`target_kind` = 'sale_payment'     AND `action` IN ('reverse', 'reclassify'))
  OR (`target_kind` = 'supplier_payment' AND `action` = 'reclassify')
  OR (`target_kind` IN ('sale', 'purchase') AND `action` = 'cancel')
);

-- Only a move to another channel names a destination, and it names it completely.
ALTER TABLE `financial_corrections` ADD CONSTRAINT `ck_fc_destination` CHECK (
  (`action` <> 'reclassify'
     AND `to_method` IS NULL AND `to_receiving_account_id` IS NULL AND `to_account_label_snapshot` IS NULL)
  OR
  (`action` = 'reclassify'
     AND `to_method` IS NOT NULL
     AND ((`to_method` = 'cash') = (`to_receiving_account_id` IS NULL)))
);

-- A cancellation's money may sit in several channels (its legs say which); everything else has one.
ALTER TABLE `financial_corrections` ADD CONSTRAINT `ck_fc_method` CHECK (
  `method` IS NOT NULL OR `target_kind` IN ('sale', 'purchase')
);

-- The amount is the money moved, or for a cancellation the value cancelled — never negative, and only a
-- sale given away at no charge may be cancelled at zero (its phone must still come back to stock).
ALTER TABLE `financial_corrections` ADD CONSTRAINT `ck_fc_amount_positive` CHECK (
  `amount` > 0 OR (`target_kind` = 'sale' AND `amount` = 0)
);

-- 2. financial_correction_legs -------------------------------------------------------

CREATE TABLE IF NOT EXISTS `financial_correction_legs` (
  `id`                          BINARY(16)    NOT NULL,
  `company_id`                  BINARY(16)    NOT NULL,
  `correction_id`               BINARY(16)    NOT NULL,
  /** `in`: money reaches the channel; `out`: it leaves. */
  `direction`                   ENUM('in', 'out') NOT NULL,
  `method`                      ENUM('cash', 'account') NOT NULL,
  /** NULL for cash, and for an account payment that never named its account (unattributed). */
  `receiving_account_id`        BINARY(16)    NULL,
  `account_label_snapshot`      VARCHAR(80)   NULL,
  `amount`                      DECIMAL(14,2) NOT NULL,
  `source_payment_id`           BINARY(16)    NULL,
  `source_supplier_payment_id`  BINARY(16)    NULL,
  `source_expense_id`           BINARY(16)    NULL,
  `created_at`                  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_fcl_correction` (`correction_id`),
  KEY `ix_fcl_company` (`company_id`),
  KEY `ix_fcl_account` (`receiving_account_id`),
  KEY `ix_fcl_payment` (`source_payment_id`),
  KEY `ix_fcl_supplier_payment` (`source_supplier_payment_id`),
  KEY `ix_fcl_expense` (`source_expense_id`),
  CONSTRAINT `fk_fcl_company`          FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_fcl_correction`       FOREIGN KEY (`correction_id`) REFERENCES `financial_corrections` (`id`),
  CONSTRAINT `fk_fcl_account`          FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts` (`id`),
  CONSTRAINT `fk_fcl_payment`          FOREIGN KEY (`source_payment_id`) REFERENCES `payments` (`id`),
  CONSTRAINT `fk_fcl_supplier_payment` FOREIGN KEY (`source_supplier_payment_id`) REFERENCES `supplier_payments` (`id`),
  CONSTRAINT `fk_fcl_expense`          FOREIGN KEY (`source_expense_id`) REFERENCES `expenses` (`id`),
  CONSTRAINT `ck_fcl_amount_positive`  CHECK (`amount` > 0),
  CONSTRAINT `ck_fcl_cash_no_account`  CHECK (`method` = 'account' OR `receiving_account_id` IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only for the application account, as every financial record here (0028, 0036, 0040).
DROP TRIGGER IF EXISTS `financial_correction_legs_block_update`;
CREATE TRIGGER `financial_correction_legs_block_update`
BEFORE UPDATE ON `financial_correction_legs`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'financial_correction_legs is append-only: a leg is never changed';
  END IF;
END;

DROP TRIGGER IF EXISTS `financial_correction_legs_block_delete`;
CREATE TRIGGER `financial_correction_legs_block_delete`
BEFORE DELETE ON `financial_correction_legs`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'financial_correction_legs is append-only: a leg is never deleted';
  END IF;
END;

-- The 0078 reclassifications as their two legs: out of the recorded channel, into the real one.
INSERT INTO `financial_correction_legs`
  (`id`, `company_id`, `correction_id`, `direction`, `method`, `receiving_account_id`, `account_label_snapshot`, `amount`, `source_payment_id`, `created_at`)
SELECT UUID_TO_BIN(UUID()), fc.`company_id`, fc.`id`, 'out',
       IF(p.`method` = 'cash', 'cash', 'account'), IF(p.`method` = 'cash', NULL, p.`receiving_account_id`),
       IF(p.`method` = 'cash', NULL, p.`account_label_snapshot`), fc.`amount`, p.`id`, fc.`decided_at`
  FROM `financial_corrections` fc
  JOIN `payments` p ON p.`id` = fc.`target_payment_id`
 WHERE fc.`target_kind` = 'sale_payment' AND fc.`action` = 'reclassify' AND fc.`status` = 'approved'
   AND NOT EXISTS (SELECT 1 FROM `financial_correction_legs` l WHERE l.`correction_id` = fc.`id` AND l.`direction` = 'out');
INSERT INTO `financial_correction_legs`
  (`id`, `company_id`, `correction_id`, `direction`, `method`, `receiving_account_id`, `account_label_snapshot`, `amount`, `source_payment_id`, `created_at`)
SELECT UUID_TO_BIN(UUID()), fc.`company_id`, fc.`id`, 'in',
       fc.`to_method`, fc.`to_receiving_account_id`, fc.`to_account_label_snapshot`, fc.`amount`, fc.`target_payment_id`, fc.`decided_at`
  FROM `financial_corrections` fc
 WHERE fc.`target_kind` = 'sale_payment' AND fc.`action` = 'reclassify' AND fc.`status` = 'approved'
   AND NOT EXISTS (SELECT 1 FROM `financial_correction_legs` l WHERE l.`correction_id` = fc.`id` AND l.`direction` = 'in');

-- 3. sale_items: a cancelled sale releases its units from sold-once ------------------

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sale_items' AND column_name = 'released_by_correction_id') = 0,
  "ALTER TABLE `sale_items`
     ADD COLUMN `released_by_correction_id` BINARY(16) NULL AFTER `voided`,
     ADD KEY `ix_sale_items_released` (`released_by_correction_id`),
     ADD CONSTRAINT `fk_sale_items_released` FOREIGN KEY (`released_by_correction_id`) REFERENCES `financial_corrections` (`id`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sale_items' AND column_name = 'active_unit_id'
      AND generation_expression LIKE '%released_by_correction_id%') = 0,
  "ALTER TABLE `sale_items`
     DROP INDEX `ux_saleitem_active_unit`,
     MODIFY COLUMN `active_unit_id` BINARY(16)
       GENERATED ALWAYS AS (IF(`voided` = 0 AND `released_by_correction_id` IS NULL, `unit_id`, NULL)) VIRTUAL,
     ADD UNIQUE KEY `ux_saleitem_active_unit` (`active_unit_id`)",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 4. units: a phone whose purchase was cancelled --------------------------------------

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'units'
      AND column_name = 'status' AND column_type NOT LIKE '%voided%') = 1,
  "ALTER TABLE `units` MODIFY COLUMN `status`
     ENUM('in_stock','reserved','sold','returned','faulty','in_transit',
          'transferred_out','consigned_out','voided') NOT NULL DEFAULT 'in_stock'",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 5. daily_rollups: the correction day's cancelled sales and reversed expenses ---------

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'daily_rollups' AND column_name = 'cancelled_revenue') = 0,
  "ALTER TABLE `daily_rollups`
     ADD COLUMN `cancelled_revenue` DECIMAL(14,2) NOT NULL DEFAULT 0,
     ADD COLUMN `cancelled_cogs` DECIMAL(14,2) NOT NULL DEFAULT 0,
     ADD COLUMN `cancelled_count` INT NOT NULL DEFAULT 0,
     ADD COLUMN `expense_reversals` DECIMAL(14,2) NOT NULL DEFAULT 0",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
