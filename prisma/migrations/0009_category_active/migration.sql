-- ===========================================================================
-- 0009_category_active — categories are retired, never deleted (2C.5b)
--   Sales/inventory history references categories, so they must persist.
--   `is_active = 0` hides a category from pickers without breaking history.
-- ===========================================================================

ALTER TABLE `product_categories`
  ADD COLUMN `is_active` BOOLEAN NOT NULL DEFAULT 1 AFTER `attribute_schema`;
