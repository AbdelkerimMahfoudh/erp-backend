-- D227: what an approval set out to do, and the durable fact that its period was applied, so a stopped approval can be
-- read and finished without guessing. `period_applied_at` is written in the period's own transaction.
-- Additive. Reverse, only before any approval stopped part-way: DROP both columns.
ALTER TABLE `payment_proofs`
  ADD COLUMN `apply_request` JSON NULL AFTER `applied_at`,
  ADD COLUMN `period_applied_at` DATETIME(6) NULL AFTER `apply_request`;
