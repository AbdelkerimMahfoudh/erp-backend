-- ===========================================================================
-- 0006_transfers_2c — human-readable transfer number + Ready-to-Ship state.
-- (Sub-phase 2C.) Per-branch prefix is stored in `settings` (no column needed).
-- ===========================================================================

ALTER TABLE `stock_transfers`
  ADD COLUMN `transfer_no` VARCHAR(24) NULL AFTER `to_branch_id`;

-- Add the 'ready_to_ship' state and make it the default for new transfers.
ALTER TABLE `stock_transfers`
  MODIFY COLUMN `status` ENUM('ready_to_ship','in_transit','received','cancelled')
  NOT NULL DEFAULT 'ready_to_ship';

-- Transfer numbers are unique per originating branch (NULLs allowed pre-assignment).
CREATE UNIQUE INDEX `stock_transfers_from_branch_id_transfer_no_key`
  ON `stock_transfers`(`from_branch_id`, `transfer_no`);
