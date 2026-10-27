-- ===========================================================================
-- 0105 — sale.below_cost: selling at a loss (D223, 2026-10-27).
--
-- The owner removed the price floor: the configured selling price is a
-- suggestion. What stays guarded is a sale below COST. The Owner and Store
-- Managers may make one after a high-friction warning and with a reason, and
-- decide a seller's request to; a Store Employee asks them. The Administrator
-- holds no money key by default (D11) and gets none here.
--
-- One additive insert guarded by NOT EXISTS; grants use the one-role,
-- several-permissions shape role-matrix-drift.spec.ts reads.
-- Reverse: DELETE the two role_permissions rows per company, then the key.
-- ===========================================================================

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'sale.below_cost', 'Sell below cost after a warning, and approve a seller''s request'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'sale.below_cost');

-- Owner: everything.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('sale.below_cost')
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Store manager: sells at a loss after the warning, and approves a seller's request.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('sale.below_cost')
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
