-- 0023 — Device identity (F1 Stage 3, docs/23 §4 Stage 3).
--
-- ADDITIVE ONLY. One new table and one nullable column. Nothing existing is
-- altered or dropped, so **every current session keeps working** — which is the
-- point: invalidating them would force every signed-in user through an OTP
-- flow that does not exist yet.
--
-- WHAT THIS MODELS
--
-- A device is recognised by a PAIR: the public `id` in this table and a
-- high-entropy secret returned exactly once at enrollment and stored here only
-- as an Argon2id hash. The id alone proves nothing, so a leaked device list
-- cannot be replayed, and `secret_hash` cannot be reversed into a credential.
--
-- Rows are scoped to one (company, user). Two people sharing a handset get two
-- rows and two secrets; nothing here can correlate a device across users or
-- companies. There is deliberately no IMEI, serial, advertising id or any other
-- hardware fingerprint — `label`, `platform`, `model` and `app_version` are
-- untrusted display metadata, never used for a decision.
--
-- `trust_method` records how trust was obtained, honestly:
--   legacy   — adopted from a session that predates device identity
--   password — enrolled at a successful password login (no OTP provider yet)
--   otp      — Stage 4 only; NOTHING in Stage 3 writes this
-- `otp_verified_at` stays NULL for the same reason: no fake verification.
--
-- Revoked devices are KEPT (`revoked_at`), not deleted. A security history that
-- disappears the moment someone revokes a stolen phone is not a history.
--
-- `auth_sessions.device_record_id` is NULLABLE on purpose: existing sessions
-- have no device and adopt a legacy-trusted one on their next app launch. It is
-- ON DELETE RESTRICT so a device row can never be deleted out from under a
-- session that references it.
--
-- IDEMPOTENCE / DEPLOY SAFETY
--
-- The migrations ledger runs this once. It writes no data and depends on no
-- seed, so a fresh `migrate deploy` produces exactly this shape.

-- CreateTable
CREATE TABLE IF NOT EXISTS `user_devices` (
  `id`                BINARY(16)   NOT NULL,
  `company_id`        BINARY(16)   NOT NULL,
  `user_id`           BINARY(16)   NOT NULL,
  -- Argon2id hash. The raw credential exists only on the device.
  `secret_hash`       VARCHAR(255) NOT NULL,
  -- Untrusted display metadata below this line.
  `label`             VARCHAR(120) NULL,
  `platform`          VARCHAR(40)  NULL,
  `model`             VARCHAR(120) NULL,
  `app_version`       VARCHAR(40)  NULL,
  `trust_method`      ENUM('legacy','password','otp') NOT NULL,
  `trusted_at`        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `otp_verified_at`   DATETIME(6)  NULL,
  `reverify_required` BOOLEAN      NOT NULL DEFAULT false,
  `first_seen_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `last_seen_at`      DATETIME(6)  NULL,
  `revoked_at`        DATETIME(6)  NULL,
  `revoked_by_id`     BINARY(16)   NULL,

  PRIMARY KEY (`id`),
  INDEX `user_devices_company_id_idx` (`company_id`),
  INDEX `user_devices_user_id_revoked_at_idx` (`user_id`, `revoked_at`),
  CONSTRAINT `user_devices_company_id_fkey`
    FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `user_devices_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: link a session to its device. NULL = a pre-Stage-3 session that
-- has not adopted one yet. Those sessions stay valid.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_sessions'
    AND COLUMN_NAME = 'device_record_id'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `auth_sessions` ADD COLUMN `device_record_id` BINARY(16) NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_sessions'
    AND CONSTRAINT_NAME = 'auth_sessions_device_record_id_fkey'
);
SET @sql := IF(@fk = 0,
  'ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_device_record_id_fkey` FOREIGN KEY (`device_record_id`) REFERENCES `user_devices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_sessions'
    AND INDEX_NAME = 'auth_sessions_device_record_id_idx'
);
SET @sql := IF(@idx = 0,
  'CREATE INDEX `auth_sessions_device_record_id_idx` ON `auth_sessions` (`device_record_id`)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
