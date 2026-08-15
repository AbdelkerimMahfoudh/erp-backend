-- 0041 — letting a corrected refund be paid again (Milestone B)
--
-- Found by the live lifecycle test, not by the unit suite: after a correction
-- was approved, reporting a replacement payout answered 409
-- `refund_already_reported`. The brief requires a replacement to be possible,
-- and it was not, because `0038` made `return_request_id` UNIQUE — a return is
-- settled once or not at all.
--
-- That constraint was right when it was written and is still right in spirit:
-- there must never be TWO live payouts for one return. What changed is that a
-- corrected payout is no longer live.
--
-- ## What this does and does not touch
--
-- It adds ONE nullable back-reference, `corrected_by_id`, set when a correction
-- is approved. **No financial field is ever rewritten**: status, amount, method,
-- account label, who reported it, who confirmed it and when all stay exactly as
-- they were, and the receipt they produce is unchanged. The column records that
-- a correction superseded this payout — which the brief describes as marking it
-- "corrected through an append-only relation".
--
-- The unique key then moves onto a VIRTUAL column that holds the return id only
-- while the payout is live, the same partial-unique trick `0002` established.
-- One live payout per return stays a DATABASE guarantee rather than becoming an
-- application check, which is the whole reason for doing it this way.
--
-- Rerun-safe: every statement is guarded.

-- 1. The back-reference ------------------------------------------------------
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'refund_payouts'
      AND column_name = 'corrected_by_id') = 0,
  'ALTER TABLE `refund_payouts`
     ADD COLUMN `corrected_by_id` BINARY(16) NULL,
     ADD CONSTRAINT `fk_refund_payouts_corrected_by`
       FOREIGN KEY (`corrected_by_id`) REFERENCES `financial_corrections` (`id`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. Live-payout uniqueness ---------------------------------------------------
-- The generated column is the return id while the payout stands, and NULL once
-- a correction has superseded it. NULLs do not collide, so any number of
-- corrected payouts may exist for one return while at most one live payout can.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'refund_payouts'
      AND column_name = 'active_return_request_id') = 0,
  'ALTER TABLE `refund_payouts`
     ADD COLUMN `active_return_request_id` BINARY(16)
       GENERATED ALWAYS AS (IF(`corrected_by_id` IS NULL, `return_request_id`, NULL)) VIRTUAL,
     ADD UNIQUE KEY `ux_refund_payouts_active_request` (`active_return_request_id`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Same for the reversal, which carries the same one-settlement rule.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'refund_payouts'
      AND column_name = 'active_return_reversal_id') = 0,
  'ALTER TABLE `refund_payouts`
     ADD COLUMN `active_return_reversal_id` BINARY(16)
       GENERATED ALWAYS AS (IF(`corrected_by_id` IS NULL, `return_reversal_id`, NULL)) VIRTUAL,
     ADD UNIQUE KEY `ux_refund_payouts_active_reversal` (`active_return_reversal_id`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. Give the foreign keys their own index FIRST -----------------------------
-- The uniques about to be dropped are what the two foreign keys currently sit
-- on, and MySQL refuses to drop an index a constraint depends on (error 1553).
-- Adding the plain keys first is the difference between this migration applying
-- and failing halfway.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'refund_payouts'
      AND index_name = 'ix_refund_payouts_request') = 0,
  'ALTER TABLE `refund_payouts`
     ADD KEY `ix_refund_payouts_request` (`return_request_id`),
     ADD KEY `ix_refund_payouts_reversal` (`return_reversal_id`)',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 4. Retire the absolute uniques ---------------------------------------------
-- Dropped only AFTER both the partial replacements and the plain keys exist, so
-- the invariant is never unguarded for even one statement.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'refund_payouts'
      AND index_name = 'ux_refund_payouts_request') > 0,
  'ALTER TABLE `refund_payouts` DROP INDEX `ux_refund_payouts_request`',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'refund_payouts'
      AND index_name = 'ux_refund_payouts_reversal') > 0,
  'ALTER TABLE `refund_payouts` DROP INDEX `ux_refund_payouts_reversal`',
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Reverse SQL (not executed):
--   ALTER TABLE `refund_payouts`
--     DROP INDEX `ux_refund_payouts_active_request`,
--     DROP INDEX `ux_refund_payouts_active_reversal`,
--     DROP COLUMN `active_return_request_id`,
--     DROP COLUMN `active_return_reversal_id`,
--     DROP FOREIGN KEY `fk_refund_payouts_corrected_by`,
--     DROP COLUMN `corrected_by_id`,
--     DROP INDEX `ix_refund_payouts_request`,
--     DROP INDEX `ix_refund_payouts_reversal`,
--     ADD UNIQUE KEY `ux_refund_payouts_request` (`return_request_id`),
--     ADD UNIQUE KEY `ux_refund_payouts_reversal` (`return_reversal_id`);
