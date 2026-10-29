-- D225 (2026-10-29): the illustration a shop's own category wears.
--
-- Additive and nullable: NULL is "none chosen", which the app draws as the built-in parent's picture or a
-- neutral generic one. Built-in categories keep NULL — the app maps them by their stable `key`. Nothing is
-- backfilled; no existing row changes meaning. A code rollback to a build that does not know the column
-- simply never reads it.
ALTER TABLE `product_categories` ADD COLUMN `icon` VARCHAR(32) NULL;
