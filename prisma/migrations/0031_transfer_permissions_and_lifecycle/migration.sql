-- ===========================================================================
-- 0031_transfer_permissions_and_lifecycle
--
-- Closes the authorization gap H0 measured and H1.1 deliberately left open:
-- `unit.transfer` guarded request, ship, receive AND cancel alike, and all
-- three roles held it, so one employee assigned to both branches could move
-- stock end to end with nobody else involved.
--
-- The permission split and the approval lifecycle ship together on purpose.
-- Renaming permissions without an approval state would either let employees
-- ship unapproved requests, or strand every employee request with no one able
-- to act on it.
--
-- Additive. 0030 and earlier are untouched.
-- ===========================================================================

-- ── 1. Lifecycle states ────────────────────────────────────────────────────
--
-- `ready_to_ship` is replaced by `approved`. The remap below is the ONLY
-- interpretation that does not invent history: a legacy `ready_to_ship` row was
-- created and could be shipped, which under the new model is exactly what
-- `approved` means. Nothing is marked received, and nothing shipped is
-- retroactively "approved by" anybody -- `approved_by` stays NULL for those
-- rows, and `auto_approved` stays false, so the audit trail never claims a
-- decision that no one made.
--
-- Development holds ZERO transfers (verified in H1.1), so this remap is a no-op
-- here. It exists for a production database that has legacy rows.

ALTER TABLE `stock_transfers`
  MODIFY `status` ENUM('ready_to_ship','in_transit','received','cancelled','pending_approval','approved','rejected')
  NOT NULL DEFAULT 'pending_approval';

UPDATE `stock_transfers` SET `status` = 'approved' WHERE `status` = 'ready_to_ship';

-- Now that no row can hold it, drop the legacy value so the model is honest.
ALTER TABLE `stock_transfers`
  MODIFY `status` ENUM('pending_approval','approved','in_transit','received','rejected','cancelled')
  NOT NULL DEFAULT 'pending_approval';

-- ── 2. Lifecycle columns ───────────────────────────────────────────────────

ALTER TABLE `stock_transfers` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `stock_transfers` ADD COLUMN `requested_by` BINARY(16) NULL;
ALTER TABLE `stock_transfers` ADD COLUMN `approved_by` BINARY(16) NULL;
ALTER TABLE `stock_transfers` ADD COLUMN `approved_at` DATETIME(6) NULL;
ALTER TABLE `stock_transfers` ADD COLUMN `auto_approved` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `stock_transfers` ADD COLUMN `decision_reason` TEXT NULL;
ALTER TABLE `stock_transfers` ADD COLUMN `decided_by` BINARY(16) NULL;
ALTER TABLE `stock_transfers` ADD COLUMN `decided_at` DATETIME(6) NULL;

-- Legacy rows kept whoever `sent_by` recorded; that person requested it under
-- the old single-step model, so it is the honest value for `requested_by`.
UPDATE `stock_transfers` SET `requested_by` = `sent_by` WHERE `requested_by` IS NULL;

ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_requested_by_fkey`
  FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_approved_by_fkey`
  FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_decided_by_fkey`
  FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. The six transfer permissions ────────────────────────────────────────
--
-- Inserted per company, guarded by NOT EXISTS so a rerun is a no-op.

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(),'-','')), k.`key`, k.`label`
FROM (
  SELECT 'transfer.view'       AS `key`, 'View stock transfers' AS `label`
  UNION ALL SELECT 'transfer.request',    'Request a stock transfer'
  UNION ALL SELECT 'transfer.approve',    'Approve or reject a transfer request'
  UNION ALL SELECT 'transfer.ship',       'Ship an approved transfer'
  UNION ALL SELECT 'transfer.receive',    'Receive a transfer at the destination'
  UNION ALL SELECT 'transfer.cancel',     'Cancel any transfer before shipment'
  UNION ALL SELECT 'transfer.cancel_own', 'Withdraw your own pending request'
) k
WHERE NOT EXISTS (SELECT 1 FROM `permissions` p WHERE p.`key` = k.`key`);

-- ── 4. Role grants ─────────────────────────────────────────────────────────

-- Owner: every transfer authority.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` = 'transfer.view'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.request'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.approve'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.ship'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.receive'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.cancel'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.cancel_own'
WHERE r.`key` = 'owner'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);

-- Store Manager: approves and cancels, branch-scoped. No `cancel_own` -- the
-- general `transfer.cancel` already covers their own requests.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.view'
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.request'
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.approve'
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.ship'
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.receive'
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.cancel'
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);

-- Store Employee: the daily movement, and withdrawing their OWN request.
-- Deliberately no `transfer.approve` and no general `transfer.cancel`.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.view'
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.request'
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.ship'
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.receive'
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r JOIN `permissions` p ON p.`key` = 'transfer.cancel_own'
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`);

-- ── 5. Revoke the legacy blanket permission ────────────────────────────────
--
-- No transfer route accepts `unit.transfer` after this migration, so leaving
-- the grants in place would be dead authority that a future route might
-- accidentally honour again. The permission RECORD is kept: it appears in
-- historical audit rows, and deleting it would orphan them.
--
-- Safe to delete the record itself once no `role_permissions` row references it
-- AND no audit or reporting query reads the key -- neither is true today.
--
-- Scoped to the store-facing roles. Legacy roles keep what they had, exactly as
-- 0018 did, and Owner keeps it as part of the all-permissions grant where it is
-- inert.

DELETE rp FROM `role_permissions` rp
JOIN `roles` r ON r.`id` = rp.`role_id`
JOIN `permissions` p ON p.`id` = rp.`permission_id`
WHERE r.`key` IN ('store_manager', 'store_employee') AND p.`key` = 'unit.transfer';
