-- 0022 — Make the `price.edit` permission deployment-safe (F1 Stage 2).
--
-- THE GAP THIS CLOSES
--
-- 0021 created the `user_branch_permissions` table, but the `price.edit`
-- permission ROW itself is reference data, and reference data lives in the
-- seed. `prisma migrate deploy` does not run `prisma db seed`. A production
-- deploy would therefore have applied 0021 successfully and left the catalogue
-- without `price.edit` at all: the delegation table would exist with nothing
-- delegatable, Owners would silently lose an authority the code believes they
-- have, and every grant attempt would fail on a missing permission row.
--
-- This is the same hole D2.1 corrected for the store roles (0017/0018), which
-- is why the fix takes the same shape: the seed keeps its upsert as a second
-- safety layer, but applying migrations is now sufficient on its own.
--
-- WHY A NEW MIGRATION RATHER THAN EDITING 0021
--
-- 0021 is already applied here and recorded in `_prisma_migrations`. Editing an
-- applied migration changes its checksum and breaks every database that already
-- ran it. Corrections move forward.
--
-- IDEMPOTENCE
--
-- Both statements are guarded by NOT EXISTS on the STABLE KEY, never on an id.
-- Permission ids are generated per environment, so the development database
-- (where `price.edit` was inserted by hand before this migration existed)
-- already holds a different id than a fresh deploy would generate. Matching on
-- the key means this migration is correct in both, and re-running it — or
-- running it after the seed — changes nothing.
--
-- SCOPE
--
-- Owner only. `price.edit` is deliberately NOT granted to store_manager (it is
-- delegated per branch, per assignment, by an Owner — see 0021 and
-- rbac/permission-scope.ts), NOT to store_employee, and NOT to administrator,
-- which is a technical/setup role and holds no money-sensitive permission.

-- 1. The catalogue row. Guarded on the key, so an environment that already has
--    it (with any id) is left exactly as it is.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'price.edit', 'Edit item prices'
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM `permissions` p WHERE p.`key` = 'price.edit'
);

-- 2. Grant it to every company's Owner role, by stable key on both sides.
--    `company_id` is carried from the role row, so the tenant relationship is
--    preserved exactly as the seed would write it.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'price.edit'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- No statement grants `price.edit` to store_manager, store_employee or
-- administrator. A drift test asserts that, so the omission cannot be
-- "helpfully" corrected by someone later.
