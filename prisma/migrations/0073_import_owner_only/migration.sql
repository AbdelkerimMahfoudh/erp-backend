-- 0073 — Inventory import is the Owner's alone (first-release scope).
--
-- WHY
-- The first release keeps inventory import, reachable only from More and only
-- for the Owner. Hiding the menu row would leave the API open, and
-- `AccessService` resolves authority from `role_permissions` and nothing else,
-- so the grant itself has to go. Importing creates stock and its cost without a
-- purchase — a decision about the whole shop's opening inventory, not daily work.
--
-- Measured on live immediately before this migration was written, holders of
-- import.run: owner, store_manager, administrator, branch_manager,
-- warehouse_employee.
--
-- What changes: every non-owner role loses import.run. The Owner keeps it. No
-- other grant is touched and nothing is inserted. Idempotent: removing an absent
-- row is a no-op. No session needs revoking — permissions are resolved per
-- request, never stored in a token or session.
--
-- No audit row, consistent with 0018 and 0067: a migration has no actor. The
-- record lives in CURRENT_HANDOFF.md and SESSION_LOG.md.
--
-- Reverse: re-insert the pairs with the INSERT ... NOT EXISTS pattern of 0017,
-- only after a written product decision to let non-owners import again.

DELETE rp FROM `role_permissions` rp
JOIN `roles` r ON r.`id` = rp.`role_id`
JOIN `permissions` p ON p.`id` = rp.`permission_id`
WHERE r.`key` IN ('store_manager', 'store_employee', 'administrator', 'branch_manager', 'sales_employee', 'warehouse_employee')
  AND p.`key` = 'import.run';
