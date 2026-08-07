-- 0027 Pricing foundation (G2A-CP2). ADDITIVE ONLY.
-- Adds branch_variant_prices, unit_price_overrides and append-only
-- price_change_events. products.default_price and stock_items.price are NOT
-- touched: default_price stays the company-wide fallback and stock_items.price
-- stays the authoritative branch price for quantity stock. Completed sales keep
-- their immutable sale_items.price snapshots.
-- Serialized ladder: unit_price_overrides > branch_variant_prices >
-- products.default_price > unpriced.
-- unit_price_overrides.branch_id is the branch whose AUTHORITY set the price,
-- not necessarily where the unit is now. CP3 honours an override only while
-- that branch still equals the unit branch, and a transfer must retire the row
-- and write a price_change_events row with initiator = system. CP2 only makes
-- this possible; it implements no transfer behaviour.
-- No backfill: an absent row means fall back.
-- Rationale in full: docs/21_PRODUCT_DECISIONS.md (G2A pricing).

-- CreateTable
CREATE TABLE `branch_variant_prices` (
    `id` BINARY(16) NOT NULL,
    `company_id` BINARY(16) NOT NULL,
    `branch_id` BINARY(16) NOT NULL,
    `product_id` BINARY(16) NOT NULL,
    `price` DECIMAL(14, 2) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `set_by` BINARY(16) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `branch_variant_prices_company_id_idx`(`company_id`),
    INDEX `branch_variant_prices_branch_id_idx`(`branch_id`),
    UNIQUE INDEX `branch_variant_prices_product_id_branch_id_key`(`product_id`, `branch_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `unit_price_overrides` (
    `id` BINARY(16) NOT NULL,
    `company_id` BINARY(16) NOT NULL,
    `branch_id` BINARY(16) NOT NULL,
    `unit_id` BINARY(16) NOT NULL,
    `price` DECIMAL(14, 2) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `set_by` BINARY(16) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `unit_price_overrides_company_id_idx`(`company_id`),
    INDEX `unit_price_overrides_branch_id_idx`(`branch_id`),
    UNIQUE INDEX `unit_price_overrides_unit_id_key`(`unit_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `price_change_events` (
    `id` BINARY(16) NOT NULL,
    `company_id` BINARY(16) NOT NULL,
    `branch_id` BINARY(16) NOT NULL,
    `product_id` BINARY(16) NOT NULL,
    `unit_id` BINARY(16) NULL,
    `scope` VARCHAR(20) NOT NULL,
    `initiator` VARCHAR(20) NOT NULL,
    `previous_price` DECIMAL(14, 2) NULL,
    `new_price` DECIMAL(14, 2) NULL,
    `reason` TEXT NULL,
    `actor_id` BINARY(16) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `price_change_events_company_id_created_at_idx`(`company_id`, `created_at`),
    INDEX `price_change_events_product_id_idx`(`product_id`),
    INDEX `price_change_events_unit_id_idx`(`unit_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `branch_variant_prices` ADD CONSTRAINT `branch_variant_prices_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `branch_variant_prices` ADD CONSTRAINT `branch_variant_prices_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `branch_variant_prices` ADD CONSTRAINT `branch_variant_prices_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `branch_variant_prices` ADD CONSTRAINT `branch_variant_prices_set_by_fkey` FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `unit_price_overrides` ADD CONSTRAINT `unit_price_overrides_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `unit_price_overrides` ADD CONSTRAINT `unit_price_overrides_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `unit_price_overrides` ADD CONSTRAINT `unit_price_overrides_unit_id_fkey` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `unit_price_overrides` ADD CONSTRAINT `unit_price_overrides_set_by_fkey` FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `price_change_events` ADD CONSTRAINT `price_change_events_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `price_change_events` ADD CONSTRAINT `price_change_events_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `price_change_events` ADD CONSTRAINT `price_change_events_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `price_change_events` ADD CONSTRAINT `price_change_events_unit_id_fkey` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `price_change_events` ADD CONSTRAINT `price_change_events_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


-- Monetary sanity. Same CHECK style as stock_items.quantity in 0002.
ALTER TABLE `branch_variant_prices` ADD CONSTRAINT `chk_bvp_price_nonneg` CHECK (`price` >= 0);
ALTER TABLE `unit_price_overrides` ADD CONSTRAINT `chk_upo_price_nonneg` CHECK (`price` >= 0);
ALTER TABLE `price_change_events` ADD CONSTRAINT `chk_pce_prev_nonneg` CHECK (`previous_price` IS NULL OR `previous_price` >= 0);
ALTER TABLE `price_change_events` ADD CONSTRAINT `chk_pce_new_nonneg` CHECK (`new_price` IS NULL OR `new_price` >= 0);

-- Append-only price history, enforced by the database like audit_logs.
-- USER() is evaluated at run time, so this blocks the application account
-- whatever the trigger definer is; a DBA can still archive by range.
CREATE TRIGGER `price_change_events_block_update` BEFORE UPDATE ON `price_change_events`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'price_change_events is append-only for the application user';
  END IF;
END;

CREATE TRIGGER `price_change_events_block_delete` BEFORE DELETE ON `price_change_events`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'price_change_events is append-only for the application user';
  END IF;
END;
