-- ===========================================================================
-- 0029_stock_item_version
--
-- Adds optimistic-concurrency support to stock_items so the quantity branch
-- price can be edited safely.
--
-- Why a column and not the existing updated_at: MySQL stores DATETIME(6) with
-- microsecond precision, but a JavaScript Date carries only milliseconds. A
-- compare-and-swap on updated_at would therefore round-trip lossily and could
-- silently fail to match, or match an instant that is not the one the client
-- read. Two writes inside the same millisecond are also indistinguishable.
-- Faking the check in application memory was the other option and is worse: it
-- cannot see a concurrent writer at all.
--
-- Additive and backfill-safe: DEFAULT 0 gives every existing row a usable
-- starting version, so no data migration is needed and no existing write path
-- has to change until it opts in.
-- ===========================================================================

ALTER TABLE `stock_items` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 0;
