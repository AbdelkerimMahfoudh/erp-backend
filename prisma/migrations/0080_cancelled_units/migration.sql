-- 0080: the units a cancelled sale gave back, on the day it was cancelled (docs/51 §16).
--
-- 0079 took a cancelled sale's revenue, cost and count off the day the cancellation
-- was approved, through `daily_rollups`' own columns, and gave units sold none: a
-- branch's units-sold goal still counted the cancelled items. Goals read only columns
-- the rollup writes (`goals-source.spec.ts`), so the units get the same treatment — a
-- column keyed on the correction day, never on the sale's, whose own day stays as it
-- was recorded and closed.
--
-- Additive, NOT NULL DEFAULT 0, re-runnable (guarded). The backfill sets the column for
-- every approved cancellation already on record, from the same lines the rollup reads.

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'daily_rollups' AND column_name = 'cancelled_qty') = 0,
  "ALTER TABLE `daily_rollups` ADD COLUMN `cancelled_qty` INT NOT NULL DEFAULT 0 AFTER `cancelled_count`",
  'DO 0');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

UPDATE `daily_rollups` dr
  JOIN (
    SELECT fc.branch_id, fc.correction_date, SUM(si.quantity) AS qty
      FROM `financial_corrections` fc
      JOIN `sale_items` si ON si.sale_id = fc.target_sale_id AND si.voided = 0
     WHERE fc.target_kind = 'sale' AND fc.status = 'approved'
     GROUP BY fc.branch_id, fc.correction_date
  ) c ON c.branch_id = dr.branch_id AND c.correction_date = dr.day
   SET dr.cancelled_qty = c.qty;
