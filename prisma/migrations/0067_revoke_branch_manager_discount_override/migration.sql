-- 0067 — Take discount.override away from the retired branch_manager role.
--
-- A2 (as corrected by the owner) made `discount.override` APPROVAL AUTHORITY,
-- held by the Owner alone. Commit 6287b61 removed it from
-- ROLE_PERMISSIONS.branch_manager in code. No migration followed, so every
-- installation that had already been seeded kept the grant — and
-- `AccessService` resolves authority from `role_permissions` and nothing else.
--
-- The CP6 live run proved the consequence over real HTTP: a user assigned the
-- retired Branch Manager role approved a discount. The permission gate did not
-- notice, because it only checked that the catalogue KEYS exist.
--
-- Removal explicitly authorised by the owner on 2026-09-10.
--
-- Measured immediately before this migration was written, across EVERY tenant:
--   rows matching the statement below ........ 1 (Demo Phone Store)
--   roles holding discount.override .......... owner, branch_manager
--   users assigned branch_manager ............ 0
--   live sessions for those users ............ 0
--
-- No session needs revoking. The access token carries only user, company,
-- token type and session id; permissions are resolved from `role_permissions`
-- on every request and held in request-scoped CLS, never in a token, a session
-- row or a process cache. The next request of any existing session loses the
-- authority. The CP6 repair run proves that with a session issued before this
-- migration was applied, against an API process that was never restarted.
--
-- Scoped to exactly one role/permission pair, in the same shape as 0018. The
-- Owner keeps the key; no other grant is touched; nothing is inserted.
-- Idempotent: removing an absent row is a no-op.
--
-- No audit row is written, consistent with 0018: a migration has no actor to
-- attribute it to. The record lives in CURRENT_HANDOFF.md and SESSION_LOG.md.
--
-- Reverse: do not. Re-inserting this pair reinstates a privilege escalation the
-- approved product rule forbids, and would need a written product decision
-- first.

DELETE rp FROM `role_permissions` rp
JOIN `roles` r ON r.`id` = rp.`role_id`
JOIN `permissions` p ON p.`id` = rp.`permission_id`
WHERE r.`key` = 'branch_manager'
  AND p.`key` = 'discount.override';
