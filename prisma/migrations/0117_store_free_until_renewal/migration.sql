-- ===========================================================================
-- 0117_store_free_until_renewal (D227, the owner's decision of 2026-11-01)
--
-- A no-payment grant may open a customer's store free until renewal. Billing
-- assesses every active store, so the next assessment in the period would have
-- charged it. This names the one billing period the store is free for; a renewal
-- opens another period, which does not match, and bills the store normally.
--
-- `free_until_at` is the end recorded when it was granted. Re-dating the running period does not move it; only the
-- explicit, audited extension does.
--
-- Additive: NULL on every existing row, which changes nothing.
-- Reverse: ALTER TABLE seat_allocations DROP COLUMN free_until_period_id, DROP COLUMN free_until_at.
-- ===========================================================================

ALTER TABLE `seat_allocations`
  ADD COLUMN `free_until_period_id` BINARY(16) NULL AFTER `replacement_period_id`,
  ADD COLUMN `free_until_at` DATETIME(6) NULL AFTER `free_until_period_id`;
