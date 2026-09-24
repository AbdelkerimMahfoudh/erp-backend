-- 0078: the Daily closing report, the close without physical counts, and the payment
-- reclassification (docs/51 §13, decisions D2–D4, D9).
--
-- 1. **A close may record that the drawer was NOT counted.** Physical checks become
--    optional (D2). Writing 0 would fake a shortage and set the next opening to 0;
--    writing the expected figure would fake a match. So the counted cash and its
--    difference become NULL-able — together, never one without the other — and a
--    NULL means "not verified at this close". Existing rows keep their values.
--
-- 2. **A correction can move money OUT of a channel** (`corrections_out`). Until now a
--    correction could only bring money back (`corrections_in`), so moving a payment
--    from one channel to another could not be expressed without inflating the total.
--
-- 3. **A payment recorded against the wrong channel can be reclassified** through the
--    existing correction workflow (Milestone B): a third target kind, `sale_payment`,
--    carrying the channel the money is moved TO. The original payment row is never
--    written; at most one approved correction per payment, enforced here exactly as
--    for payouts and settlements (0040).
--
-- 4. **Closing authority is the Owner and at most two delegates** (0076). The
--    `administrator` and retired `branch_manager` roles still held `closing.perform`
--    by the role matrix; no user holds either role (read on live 2026-09-24). Revoked.
--
-- Additive except the NULL-ability; no row is rewritten.

-- ── 1. counted cash may be "not verified" ─────────────────────────────────
ALTER TABLE `daily_closings`
  MODIFY COLUMN `counted_cash` DECIMAL(14,2) NULL,
  MODIFY COLUMN `difference`   DECIMAL(14,2) NULL;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'daily_closings' AND constraint_name = 'ck_closings_counted_pair') = 0,
  'ALTER TABLE `daily_closings` ADD CONSTRAINT `ck_closings_counted_pair` CHECK ((`counted_cash` IS NULL) = (`difference` IS NULL))',
  'SELECT 1');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. money moved out of a channel by a correction ─────────────────────────
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'closing_channel_counts' AND column_name = 'corrections_out') = 0,
  'ALTER TABLE `closing_channel_counts` ADD COLUMN `corrections_out` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `corrections_in`',
  'SELECT 1');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. the sale_payment correction target ──────────────────────────────────
ALTER TABLE `financial_corrections` DROP CHECK `ck_fc_one_target`;

ALTER TABLE `financial_corrections`
  MODIFY COLUMN `target_kind` ENUM('refund_payout', 'supplier_settlement', 'sale_payment') NOT NULL;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'financial_corrections' AND column_name = 'target_payment_id') = 0,
  "ALTER TABLE `financial_corrections`
     ADD COLUMN `target_payment_id` BINARY(16) NULL AFTER `target_supplier_settlement_id`,
     ADD COLUMN `to_method` ENUM('cash', 'account') NULL AFTER `account_label_snapshot`,
     ADD COLUMN `to_receiving_account_id` BINARY(16) NULL AFTER `to_method`,
     ADD COLUMN `to_account_label_snapshot` VARCHAR(80) NULL AFTER `to_receiving_account_id`,
     ADD COLUMN `active_target_payment_id` BINARY(16)
       GENERATED ALWAYS AS (IF(`status` = 'approved', `target_payment_id`, NULL)) VIRTUAL,
     ADD UNIQUE KEY `uq_fc_active_payment` (`active_target_payment_id`),
     ADD KEY `ix_fc_target_payment` (`target_payment_id`),
     ADD CONSTRAINT `fk_fc_payment` FOREIGN KEY (`target_payment_id`) REFERENCES `payments` (`id`),
     ADD CONSTRAINT `fk_fc_to_account` FOREIGN KEY (`to_receiving_account_id`) REFERENCES `receiving_accounts` (`id`)",
  'SELECT 1');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Exactly one target, matching the declared kind — now three kinds.
ALTER TABLE `financial_corrections` ADD CONSTRAINT `ck_fc_one_target` CHECK (
  (`target_kind` = 'refund_payout'
     AND `target_refund_payout_id` IS NOT NULL
     AND `target_supplier_settlement_id` IS NULL AND `target_payment_id` IS NULL)
  OR
  (`target_kind` = 'supplier_settlement'
     AND `target_supplier_settlement_id` IS NOT NULL
     AND `target_refund_payout_id` IS NULL AND `target_payment_id` IS NULL)
  OR
  (`target_kind` = 'sale_payment'
     AND `target_payment_id` IS NOT NULL
     AND `target_refund_payout_id` IS NULL AND `target_supplier_settlement_id` IS NULL)
);

-- A reclassification names where the money goes; nothing else carries a destination.
-- Cash never names an account, and an account always does.
ALTER TABLE `financial_corrections` ADD CONSTRAINT `ck_fc_destination` CHECK (
  (`target_kind` <> 'sale_payment'
     AND `to_method` IS NULL AND `to_receiving_account_id` IS NULL AND `to_account_label_snapshot` IS NULL)
  OR
  (`target_kind` = 'sale_payment'
     AND `to_method` IS NOT NULL
     AND ((`to_method` = 'cash') = (`to_receiving_account_id` IS NULL)))
);

-- ── 4. closing authority: the Owner and the named delegates only ────────────
DELETE rp FROM `role_permissions` rp
JOIN `roles` r ON r.`id` = rp.`role_id`
JOIN `permissions` p ON p.`id` = rp.`permission_id`
WHERE r.`key` IN ('administrator', 'branch_manager')
  AND p.`key` = 'closing.perform';

-- Reverse (not executed; restore the 0078 backup for a real rollback): re-grant closing.perform to the
-- two roles above;
--   ALTER TABLE `financial_corrections` DROP CHECK `ck_fc_destination`, DROP CHECK `ck_fc_one_target`,
--     DROP FOREIGN KEY `fk_fc_payment`, DROP FOREIGN KEY `fk_fc_to_account`, DROP KEY `uq_fc_active_payment`,
--     DROP KEY `ix_fc_target_payment`, DROP COLUMN `active_target_payment_id`, DROP COLUMN `to_account_label_snapshot`,
--     DROP COLUMN `to_receiving_account_id`, DROP COLUMN `to_method`, DROP COLUMN `target_payment_id`;
--   (then re-add the two-kind ck_fc_one_target and ENUM from 0040)
--   ALTER TABLE `closing_channel_counts` DROP COLUMN `corrections_out`;
--   ALTER TABLE `daily_closings` DROP CHECK `ck_closings_counted_pair`;  -- NOT NULL needs every NULL resolved first
