-- 0026 — `catalog.manage`, the catalog-administration permission (Phase G1).
--
-- THE GAP THIS CLOSES
--
-- Product creation was guarded by `unit.add` — a permission every Store
-- Employee holds, because it is what lets them receive stock. So an employee
-- could create and shape catalog products, which is final catalog
-- administration, not day-to-day receiving. Category writes had the opposite
-- problem: they were guarded by `settings.manage`, which only the Owner holds,
-- so a Store Manager could not manage categories at all.
--
-- `catalog.manage` names the authority precisely: create/edit product and
-- category METADATA. It deliberately does NOT grant price editing, below-cost
-- authority, cost approval, supplier management, expenses, reports, or user and
-- settings management. In particular it must never imply `price.edit`, which
-- remains Owner-held and delegated per branch by an Owner (0021/0022).
--
-- SCOPE (deliberate): `catalog.manage` is NOT added to
-- `rbac/permission-scope.ts`'s COMPANY_PERMISSIONS, so it stays **branch-scoped**
-- under the Stage 2 fail-closed rule: it only resolves when the caller presents
-- a valid `X-Branch-Id` they are actually assigned to. The catalog itself stays
-- company-shared; requiring a branch context means a Manager's catalog action is
-- attributed to the branch they were acting in, and no authority is ever unioned
-- across branches.
--
-- WHY A MIGRATION AND NOT ONLY THE SEED
--
-- `prisma migrate deploy` never runs `prisma db seed`, so a permission that
-- exists only in the seed is absent on a real deploy — the D2.1 lesson repeated
-- by 0022. The TypeScript catalogue keeps its upsert as a second layer, and a
-- drift test fails the build if the two disagree.
--
-- IDEMPOTENCE
--
-- Every statement is guarded by NOT EXISTS on the STABLE KEY, never on an id
-- (ids are generated per environment). Re-running this migration, or running it
-- after the seed, changes nothing.

-- 1. The catalogue row.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'catalog.manage', 'Manage the product catalog'
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM `permissions` p WHERE p.`key` = 'catalog.manage'
);

-- 2. Owner holds it by role.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'catalog.manage'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- 3. Store Manager holds it by role too — catalog administration is part of
--    running a store. Store Employee is deliberately excluded: they may browse
--    the catalog, but final create/edit is a manager decision.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'catalog.manage'
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
