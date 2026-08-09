-- ===========================================================================
-- 0032_manager_cancel_route_permission
--
-- 0031 gave Store Manager `transfer.cancel` but not `transfer.cancel_own`, on
-- the reasoning that the broad key supersedes the narrow one. Live verification
-- proved otherwise: the cancel ROUTE is guarded on `transfer.cancel_own`, and
-- PermissionsGuard requires ALL listed permissions -- so a manager was refused
-- before the service could decide anything. A manager could not cancel at all.
--
-- The two keys do different jobs:
--   transfer.cancel_own  ROUTE key    — may reach the cancel endpoint
--   transfer.cancel      BREADTH key  — may cancel somebody else's transfer
--
-- Guarding the route on the broad key instead would have locked employees out
-- of withdrawing their own request; guarding on both locks managers out. So the
-- route takes the narrow key, everyone who cancels holds it, and breadth stays
-- a service decision.
--
-- Additive and idempotent. 0031 is not edited -- it is already pushed.
-- ===========================================================================

INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'transfer.cancel_own'
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp
    WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
