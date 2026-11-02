-- D227: a counted line may be returned several times up to what is left, with a chosen disposition, and a counted line may
-- hold an approval. Devices keep their rules exactly: one active claim and one reversal per line, the same keys for the
-- same rows. The new unique indexes come first, because the foreign keys on sale_item_id need one at every moment.
-- Reverse, only before any repeated counted return or counted approval exists.
ALTER TABLE `return_requests`
  ADD COLUMN `active_device_claim` TINYINT GENERATED ALWAYS AS (IF(`status` = 'rejected' OR `returned_quantity` IS NOT NULL, NULL, 1)) VIRTUAL,
  ADD UNIQUE KEY `ux_return_requests_device_claim` (`sale_item_id`, `active_device_claim`);
ALTER TABLE `return_requests`
  DROP INDEX `ux_return_requests_active_claim`,
  DROP COLUMN `claim_key`,
  ADD COLUMN `disposition` VARCHAR(16) NULL;

ALTER TABLE `return_reversals`
  ADD COLUMN `device_reversal` TINYINT GENERATED ALWAYS AS (IF(`returned_quantity` IS NULL, 1, NULL)) VIRTUAL,
  ADD UNIQUE KEY `ux_return_reversals_device` (`sale_item_id`, `device_reversal`);
ALTER TABLE `return_reversals`
  DROP INDEX `ux_return_reversals_sale_item`,
  ADD COLUMN `disposition` VARCHAR(16) NULL;

ALTER TABLE `discount_approvals`
  MODIFY `unit_id` BINARY(16) NULL,
  ADD COLUMN `quantity` INT NULL,
  ADD COLUMN `item_label` VARCHAR(200) NULL;
