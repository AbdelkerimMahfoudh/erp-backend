-- ===========================================================================
-- 0108 — the return policy is the branch's, written, and snapshotted on every
-- sale with the customer's name (D223 device QA, the owner's brief of 2026-10-28).
--
-- The sale screen no longer chooses a policy: the server resolves the branch's
-- policy at confirmation and writes it onto the sale. Owners, Store Managers and
-- Store Employees may edit the policy of a branch they are assigned to
-- (`return.policy.edit`), audited; a change applies to future sales only.
--
-- branch_return_policies: one row per branch that has set its own policy. A
--   branch without one sells under the company's `return_window_hours`
--   (company_settings) with no written conditions, as every sale before 0108.
-- sales.return_policy_text_en/fr/ar, return_policy_language,
--   return_policy_version: the written conditions as they were when the sale was
--   confirmed. NULL for every sale before 0108 — those receipts keep their
--   window and the neutral wording.
-- sales.customer_name_snapshot, customer_phone_snapshot: the customer as named
--   at confirmation, so a later profile edit never rewrites an old receipt.
--
-- Additive: no existing value changes. Reverse: drop the table and the columns,
-- DELETE the role_permissions rows and the key.
-- ===========================================================================

CREATE TABLE `branch_return_policies` (
  `branch_id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `window_hours` INT NOT NULL DEFAULT 0,
  `text_en` VARCHAR(1000) NULL,
  `text_fr` VARCHAR(1000) NULL,
  `text_ar` VARCHAR(1000) NULL,
  `default_language` VARCHAR(2) NOT NULL DEFAULT 'en',
  `version` INT NOT NULL DEFAULT 1,
  `updated_by` BINARY(16) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`branch_id`),
  KEY `ix_branch_return_policies_company` (`company_id`),
  CONSTRAINT `fk_branch_return_policies_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_branch_return_policies_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `chk_branch_return_policies_window` CHECK (`window_hours` >= 0 AND `window_hours` <= 8760),
  CONSTRAINT `chk_branch_return_policies_language` CHECK (`default_language` IN ('en', 'fr', 'ar'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

ALTER TABLE `sales`
  ADD COLUMN `return_policy_text_en` VARCHAR(1000) NULL,
  ADD COLUMN `return_policy_text_fr` VARCHAR(1000) NULL,
  ADD COLUMN `return_policy_text_ar` VARCHAR(1000) NULL,
  ADD COLUMN `return_policy_language` VARCHAR(2) NULL,
  ADD COLUMN `return_policy_version` INT NULL,
  ADD COLUMN `customer_name_snapshot` VARCHAR(160) NULL,
  ADD COLUMN `customer_phone_snapshot` VARCHAR(40) NULL;

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'return.policy.edit', 'Edit the return policy of a branch you work in'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'return.policy.edit');

-- Owner: everything.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('return.policy.edit')
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Store manager: edits the policy of the branches they are assigned to.
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('return.policy.edit')
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

-- Store employee: the same, for the branches they are assigned to (the owner's decision).
INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('return.policy.edit')
WHERE r.`key` = 'store_employee'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
