-- ===========================================================================
-- 0037_return_accounting_components  (Phase I2-CP4.1)
--
-- Corrects the accounting treatment of an approved return.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- `0036` shipped with `returns_cogs` fixed at 0 while a returned phone, held as
-- `faulty`, was excluded from every inventory figure. Those two together are an
-- immediate, full write-off of the asset at the moment of approval — and that
-- write-off was never approved.
--
-- A returned faulty phone is unsellable, but the shop still owns it. Whether it
-- is repaired, partially impaired or scrapped is the LATER inspection
-- milestone's decision, and approval must not anticipate it.
--
-- ---------------------------------------------------------------------------
-- THE CORRECTED TREATMENT
-- ---------------------------------------------------------------------------
-- At approval:
--   * reverse the original line's revenue        (gross refund)
--   * credit back the original line's COGS       (the immutable cost snapshot)
--   * reinstate that same cost as FAULTY/RETURN-HELD inventory value
--   * keep it out of sellable/available stock entirely
--   * record the withheld adjustments as their own revenue component
--
--   profit effect = − gross refund + adjustments + COGS credit
--
-- Which leaves cumulative profit across the sale AND its return equal to the
-- adjustment income alone:
--
--   sale:    + gross − cost
--   return:  − gross + adjustments + cost
--   -------------------------------------
--   total:   + adjustments
--
-- That is the honest position until an inspection says what the phone is worth.
--
-- ---------------------------------------------------------------------------
-- WHY MORE COLUMNS
-- ---------------------------------------------------------------------------
-- `0036` already carries `returns_revenue`, `returns_cogs`,
-- `returns_gross_profit` and `returns_count`, and those keep their names. What
-- is missing is the adjustment component: without it, "gross refund" and "what
-- the shop kept" cannot be reported separately, and a reader cannot check the
-- formula above. Everything stays a POSITIVE magnitude, added or subtracted
-- explicitly by each consumer.
--
--   daily_rollups.returns_adjustments            what was withheld
--   daily_closings.total_return_adjustments      the same, snapshotted
--   daily_closings.total_returns_cogs_credited   the cost credited back
--
-- Existing rows default to 0, which is the literal truth: no return had been
-- approved when they were written.
--
-- ---------------------------------------------------------------------------
-- REVERSE SQL (executed against a restored copy, not merely written down)
--
--   ALTER TABLE `daily_closings`
--     DROP COLUMN `total_returns_cogs_credited`,
--     DROP COLUMN `total_return_adjustments`;
--   ALTER TABLE `daily_rollups` DROP COLUMN `returns_adjustments`;
--
-- RERUN SAFETY: MySQL has no ADD COLUMN IF NOT EXISTS, so each ALTER is guarded
-- by an information_schema probe run through a prepared statement — the same
-- shape as 0036.
-- ===========================================================================

SET @needed := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'daily_rollups' AND column_name = 'returns_adjustments'
);
SET @ddl := IF(@needed, 'ALTER TABLE `daily_rollups` ADD COLUMN `returns_adjustments` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `returns_cogs`', 'DO 0');
PREPARE add_returns_adjustments FROM @ddl;
EXECUTE add_returns_adjustments;
DEALLOCATE PREPARE add_returns_adjustments;

SET @needed := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'daily_closings' AND column_name = 'total_return_adjustments'
);
SET @ddl := IF(@needed, 'ALTER TABLE `daily_closings` ADD COLUMN `total_return_adjustments` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `total_returns`, ADD COLUMN `total_returns_cogs_credited` DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER `total_return_adjustments`', 'DO 0');
PREPARE add_total_return_adjustments FROM @ddl;
EXECUTE add_total_return_adjustments;
DEALLOCATE PREPARE add_total_return_adjustments;
