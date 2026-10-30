-- ===========================================================================
-- 0113 — notification levels, per-person read state, push devices and
-- delivery records (D225, the owner's TestFlight feedback of 2026-10-29).
--
-- notification_preferences: each person's push level (all | important |
--   approvals), one row per account. It follows the account to every device.
--   No row means the default for the person's role (Important for Owners and
--   Managers, Approvals only for Employees).
-- notification_reads: who has read what. A broadcast used to carry ONE
--   is_read for the whole store, so one person reading it read it for
--   everyone. Read state is now per person and follows them across devices.
--   `notifications.is_read` stays for the rows already marked and is no
--   longer written for broadcasts.
-- push_devices: a phone's push token, its owner, and the language the phone
--   reads, so each device is told in its own language. Revoked, never deleted.
-- push_deliveries: one row per notification per device, UNIQUE, so a retried
--   dispatch cannot push twice. Its status and error code make generation,
--   delivery and failure observable. It holds no message text.
-- notifications.actor_user_id: who did it, where known, so a person is never
--   pushed their own action (it stays in their history).
--
-- Additive: new tables and one nullable column. Reverse: drop them (read
-- marks and preferences made since are then lost; take a dump first, docs/22).
-- ===========================================================================

ALTER TABLE `notifications` ADD COLUMN `actor_user_id` BINARY(16) NULL;

CREATE TABLE `notification_preferences` (
  `user_id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `level` VARCHAR(16) NOT NULL,
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`user_id`),
  KEY `notification_preferences_company` (`company_id`),
  CONSTRAINT `notification_preferences_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `notification_preferences_company_fk` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `notification_preferences_level` CHECK (`level` IN ('all', 'important', 'approvals'))
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `notification_reads` (
  `notification_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `read_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`notification_id`, `user_id`),
  KEY `notification_reads_user` (`user_id`, `company_id`),
  CONSTRAINT `notification_reads_notification_fk` FOREIGN KEY (`notification_id`) REFERENCES `notifications` (`id`) ON DELETE CASCADE,
  CONSTRAINT `notification_reads_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `notification_reads_company_fk` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `push_devices` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `user_id` BINARY(16) NOT NULL,
  `token` VARCHAR(255) NOT NULL,
  `platform` VARCHAR(16) NOT NULL,
  `locale` VARCHAR(5) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `last_seen_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `revoked_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `push_devices_token` (`token`),
  KEY `push_devices_user` (`user_id`, `revoked_at`),
  CONSTRAINT `push_devices_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `push_devices_company_fk` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `push_devices_locale` CHECK (`locale` IN ('en', 'fr', 'ar')),
  CONSTRAINT `push_devices_platform` CHECK (`platform` IN ('ios', 'android'))
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `push_deliveries` (
  `id` BINARY(16) NOT NULL,
  `company_id` BINARY(16) NOT NULL,
  `notification_id` BINARY(16) NOT NULL,
  `device_id` BINARY(16) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `error_code` VARCHAR(64) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `push_deliveries_once` (`notification_id`, `device_id`),
  KEY `push_deliveries_status` (`company_id`, `status`, `created_at`),
  CONSTRAINT `push_deliveries_notification_fk` FOREIGN KEY (`notification_id`) REFERENCES `notifications` (`id`) ON DELETE CASCADE,
  CONSTRAINT `push_deliveries_device_fk` FOREIGN KEY (`device_id`) REFERENCES `push_devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `push_deliveries_company_fk` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `push_deliveries_status_known` CHECK (`status` IN ('queued', 'sent', 'failed'))
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
