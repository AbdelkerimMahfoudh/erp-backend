-- 0034 — quantity-tracked transfer lines (H1.4-CP2)
--
-- Additive apart from one deliberate relaxation (`stock_items.price` becomes
-- nullable, see below). No data is rewritten and no existing row is touched.
--
-- Pre-migration legacy audit (H1.4-CP1, run against the live database):
--   stock_transfers = 0, transfer_items = 0,
--   rows with BOTH unit_id and product_id = 0,
--   rows with NEITHER = 0,
--   serialized rows with quantity <> 1 = 0,
--   rows with quantity < 1 = 0.
-- Every CHECK below is therefore vacuously satisfied here. A database with real
-- transfer history MUST have that audit re-run before this migration is applied:
-- an inconsistent legacy row would abort the ALTER, and inventing a mapping for
-- it is not something a migration may decide.

-- 1. The shipment cost snapshot -----------------------------------------------
-- Cost of the goods AT THE MOMENT THEY LEFT, on quantity lines only. NULL until
-- shipment. This is the value that stays on the books while stock is in transit,
-- and the value the destination averages in on receipt.
ALTER TABLE `transfer_items`
  ADD COLUMN `shipped_unit_cost` DECIMAL(14,2) NULL AFTER `quantity`;

-- 2. Foreign keys that do not rewrite the row behind the CHECK's back ----------
-- Both optional relations were created with Prisma's default for an optional
-- FK, ON DELETE SET NULL. That is wrong here for two independent reasons.
--
-- The first was OBSERVED, not predicted: deleting a unit silently NULLed
-- `unit_id` and left a transfer line pointing at nothing — a movement record
-- that has forgotten what it moved, and under the CHECK below it would be a row
-- the database itself considers invalid.
--
-- The second is why this block has to exist at all: MySQL (error 3823) refuses a
-- CHECK constraint on any column whose foreign key carries a referential action.
-- With SET NULL in place, `transfer_items_line_kind_chk` cannot be created.
--
-- RESTRICT is also the honest rule for financial history: a product or unit that
-- a transfer moved may not be erased out from under it. Products are soft
-- deleted (`deleted_at`) and units are not deleted in production, so no
-- legitimate workflow is blocked.
ALTER TABLE `transfer_items` DROP FOREIGN KEY `transfer_items_unit_id_fkey`;
ALTER TABLE `transfer_items` DROP FOREIGN KEY `transfer_items_product_id_fkey`;
ALTER TABLE `transfer_items`
  ADD CONSTRAINT `transfer_items_unit_id_fkey`
  FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `transfer_items`
  ADD CONSTRAINT `transfer_items_product_id_fkey`
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 3. A line is exactly one kind ------------------------------------------------
-- Serialized: a unit, no product, exactly one of it.
-- Quantity:   a product, no unit, at least one of it.
-- "Both" and "neither" become states the database refuses. The existing
-- `transfer_items_quantity_pos_chk (quantity > 0)` stays and is complementary.
ALTER TABLE `transfer_items`
  ADD CONSTRAINT `transfer_items_line_kind_chk` CHECK (
    (`unit_id` IS NOT NULL AND `product_id` IS NULL     AND `quantity` = 1)
    OR
    (`unit_id` IS NULL     AND `product_id` IS NOT NULL AND `quantity` >= 1)
  );

-- 4. A snapshot belongs only to a quantity line, and is never negative ---------
-- A serialized line carries its cost on the unit itself, so a snapshot there
-- would be a second, divergent copy of the same number.
ALTER TABLE `transfer_items`
  ADD CONSTRAINT `transfer_items_snapshot_kind_chk` CHECK (
    `shipped_unit_cost` IS NULL
    OR (`product_id` IS NOT NULL AND `shipped_unit_cost` >= 0)
  );

-- 5. One line per product per transfer ----------------------------------------
-- MySQL permits repeated NULLs under a UNIQUE index, so every serialized row
-- (product_id IS NULL) slips past this while two lines for the same accessory
-- are rejected by the database. That matters because an application-level
-- duplicate check cannot survive two concurrent inserts.
CREATE UNIQUE INDEX `transfer_items_transfer_id_product_id_key`
  ON `transfer_items`(`transfer_id`, `product_id`);

-- 6. An unpriced quantity row must be representable ----------------------------
-- Selling price is branch-private and must never travel with the goods, so a
-- transfer can legitimately deliver stock into a branch that has never priced
-- it. With a NOT NULL column the only options were to invent a price or refuse
-- the goods; both are worse than recording the truth. NULL means unpriced and
-- falls through the existing ladder to `products.default_price`, then to the
-- `unpriced` state the resolver already models. It is never read as zero.
ALTER TABLE `stock_items`
  MODIFY `price` DECIMAL(14,2) NULL;

-- Reverse SQL (tested — see the H1.4-CP2 record in docs/25):
--
--   ALTER TABLE `transfer_items` DROP CHECK `transfer_items_snapshot_kind_chk`;
--   ALTER TABLE `transfer_items` DROP CHECK `transfer_items_line_kind_chk`;
--   DROP INDEX `transfer_items_transfer_id_product_id_key` ON `transfer_items`;
--   DELETE FROM `transfer_items` WHERE `product_id` IS NOT NULL;   -- see note
--   ALTER TABLE `transfer_items` DROP COLUMN `shipped_unit_cost`;
--   ALTER TABLE `transfer_items` DROP FOREIGN KEY `transfer_items_unit_id_fkey`;
--   ALTER TABLE `transfer_items` DROP FOREIGN KEY `transfer_items_product_id_fkey`;
--   ALTER TABLE `transfer_items` ADD CONSTRAINT `transfer_items_unit_id_fkey`
--     FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
--   ALTER TABLE `transfer_items` ADD CONSTRAINT `transfer_items_product_id_fkey`
--     FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
--   UPDATE `stock_items` SET `price` = 0 WHERE `price` IS NULL;    -- see note
--   ALTER TABLE `stock_items` MODIFY `price` DECIMAL(14,2) NOT NULL;
--
-- Both marked lines are DESTRUCTIVE and are why this reversal is a deliberate
-- operation and not a routine one:
--   * quantity transfer lines cannot exist in the 0033 schema at all, so
--     reversing means deciding what happens to them. Deleting them abandons the
--     movement they describe; the reservations they hold must be released
--     first, or `stock_items.reserved_quantity` is left overstated.
--   * restoring NOT NULL needs a value for every unpriced row. `0` is written
--     only because the column cannot hold the truth once reversed — which is
--     precisely the limitation this migration removes.
