-- D227: part of a counted line can be returned. Additive: existing rows keep their unit and a NULL quantity, and every
-- existing constraint stays, including one active claim and one reversal per sale line.
-- Reverse, only before any counted return exists: MODIFY unit_id back to NOT NULL and DROP returned_quantity on both tables.
ALTER TABLE `return_requests`
  MODIFY `unit_id` BINARY(16) NULL,
  ADD COLUMN `returned_quantity` INT NULL AFTER `unit_id`;
ALTER TABLE `return_reversals`
  MODIFY `unit_id` BINARY(16) NULL,
  ADD COLUMN `returned_quantity` INT NULL AFTER `unit_id`;
