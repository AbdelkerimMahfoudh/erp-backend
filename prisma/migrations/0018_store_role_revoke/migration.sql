-- Revoke over-granted store-role permissions.
--
-- 0017 only INSERTS missing grants, which is right for a fresh deployment but
-- leaves a database that already ran the D2 seed holding permissions the audit
-- since removed. Grants must shrink as well as grow, or an audit finding never
-- reaches an existing installation.
--
-- Removed, with the behaviour that justified it:
--
--   store_employee / sale.return
--     `SalesService.returnUnit` voids the sale line, restocks the unit and
--     computes a REFUND. That COMPLETES a return. The approved rule is that an
--     employee only requests one and a Manager or Owner confirms. Needs a
--     future `return.request`.
--
--   store_employee / import.run
--     Reserved for activating imported inventory. The approved rule gives the
--     employee preparation only. Needs the future `import.prepare` /
--     `import.approve` split. (It currently guards no endpoint, so this is
--     pre-emptive rather than a live privilege.)
--
--   store_manager / discount.override
--     Despite the name this is not about discounts: `assertBelowCostAllowed`
--     uses it as the gate for SELLING BELOW COST. Granting it to every manager
--     hands out permanent below-cost authority by default. It becomes an
--     Owner-delegated per-user grant once overrides exist.
--
-- Scoped strictly to those role/permission pairs — no other grant is touched,
-- and legacy roles keep everything they had. Idempotent: deleting absent rows
-- is a no-op.
--
-- Reverse: re-insert the three pairs (see 0017 for the INSERT ... NOT EXISTS
-- pattern).

DELETE rp FROM `role_permissions` rp
JOIN `roles` r ON r.`id` = rp.`role_id`
JOIN `permissions` p ON p.`id` = rp.`permission_id`
WHERE r.`key` = 'store_employee'
  AND p.`key` IN ('sale.return', 'import.run');

DELETE rp FROM `role_permissions` rp
JOIN `roles` r ON r.`id` = rp.`role_id`
JOIN `permissions` p ON p.`id` = rp.`permission_id`
WHERE r.`key` = 'store_manager'
  AND p.`key` = 'discount.override';
