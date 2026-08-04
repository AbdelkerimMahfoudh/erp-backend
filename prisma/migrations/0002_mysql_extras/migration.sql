-- ===========================================================================
-- 0002_mysql_extras — MySQL-specific schema features Prisma cannot model:
--   1. Generated columns + UNIQUE for sold-once (M3) and company-wide settings
--   2. FULLTEXT index for product search (M6)
--   3. CHECK constraints (IMEI format, non-negative/positive qty, transfer, target)
--
-- (UUIDv7 is generated app-side; for raw SQL use native BIN_TO_UUID(id) /
--  UUID_TO_BIN('...', 0). No custom UUID function is required.)
--
-- DB users & grants are provisioned OUTSIDE migrations (prisma/sql/init/*.sql)
-- so migrations stay pure-schema and portable.
-- ===========================================================================

-- 1. Sold-once (M3): a unit may appear on at most ONE active (non-voided) sale
--    line. VIRTUAL generated column is NULL for voided/accessory lines (MySQL
--    allows duplicate NULLs), so a returned unit can be sold again.
ALTER TABLE `sale_items`
  ADD COLUMN `active_unit_id` BINARY(16)
    GENERATED ALWAYS AS (IF(`voided` = 0, `unit_id`, NULL)) VIRTUAL,
  ADD UNIQUE KEY `ux_saleitem_active_unit` (`active_unit_id`);

-- 1b. Company-wide settings uniqueness (branch_id NULL). NULLs are distinct in a
--     unique index, so map NULL → a zero sentinel via a generated column.
ALTER TABLE `settings`
  ADD COLUMN `branch_scope` BINARY(16)
    GENERATED ALWAYS AS (IFNULL(`branch_id`, 0x00000000000000000000000000000000)) VIRTUAL,
  ADD UNIQUE KEY `ux_settings_company_scope_key` (`company_id`,`branch_scope`,`key`);

-- 2. Product search (M6): FULLTEXT over brand/model/variant (InnoDB).
ALTER TABLE `products`
  ADD FULLTEXT INDEX `products_search_ft` (`brand`,`model`,`variant`);

-- 3. CHECK constraints (MySQL 8.0.16+ enforces these).
--    IMPORTANT MySQL limitation (error 3823): a column that is part of a foreign
--    key WITH a referential action (ON UPDATE/DELETE CASCADE or SET NULL) may NOT
--    be used in a CHECK constraint. So the following rules are enforced in the
--    APPLICATION layer instead (they involve FK columns):
--      • sale_items:     unit_id IS NOT NULL OR product_id IS NOT NULL
--      • transfer_items: unit_id IS NOT NULL OR product_id IS NOT NULL
--      • stock_transfers: from_branch_id <> to_branch_id
--    The CHECKs below only use non-FK columns and are safe.
ALTER TABLE `units`
  ADD CONSTRAINT `units_imei_primary_format_chk`   CHECK (`imei_primary` REGEXP '^[0-9]{15}$'),
  ADD CONSTRAINT `units_imei_secondary_format_chk` CHECK (`imei_secondary` IS NULL OR `imei_secondary` REGEXP '^[0-9]{15}$');

ALTER TABLE `stock_items`
  ADD CONSTRAINT `stock_items_quantity_nonneg_chk` CHECK (`quantity` >= 0);

ALTER TABLE `purchase_items`
  ADD CONSTRAINT `purchase_items_quantity_pos_chk` CHECK (`quantity` > 0);

ALTER TABLE `sale_items`
  ADD CONSTRAINT `sale_items_quantity_pos_chk` CHECK (`quantity` > 0);

ALTER TABLE `transfer_items`
  ADD CONSTRAINT `transfer_items_quantity_pos_chk` CHECK (`quantity` > 0);
