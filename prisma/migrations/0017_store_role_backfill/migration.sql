-- Make the store-role migration deployment-safe.
--
-- 0016 only added enum values. The assignment remap and the new permission
-- matrices lived in the SEED — and `prisma migrate deploy` does not run
-- `prisma db seed`. A production deploy would therefore have applied 0016 and
-- left every employee on a legacy role with NO permission rows for the new
-- ones: a silently broken system where applying migrations looks successful.
--
-- This migration makes applying migrations sufficient on its own. The seed
-- keeps its remap as a second safety layer, but is no longer the mechanism.
--
-- Every statement is idempotent: guarded by NOT EXISTS or by matching only
-- rows still in the old state. Re-running, or running after the seed already
-- remapped, changes nothing.
--
-- Assignment, user, company and branch ids are never touched — only `role_id`.

-- 1. Ensure both store roles exist for every company that already has roles.
INSERT INTO `roles` (`id`, `company_id`, `key`, `name`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), c.`id`, 'store_manager', 'Store Manager'
FROM `companies` c
WHERE NOT EXISTS (
  SELECT 1 FROM `roles` r WHERE r.`company_id` = c.`id` AND r.`key` = 'store_manager'
);

INSERT INTO `roles` (`id`, `company_id`, `key`, `name`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), c.`id`, 'store_employee', 'Store Employee'
FROM `companies` c
WHERE NOT EXISTS (
  SELECT 1 FROM `roles` r WHERE r.`company_id` = c.`id` AND r.`key` = 'store_employee'
);

-- 2. Grant each store role its permissions, by stable permission KEY.
--    Keys are the contract; ids differ per environment. A drift test keeps this
--    list aligned with prisma/seed-data/permissions.ts.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN (
  'sale.create', 'sale.return', 'cost.view', 'discount.apply',
  'unit.add', 'unit.transfer', 'import.run',
  'purchase.manage', 'supplier.manage', 'closing.perform', 'report.view'
)
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Store Employee deliberately excludes sale.return, import.run, report.view,
-- expense.manage and discount.override — see 0017 notes in docs/21. Those are
-- final-authority actions, not the operational work this role needs.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN (
  'sale.create', 'cost.view', 'discount.apply',
  'unit.add', 'unit.transfer', 'purchase.manage'
)
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- 3. Remap assignments still pointing at a legacy role. Matching only legacy
--    rows is what makes this a no-op on a second run.
UPDATE `user_branches` ub
JOIN `roles` old ON old.`id` = ub.`role_id`
JOIN `roles` new_role
  ON new_role.`company_id` = ub.`company_id` AND new_role.`key` = 'store_employee'
SET ub.`role_id` = new_role.`id`
WHERE old.`key` IN ('sales_employee', 'warehouse_employee');

UPDATE `user_branches` ub
JOIN `roles` old ON old.`id` = ub.`role_id`
JOIN `roles` new_role
  ON new_role.`company_id` = ub.`company_id` AND new_role.`key` = 'store_manager'
SET ub.`role_id` = new_role.`id`
WHERE old.`key` = 'branch_manager';

-- `owner` and `administrator` are intentionally untouched: Owner is unchanged,
-- and administrator is an internal SaaS role, not a store-facing one.
