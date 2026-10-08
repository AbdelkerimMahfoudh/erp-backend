-- ===========================================================================
-- 0090 — The nine permissions of the Money Services Agent activity
--        (docs/73 §7, D154–D157, 2026-10-08).
--
-- Who may do what at an agent counter, in the catalogue's own shapes: the
-- person at the counter records and reports (like `refund.report`); a Store
-- Manager reverses once, rebalances and reads the reports; the Owner alone
-- sets positions and configures providers — outside the Administrator's
-- grant, like `money.anchor.record`. The Administrator holds no agent key.
--
-- Each key is one additive insert guarded by NOT EXISTS; grants use the
-- one-role, several-permissions shape `role-matrix-drift.spec.ts` reads.
-- Reverse: DELETE the nine `role_permissions` rows, then the nine `permissions`.
-- ===========================================================================

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'agent.transaction.record', 'Record a cash / digital-credit exchange at the counter'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'agent.transaction.record');
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'agent.transaction.view', 'View the agent counter''s exchanges'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'agent.transaction.view');
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'agent.customer.reveal', 'See a customer''s full number on an exchange'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'agent.customer.reveal');
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'agent.mistake.report', 'Report a mistake on a recorded exchange'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'agent.mistake.report');
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'agent.transaction.reverse', 'Reverse a recorded exchange (audited, once)'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'agent.transaction.reverse');
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'agent.rebalance', 'Move money between cash and provider floats'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'agent.rebalance');
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'agent.position.set', 'Set what a provider float holds now'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'agent.position.set');
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'agent.report.view', 'View the agent counter''s reports'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'agent.report.view');
INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'agent.provider.manage', 'Configure providers, their rates and settlement'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'agent.provider.manage');

-- Owner: everything.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('agent.transaction.record','agent.transaction.view','agent.customer.reveal','agent.mistake.report','agent.transaction.reverse','agent.rebalance','agent.position.set','agent.report.view','agent.provider.manage')
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Store manager: records, reports, reads the full number, reverses once, rebalances, reads the reports.
-- Never sets a position or configures a provider.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('agent.transaction.record','agent.transaction.view','agent.customer.reveal','agent.mistake.report','agent.transaction.reverse','agent.rebalance','agent.report.view')
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Store employee: the counter — record, see the masked list, report a mistake. Nothing that moves money twice.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('agent.transaction.record','agent.transaction.view','agent.mistake.report')
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
