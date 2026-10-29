-- ===========================================================================
-- 0111 — bilingual names for businesses, stores and people (D225, the owner's
-- TestFlight feedback of 2026-10-29).
--
-- `name` stays what it always was and becomes the Latin-alphabet name, read by
-- the French and English interfaces. `name_ar` is the Arabic name, read by the
-- Arabic interface. NULL means "not given yet": every screen then shows `name`,
-- and the record is marked for completion. It is never blocked from work.
-- Nothing is backfilled. A name is not transliterated by a machine, and a
-- guessed Arabic spelling of a shop's name would be wrong on its receipts.
--
-- sales.*_name_snapshot: the business, the store and the seller as named when
--   the sale was confirmed, in both scripts. A later rename never rewrites an
--   old receipt. NULL on every sale before 0111: those receipts name the live
--   records, exactly as they always did.
--
-- seat_allocations.label_ar: the Arabic name of a store asked for and not yet
--   open (awaiting payment, or opening when a free trial ends), so the store
--   opens with both names. NULL on every request before 0111.
--
-- Additive and nullable: no existing value changes. A code rollback to a build
-- that does not know the columns never reads them. Reverse: drop the ten
-- columns (the Arabic names typed since are then lost, so take a dump first,
-- per docs/22).
-- ===========================================================================

ALTER TABLE `companies` ADD COLUMN `name_ar` VARCHAR(160) NULL;
ALTER TABLE `branches` ADD COLUMN `name_ar` VARCHAR(160) NULL;
ALTER TABLE `users` ADD COLUMN `name_ar` VARCHAR(160) NULL;

ALTER TABLE `sales`
  ADD COLUMN `business_name_snapshot` VARCHAR(160) NULL,
  ADD COLUMN `business_name_ar_snapshot` VARCHAR(160) NULL,
  ADD COLUMN `branch_name_snapshot` VARCHAR(160) NULL,
  ADD COLUMN `branch_name_ar_snapshot` VARCHAR(160) NULL,
  ADD COLUMN `seller_name_snapshot` VARCHAR(160) NULL,
  ADD COLUMN `seller_name_ar_snapshot` VARCHAR(160) NULL;

ALTER TABLE `seat_allocations` ADD COLUMN `label_ar` VARCHAR(160) NULL;
