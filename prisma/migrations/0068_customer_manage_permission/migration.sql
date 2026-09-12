-- 0068 — `customer.manage`, the authority to add a customer from the till (4a).
--
-- THE GAP THIS CLOSES
--
-- `sales.customer_id` has existed since the beginning, credit and partial sales
-- REQUIRE a customer, and the sale list already searches by customer name and
-- phone — but nothing in the API could find or create one. The field could only
-- ever be filled by something other than this application.
--
-- FINDING a customer is deliberately NOT gated on this key. It is part of
-- selling and is guarded by `sale.create`: a cashier who may take a credit sale
-- must be able to find the person to attribute it to, and gating the lookup
-- would gate the sale itself. This key is only the authority to CREATE one, so
-- a shop that wants its customer list curated can withhold it and still sell.
--
-- SCOPE (deliberate): `customer.manage` is NOT added to
-- `rbac/permission-scope.ts`'s COMPANY_PERMISSIONS, so it stays **branch-scoped**
-- under the Stage 2 fail-closed rule — it resolves only when the caller presents
-- a valid `X-Branch-Id` they are actually assigned to. Customers are a company
-- record, but the ACT of adding one is attributed to the branch it happened in,
-- and no authority is ever unioned across branches.
--
-- WHY A MIGRATION AND NOT ONLY THE SEED
--
-- `prisma migrate deploy` never runs `prisma db seed`, so a permission that
-- exists only in the seed is absent on a real deploy — the D2.1 lesson repeated
-- by 0022 and 0026. The TypeScript catalogue keeps its upsert as a second layer,
-- and a drift test fails the build if the two disagree.
--
-- IDEMPOTENCE
--
-- Every statement is guarded by NOT EXISTS on the STABLE KEY, never on an id
-- (ids are generated per environment). Re-running this migration, or running it
-- after the seed, changes nothing.

-- 1. The catalogue row.
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'customer.manage', 'Add a customer'
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM `permissions` p WHERE p.`key` = 'customer.manage'
);

-- 2. Owner holds it by role.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'customer.manage'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- 3. Store Manager holds it too — adding a customer is part of running a shop.
--    Store Employee is deliberately excluded: they may find a customer and
--    attribute a sale to one, which `sale.create` already allows.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'customer.manage'
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- 4. Administrator holds it as well: it is not money-sensitive, and the
--    technical/setup role holds everything except cost, below-cost override and
--    price editing (see ADMIN_KEYS in rbac/role-permissions.ts).
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'customer.manage'
WHERE r.`key` = 'administrator'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
