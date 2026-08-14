-- ===========================================================================
-- 0035_sale_return_policy_and_view_permissions  (Phase I1)
--
-- Two independent things a return workflow cannot exist without:
--
--   1. Every sale carries its OWN return policy, snapshotted when it completes.
--   2. Reading sales is a permission, and changing the policy at sale time is
--      a separate, narrower one.
--
-- ---------------------------------------------------------------------------
-- WHY THE POLICY IS SNAPSHOTTED, NOT LOOKED UP
-- ---------------------------------------------------------------------------
-- `company_settings.return_window_hours` is a CURRENT setting. If eligibility
-- were computed from it, an Owner shortening the window tomorrow would
-- retroactively cancel return rights that were promised to customers who
-- already bought — and lengthening it would silently grant rights nobody
-- offered. The customer's rights are fixed at the moment of sale, so the sale
-- must carry them.
--
--   return_window_hours   what was promised, in hours. 0 = no returns.
--   return_deadline_at    sale_at + window, computed by the SERVER in UTC.
--                         NULL when the window is 0 — "no deadline" and
--                         "deadline already passed" are different facts and
--                         must not share a representation.
--
-- Both are written once and never updated.
--
-- ---------------------------------------------------------------------------
-- WHY EXISTING SALES GET 0 / NULL
-- ---------------------------------------------------------------------------
-- Applying today's setting retroactively would invent a promise nobody made.
-- Audited before writing this migration:
--
--   * `company_settings.return_window_hours` is 0 — the shop is configured to
--     accept no returns at all.
--   * The newest of the 7 existing sales is 263 hours old.
--
-- So no existing sale is inside any previously promised return period, and
-- 0/NULL states the literal truth rather than a convenient default. A return
-- against one of these later needs an explicit Owner exception, which is
-- exactly the right amount of friction.
--
-- ANY OTHER ENVIRONMENT MUST RERUN THAT AUDIT before deploying: if a shop has
-- a positive window and recent sales, those customers were genuinely promised
-- a return period, and 0 would silently take it away.
--
-- ---------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------
--   sale.view               browse and open sale history for the active branch.
--                           Deliberately NOT `report.view`: seeing what was
--                           sold is not seeing profit dashboards, and cost and
--                           margin stay gated by `cost.view` independently.
--   return.policy.override  change the return policy AT SALE TIME. Manager and
--                           Owner only. Post-sale override of an EXPIRED
--                           deadline is a different, Owner-only authority and
--                           is not created here (I2).
--
-- Both are branch-scoped: neither is in `COMPANY_PERMISSIONS`, and anything
-- absent from that allowlist is branch-scoped and fail-closed.
--
-- `migrate deploy` never runs the seed, so the grants live here — the D2.1
-- lesson. Every statement is guarded, so a rerun changes nothing.
--
-- ---------------------------------------------------------------------------
-- REVERSE SQL (executed against a restored copy, not merely written down)
--
-- Order matters: MySQL refuses to drop a column a CHECK still references, so
-- the constraints and the index come off first. The first draft of this block
-- dropped the columns directly and failed with error 3959 — which is exactly
-- why reverse SQL has to be run rather than reasoned about.
--
--   DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id`
--     WHERE p.`key` IN ('sale.view','return.policy.override');
--   DELETE FROM `permissions` WHERE `key` IN ('sale.view','return.policy.override');
--   ALTER TABLE `sales` DROP CHECK `sales_return_deadline_consistency_chk`;
--   ALTER TABLE `sales` DROP CHECK `sales_return_window_hours_chk`;
--   ALTER TABLE `sales` DROP FOREIGN KEY `sales_return_policy_overridden_by_fkey`;
--   DROP INDEX `sales_return_deadline_idx` ON `sales`;
--   ALTER TABLE `sales`
--     DROP COLUMN `return_policy_override_reason`,
--     DROP COLUMN `return_policy_overridden_by`,
--     DROP COLUMN `return_deadline_at`,
--     DROP COLUMN `return_window_hours`;
--
-- Verified afterwards: 0 return* columns, 0 permissions, sales 7 / 10 051.00,
-- units checksum 2a1dc9bf284afde32b402ad108d38a76 unchanged.
-- ===========================================================================

-- 1. The per-sale policy snapshot -------------------------------------------

ALTER TABLE `sales`
  ADD COLUMN `return_window_hours` INT NOT NULL DEFAULT 0 AFTER `is_reversed`,
  ADD COLUMN `return_deadline_at` DATETIME(6) NULL AFTER `return_window_hours`,
  ADD COLUMN `return_policy_overridden_by` BINARY(16) NULL AFTER `return_deadline_at`,
  ADD COLUMN `return_policy_override_reason` VARCHAR(255) NULL AFTER `return_policy_overridden_by`;

-- Finding an expiring sale must not scan the table.
CREATE INDEX `sales_return_deadline_idx` ON `sales` (`company_id`, `return_deadline_at`);

ALTER TABLE `sales`
  ADD CONSTRAINT `sales_return_policy_overridden_by_fkey`
  FOREIGN KEY (`return_policy_overridden_by`) REFERENCES `users` (`id`);

-- A window cannot be negative, and a year is already an extreme promise.
ALTER TABLE `sales`
  ADD CONSTRAINT `sales_return_window_hours_chk`
  CHECK (`return_window_hours` >= 0 AND `return_window_hours` <= 8760);

-- "No returns" and "has a deadline" must agree with each other, so an
-- inconsistent pair cannot be written by any future code path.
ALTER TABLE `sales`
  ADD CONSTRAINT `sales_return_deadline_consistency_chk`
  CHECK (
    (`return_window_hours` = 0 AND `return_deadline_at` IS NULL)
    OR (`return_window_hours` > 0 AND `return_deadline_at` IS NOT NULL)
  );

-- Existing rows already default to 0/NULL, which satisfies both CHECKs. The
-- statement is written out anyway so the intent is explicit in the migration
-- rather than implied by a column default, and so a rerun is a visible no-op.
UPDATE `sales`
   SET `return_window_hours` = 0,
       `return_deadline_at` = NULL
 WHERE `return_deadline_at` IS NOT NULL
    OR `return_window_hours` <> 0;

-- 2. Permissions -------------------------------------------------------------

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'sale.view', 'View sales history'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'sale.view');

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.policy.override', 'Change the return policy at sale time'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'return.policy.override');

-- sale.view — every store role. Browsing what the branch sold is ordinary work.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'sale.view'
WHERE r.`key` IN ('owner', 'store_manager', 'store_employee')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- return.policy.override — Manager and Owner only. An employee may see the
-- policy the sale will carry; changing it is authority, not operation.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'return.policy.override'
WHERE r.`key` IN ('owner', 'store_manager')
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
