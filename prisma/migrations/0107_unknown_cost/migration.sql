-- ===========================================================================
-- 0107 — an unknown buying cost is NULL, never zero (D223, 2026-10-28).
--
-- The owner's decision: stock may be received without its buying cost, after
-- an explicit warning. That cost is UNKNOWN, not 0. Profit, margin and cost of
-- goods never treat it as zero: a line whose cost is unknown is counted and
-- disclosed, and the figure it would change is reported as incomplete (the
-- closing report's existing `cannot_calculate` / `missingCostLines` contract,
-- which until now detected "missing" as a cost of about zero).
--
-- Columns made nullable (no existing value changes):
--   units.cost, stock_items.cost, purchase_items.unit_cost,
--   stock_receipts.unit_cost, sale_items.cost, return_reversals.line_cost.
-- daily_rollups.missing_cost_lines: the day's sold lines of unknown cost;
--   gross profit covers the others.
-- stock_items.missing_cost_quantity: how many of the pieces on hand have no
--   known cost. 0 for every existing row, so every existing average is
--   unchanged; `cost` averages the pieces whose cost IS known.
-- cost.complete: entering a missing cost later (audited) — Owner and Store
--   Manager. The Administrator holds no money key by default (D11).
--
-- Reverse: only while every cost is known — re-add NOT NULL, drop the column,
-- DELETE the role_permissions rows and the key.
-- ===========================================================================

ALTER TABLE `units` MODIFY `cost` DECIMAL(14, 2) NULL;
ALTER TABLE `stock_items` MODIFY `cost` DECIMAL(14, 2) NULL;
ALTER TABLE `stock_items` ADD COLUMN `missing_cost_quantity` INT NOT NULL DEFAULT 0;
ALTER TABLE `purchase_items` MODIFY `unit_cost` DECIMAL(14, 2) NULL;
ALTER TABLE `stock_receipts` MODIFY `unit_cost` DECIMAL(14, 2) NULL;
ALTER TABLE `sale_items` MODIFY `cost` DECIMAL(14, 2) NULL;
ALTER TABLE `return_reversals` MODIFY `line_cost` DECIMAL(14, 2) NULL;
-- The day's sold lines of unknown cost, so the dashboard says its profit is incomplete.
ALTER TABLE `daily_rollups` ADD COLUMN `missing_cost_lines` INT NOT NULL DEFAULT 0;

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'cost.complete', 'Enter a buying cost that was not known when the stock was received'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'cost.complete');

-- Owner: everything.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('cost.complete')
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Store manager: completes the costs of the stock their branch received.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('cost.complete')
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
