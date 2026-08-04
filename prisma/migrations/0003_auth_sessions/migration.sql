-- ===========================================================================
-- 0003_auth_sessions — session store for rotating refresh tokens (Sprint 1 / D-A)
-- One row per active login/device. Stores only the Argon2 hash of the refresh
-- secret. Tenant-scoped (company_id) like every other table.
-- ===========================================================================

CREATE TABLE `auth_sessions` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NOT NULL,
  `device_id` VARCHAR(120) NULL,
  `device_name` VARCHAR(120) NULL,
  `platform` VARCHAR(40) NULL,
  `app_version` VARCHAR(40) NULL,
  `user_agent` VARCHAR(255) NULL,
  `ip` VARCHAR(45) NULL,
  `refresh_token_hash` VARCHAR(255) NOT NULL,
  `last_used_at` DATETIME(6) NULL,
  `expires_at` DATETIME(6) NOT NULL,
  `revoked_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `auth_sessions_company_id_idx` (`company_id`),
  KEY `auth_sessions_user_id_idx` (`user_id`),
  KEY `auth_sessions_expires_at_idx` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
