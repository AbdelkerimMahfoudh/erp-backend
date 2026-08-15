-- 0039 — supplier settlement: paying a supplier, reported then confirmed (J1)
--
-- Purely additive. Two new tables and two new permissions. No existing table is
-- altered, no row is rewritten, and `suppliers.balance` keeps its current
-- meaning and value — J1 stops *deciding* from it, it does not change it.
--
-- Pre-migration legacy audit (J0, run against the live database):
--   suppliers = 3, purchases = 9 (all `unpaid`), supplier_payments = 0,
--   and every stored `suppliers.balance` equals SUM(total - amount_paid)
--   exactly, so nothing needs reconciling before this applies.
-- A database with real purchase history MUST have that audit re-run first.

-- 1. The settlement --------------------------------------------------------
-- Reported by whoever handed the money over; confirmed by a manager or owner.
-- Only a confirmed row moves cash, settles liability or reaches reconciliation.
CREATE TABLE `supplier_settlements` (
  `id`                      BINARY(16)     NOT NULL,
  `company_id`              BINARY(16)     NOT NULL,
  -- The debt is company-wide; the till that paid it is not.
  `branch_id`               BINARY(16)     NOT NULL,
  `supplier_id`             BINARY(16)     NOT NULL,
  `status`                  ENUM('reported','confirmed') NOT NULL DEFAULT 'reported',
  `amount`                  DECIMAL(14,2)  NOT NULL,
  `method`                  ENUM('cash','account') NOT NULL,
  `receiving_account_id`    BINARY(16)     NULL,
  -- Frozen at report time. A later rename must not retitle a movement that
  -- has already happened.
  `account_label_snapshot`  VARCHAR(80)    NULL,
  `transaction_reference`   VARCHAR(120)   NULL,
  `note`                    VARCHAR(255)   NULL,
  `version`                 INT            NOT NULL DEFAULT 0,
  -- Mandatory: an offline retry must not record two payments.
  `client_uuid`             BINARY(16)     NOT NULL,
  `client_request_hash`     CHAR(64)       NOT NULL,
  `reported_by`             BINARY(16)     NULL,
  `reported_at`             DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `confirmed_by`            BINARY(16)     NULL,
  `confirmed_at`            DATETIME(6)    NULL,
  -- The business date the cash movement belongs to: the CONFIRMATION day,
  -- never the report day. Reconciliation reads this and nothing else.
  `confirmation_date`       DATE           NULL,
  `created_at`              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  -- Replay protection, per company.
  UNIQUE KEY `supplier_settlements_company_id_client_uuid_key` (`company_id`, `client_uuid`),
  KEY `supplier_settlements_company_supplier_status_idx` (`company_id`, `supplier_id`, `status`),
  KEY `supplier_settlements_company_branch_date_idx` (`company_id`, `branch_id`, `confirmation_date`),
  CONSTRAINT `supplier_settlements_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `supplier_settlements_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `supplier_settlements_supplier_id_fkey` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- RESTRICT on BOTH, not just delete: MySQL (error 3823) refuses a CHECK on
  -- any column whose foreign key carries a referential action, and the
  -- method/account CHECK below is the thing that makes "an account payment
  -- names its account" a database rule rather than a hope. An account id never
  -- changes anyway.
  CONSTRAINT `supplier_settlements_receiving_account_id_fkey` FOREIGN KEY (`receiving_account_id`) REFERENCES `receiving_accounts`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `supplier_settlements_reported_by_fkey` FOREIGN KEY (`reported_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `supplier_settlements_confirmed_by_fkey` FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Money is never negative, and a zero payment settles nothing.
  CONSTRAINT `supplier_settlements_amount_positive_chk` CHECK (`amount` > 0),
  -- An account payment names its account; a cash payment must not.
  CONSTRAINT `supplier_settlements_method_account_chk` CHECK (
    (`method` = 'account' AND `receiving_account_id` IS NOT NULL)
    OR (`method` = 'cash' AND `receiving_account_id` IS NULL)
  ),
  -- Confirmation is all-or-nothing: who, when, and which business day.
  CONSTRAINT `supplier_settlements_confirmed_shape_chk` CHECK (
    (`status` = 'reported'  AND `confirmed_at` IS NULL     AND `confirmation_date` IS NULL)
    OR (`status` = 'confirmed' AND `confirmed_at` IS NOT NULL AND `confirmation_date` IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. The allocation --------------------------------------------------------
-- Which purchases the money paid down, and by how much. This is the ONLY
-- thing that reduces a purchase's outstanding balance: purchase totals are
-- never rewritten to express payment.
CREATE TABLE `supplier_settlement_allocations` (
  `id`            BINARY(16)    NOT NULL,
  `company_id`    BINARY(16)    NOT NULL,
  `settlement_id` BINARY(16)    NOT NULL,
  `purchase_id`   BINARY(16)    NOT NULL,
  `amount`        DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (`id`),
  -- One line per purchase per settlement. Two lines for the same purchase
  -- would let a duplicate slip past an application-level check.
  UNIQUE KEY `supplier_settlement_allocations_settlement_purchase_key` (`settlement_id`, `purchase_id`),
  KEY `supplier_settlement_allocations_company_purchase_idx` (`company_id`, `purchase_id`),
  CONSTRAINT `supplier_settlement_allocations_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Cascade: an allocation has no meaning without its settlement, and a
  -- REPORTED settlement may still be withdrawn while it is only a claim.
  CONSTRAINT `supplier_settlement_allocations_settlement_id_fkey` FOREIGN KEY (`settlement_id`) REFERENCES `supplier_settlements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `supplier_settlement_allocations_purchase_id_fkey` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `supplier_settlement_allocations_amount_positive_chk` CHECK (`amount` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 3. Permissions -----------------------------------------------------------
-- Two keys, because handing money over and vouching that it happened are
-- different authorities — the same split I3 uses for refunds.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'supplier.payment.report', 'Report that a supplier was paid'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'supplier.payment.report');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'supplier.payment.confirm', 'Confirm a supplier payment was actually made'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'supplier.payment.confirm');

-- Report: Owner, Store Manager and Store Employee. The person at the counter
-- who hands the money over is the one who knows it happened.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'supplier.payment.report'
WHERE r.`key` IN ('owner', 'store_manager', 'store_employee')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Confirm: Owner and Store Manager only. An Employee must never be able to
-- vouch for their own payout.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'supplier.payment.confirm'
WHERE r.`key` IN ('owner', 'store_manager')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- 4. Reconciliation columns ------------------------------------------------
-- `daily_closings` already records refunds paid; supplier payments had no
-- equivalent, so a day's cash could not explain itself. Defaulted to 0, so
-- every existing closing keeps exactly the figures it was closed with.
ALTER TABLE `daily_closings`
  ADD COLUMN `supplier_paid_total` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `refunds_paid_cash`,
  ADD COLUMN `supplier_paid_cash`  DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `supplier_paid_total`;

-- Reverse SQL (tested — see the J1 record in docs/28):
--
--   ALTER TABLE `daily_closings` DROP COLUMN `supplier_paid_cash`, DROP COLUMN `supplier_paid_total`;
--   DROP TABLE `supplier_settlement_allocations`;
--   DROP TABLE `supplier_settlements`;
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` IN ('supplier.payment.report','supplier.payment.confirm');
--   DELETE FROM `permissions` WHERE `key` IN ('supplier.payment.report','supplier.payment.confirm');
--
-- Dropping the tables DESTROYS every recorded supplier payment, which is a
-- financial record. Reversing this migration is therefore a deliberate act
-- that needs a restore of the backup taken before it, not a routine rollback.
