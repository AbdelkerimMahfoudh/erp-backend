-- 0109: deferred WhatsApp verification, per account, for accounts a platform superadmin provisions (D224, docs/109). Additive: no existing value changes except the new state column, backfilled from `phone_verified_at`.

-- ── The number's verification state ───────────────────────────────────────────
-- `verified` exactly when `phone_verified_at` is set: enforced by the CHECK, kept by the triggers, so every existing
-- write of `phone_verified_at` stays correct untouched, and a deferred account can never be stored as verified.
ALTER TABLE `users`
  ADD COLUMN `phone_verification` VARCHAR(24) NOT NULL DEFAULT 'required' AFTER `phone_verified_at`;

UPDATE `users` SET `phone_verification` = 'verified' WHERE `phone_verified_at` IS NOT NULL;

ALTER TABLE `users`
  ADD CONSTRAINT `ck_users_phone_verification` CHECK (`phone_verification` IN ('required', 'deferred_by_platform', 'verified')),
  ADD CONSTRAINT `ck_users_phone_verified_state` CHECK ((`phone_verification` = 'verified') = (`phone_verified_at` IS NOT NULL));

DROP TRIGGER IF EXISTS `trg_users_phone_verification_insert`;
CREATE TRIGGER `trg_users_phone_verification_insert`
BEFORE INSERT ON `users`
FOR EACH ROW
BEGIN
  IF NEW.`phone_verified_at` IS NOT NULL THEN
    SET NEW.`phone_verification` = 'verified';
  ELSEIF NEW.`phone_verification` = 'verified' THEN
    SET NEW.`phone_verification` = 'required';
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_users_phone_verification_update`;
CREATE TRIGGER `trg_users_phone_verification_update`
BEFORE UPDATE ON `users`
FOR EACH ROW
BEGIN
  IF NEW.`phone_verified_at` IS NOT NULL THEN
    SET NEW.`phone_verification` = 'verified';
  ELSEIF NEW.`phone_verification` = 'verified' THEN
    SET NEW.`phone_verification` = 'required';
  END IF;
END;

CREATE INDEX `ix_users_phone_verification` ON `users` (`company_id`, `phone_verification`);

-- ── The exception's own record ───────────────────────────────────────────────
CREATE TABLE `phone_verification_deferrals` (
  `id`            BINARY(16)   NOT NULL,
  `company_id`    BINARY(16)   NOT NULL,
  `user_id`       BINARY(16)   NOT NULL,
  `granted_by_id` BINARY(16)   NULL,
  `granted_by`    VARCHAR(160) NOT NULL,
  `reason`        VARCHAR(500) NOT NULL,
  `review_at`     DATETIME(6)  NULL,
  `granted_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `ended_at`      DATETIME(6)  NULL,
  `ended_by`      VARCHAR(160) NULL,
  `end_reason`    VARCHAR(20)  NULL,
  `live_user_id`  BINARY(16)   GENERATED ALWAYS AS (IF(`ended_at` IS NULL, `user_id`, NULL)) VIRTUAL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_phone_verification_deferrals_live` (`live_user_id`),
  KEY `ix_phone_verification_deferrals_company` (`company_id`, `granted_at`),
  KEY `ix_phone_verification_deferrals_user` (`user_id`, `granted_at`),
  CONSTRAINT `fk_phone_verification_deferrals_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_phone_verification_deferrals_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_phone_verification_deferral_end` CHECK ((`ended_at` IS NULL) = (`end_reason` IS NULL) AND (`ended_at` IS NULL) = (`ended_by` IS NULL)),
  CONSTRAINT `ck_phone_verification_deferral_reason` CHECK (`end_reason` IS NULL OR `end_reason` IN ('required', 'verified', 'cancelled'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- The person later verifying their number through the normal flow ends the exception, whichever path verified it.
DROP TRIGGER IF EXISTS `trg_users_phone_verified_ends_deferral`;
CREATE TRIGGER `trg_users_phone_verified_ends_deferral`
AFTER UPDATE ON `users`
FOR EACH ROW
BEGIN
  IF NEW.`phone_verification` = 'verified' AND NOT (OLD.`phone_verification` <=> 'verified') THEN
    UPDATE `phone_verification_deferrals`
       SET `ended_at` = NEW.`phone_verified_at`, `ended_by` = 'user:own-verification', `end_reason` = 'verified'
     WHERE `user_id` = NEW.`id` AND `ended_at` IS NULL;
  END IF;
END;

-- ── One-time setup codes for platform-provisioned accounts ───────────────────
-- Only an HMAC of the code is kept (STAFF_INVITATION_KEY, its own purpose domain). One live code per person.
CREATE TABLE `account_setup_codes` (
  `id`             BINARY(16)   NOT NULL,
  `company_id`     BINARY(16)   NOT NULL,
  `user_id`        BINARY(16)   NOT NULL,
  `token_hash`     CHAR(64)     NOT NULL,
  `issued_by`      VARCHAR(160) NOT NULL,
  `expires_at`     DATETIME(6)  NOT NULL,
  `used_at`        DATETIME(6)  NULL,
  `revoked_at`     DATETIME(6)  NULL,
  `revoked_reason` VARCHAR(20)  NULL,
  `created_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `live_user_id`   BINARY(16)   GENERATED ALWAYS AS (IF(`used_at` IS NULL AND `revoked_at` IS NULL, `user_id`, NULL)) VIRTUAL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_account_setup_codes_token` (`token_hash`),
  UNIQUE KEY `ux_account_setup_codes_live` (`live_user_id`),
  KEY `ix_account_setup_codes_company` (`company_id`, `created_at`),
  KEY `ix_account_setup_codes_user` (`user_id`, `created_at`),
  CONSTRAINT `fk_account_setup_codes_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_account_setup_codes_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_account_setup_code_one_end` CHECK (`used_at` IS NULL OR `revoked_at` IS NULL),
  CONSTRAINT `ck_account_setup_code_revoked` CHECK ((`revoked_at` IS NULL) = (`revoked_reason` IS NULL)),
  CONSTRAINT `ck_account_setup_code_reason` CHECK (`revoked_reason` IS NULL OR `revoked_reason` IN ('reissued', 'revoked', 'cancelled'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
