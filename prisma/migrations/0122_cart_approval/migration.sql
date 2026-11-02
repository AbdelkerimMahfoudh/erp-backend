-- D227: one approval for one multi-item sale. Additive; existing approvals keep NULL and behave as before.
-- Reverse, only before any cart approval exists: DROP the index and both columns.
ALTER TABLE `discount_approvals`
  ADD COLUMN `cart_group_id` BINARY(16) NULL,
  ADD COLUMN `cart_hash` CHAR(64) NULL,
  ADD INDEX `ix_discount_approvals_cart_group` (`company_id`, `cart_group_id`);
