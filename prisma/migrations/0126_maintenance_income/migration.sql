-- D227: maintenance income, on its own: never a sale, never stock. A correction is a reversing row, one per record.
-- Additive. Reverse, only before any record exists: drop the table and the two columns, DELETE the role_permissions rows and the key.
CREATE TABLE `maintenance_records` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `branch_id` BINARY(16) NOT NULL,
  `business_date` DATE NOT NULL,
  `description` VARCHAR(200) NOT NULL,
  `repair_cost` DECIMAL(14,2) NOT NULL,
  `customer_paid` DECIMAL(14,2) NOT NULL,
  `paid_method` VARCHAR(8) NULL,
  `paid_account_id` BINARY(16) NULL,
  `paid_label` VARCHAR(80) NULL,
  `cost_method` VARCHAR(8) NULL,
  `cost_account_id` BINARY(16) NULL,
  `cost_label` VARCHAR(80) NULL,
  `note` VARCHAR(500) NULL,
  `created_by` BINARY(16) NULL,
  `client_uuid` BINARY(16) NOT NULL,
  `request_hash` VARCHAR(64) NOT NULL,
  `reverses_id` BINARY(16) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_maintenance_client` (`company_id`, `client_uuid`),
  UNIQUE KEY `ux_maintenance_reverses` (`reverses_id`),
  KEY `ix_maintenance_day` (`branch_id`, `business_date`),
  CONSTRAINT `fk_maintenance_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_maintenance_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_maintenance_paid_account` FOREIGN KEY (`paid_account_id`) REFERENCES `receiving_accounts` (`id`),
  CONSTRAINT `fk_maintenance_cost_account` FOREIGN KEY (`cost_account_id`) REFERENCES `receiving_accounts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `closing_channel_counts`
  ADD COLUMN `maintenance_in` DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN `maintenance_out` DECIMAL(14,2) NOT NULL DEFAULT 0;

INSERT INTO `permissions` (`id`, `key`, `label`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), 'maintenance.record', 'Record maintenance income'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key` = 'maintenance.record');

INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('maintenance.record')
WHERE r.`key` = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );

INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`)
SELECT r.`company_id`, r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`key` IN ('maintenance.record')
WHERE r.`key` = 'store_manager'
  AND NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`role_id` = r.`id` AND rp.`permission_id` = p.`id`
  );
