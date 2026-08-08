-- ===========================================================================
-- 0030_transfer_reservation_and_idempotency
--
-- Fixes two proven stock-integrity defects (H0 audit, verified live):
--   1. A requested phone stayed in_stock and could be SOLD underneath its
--      transfer. The clash only surfaced later, at ship.
--   2. Two open transfers could claim the same unit (second create returned
--      201), and a retried create made a second transfer.
--
-- Serialized reservation itself needs no schema: UnitStatus.reserved already
-- exists and is unused, and SalesPolicyService.assertSellable already requires
-- in_stock. This migration adds only what has no primitive today.
--
-- Additive. No earlier migration is modified. No data is invented: the
-- pre-migration audit found zero transfers, zero items and zero duplicate
-- active claims, so nothing historical is retroactively reserved.
-- ===========================================================================

-- Idempotency on transfer creation, mirroring Purchase (0014).
ALTER TABLE `stock_transfers` ADD COLUMN `client_uuid` BINARY(16) NULL;
ALTER TABLE `stock_transfers` ADD COLUMN `client_request_hash` CHAR(64) NULL;

-- Company-scoped: one company's request id can never suppress another's
-- transfer. MySQL allows many NULLs in a UNIQUE index, so rows created before
-- H1.1 are unaffected -- and two concurrent identical creates cannot both win.
CREATE UNIQUE INDEX `stock_transfers_company_id_client_uuid_key`
  ON `stock_transfers`(`company_id`, `client_uuid`);

-- Quantity availability. `quantity` remains the PHYSICAL total owned at the
-- branch and is deliberately never reduced to express unavailability: reserved
-- goods are still company property and must still count in inventory valuation.
ALTER TABLE `stock_items` ADD COLUMN `reserved_quantity` INTEGER NOT NULL DEFAULT 0;

-- Every existing row starts at zero by the DEFAULT; stated explicitly so the
-- intent survives a reader who does not trust defaults.
UPDATE `stock_items` SET `reserved_quantity` = 0 WHERE `reserved_quantity` IS NULL;

-- The two invariants, enforced by the database rather than by service
-- convention -- the same reasoning as the pricing CHECKs in 0027. A negative
-- reservation or a reservation exceeding physical stock is a corrupt row, and
-- application code cannot be the only thing standing between us and it.
ALTER TABLE `stock_items`
  ADD CONSTRAINT `chk_stock_reserved_nonneg` CHECK (`reserved_quantity` >= 0);
ALTER TABLE `stock_items`
  ADD CONSTRAINT `chk_stock_reserved_le_quantity` CHECK (`reserved_quantity` <= `quantity`);
