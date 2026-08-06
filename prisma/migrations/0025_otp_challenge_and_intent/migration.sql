-- 0025 — OTP challenge + verification intent (F1 Stage 4A, docs/23 Stage 4A).
--
-- ADDITIVE ONLY: two new tables. Nothing existing is altered or dropped, so
-- every current user, session and device is untouched and no sign-in changes.
--
-- Written by hand. `prisma migrate diff` also proposes re-adding the
-- recognition_outbox company FK and flipping auth_sessions_device_record_id_fkey
-- from RESTRICT to SET NULL — both are pre-existing drift artifacts, not intent,
-- and applying them would silently weaken 0023's device linkage.
--
-- WHY TWO TABLES
--
-- `otp_challenges` is the durable state a real OTP flow needs and the enum plus
-- `otpVerifiedAt` on user_devices could never provide: attempts, sends,
-- cooldowns, expiry, delivery outcome and a one-way code hash.
--
-- `verification_intents` is what lets Stage 4B continue a new-device sign-in
-- WITHOUT first issuing an access token. Only the token's hash is stored.
--
-- SECRETS
--
-- No plaintext code and no raw intent token is ever stored. `code_hash` is an
-- HMAC keyed by a pepper held in configuration, not in this database — six
-- digits is roughly 20 bits, so an unkeyed digest in a stolen dump is
-- brute-forced in milliseconds while a peppered one is useless without the key.
--
-- ONE LIVE CHALLENGE
--
-- `active_key` carries a value only while the challenge is pending and is
-- NULLed on every terminal transition. MySQL lets NULLs repeat under a UNIQUE
-- index, so the index below makes "at most one live challenge per user, purpose
-- and device" a database guarantee rather than an application promise — which
-- is what makes two concurrent requests safe.
--
-- Idempotence: `migrate deploy` runs this once, it writes no data and depends on
-- no seed, so a fresh deployment produces exactly this shape.

CREATE TABLE IF NOT EXISTS `otp_challenges` (
  `id`                  BINARY(16)   NOT NULL,
  `company_id`          BINARY(16)   NOT NULL,
  `user_id`             BINARY(16)   NOT NULL,
  `purpose`             ENUM('phone_verification','device_verification','logout_reauth') NOT NULL,
  `device_id`           BINARY(16)   NULL,
  -- Snapshot of where the code was sent, so a later phone change cannot
  -- retarget a live challenge.
  `destination`         VARCHAR(24)  NOT NULL,
  `candidate_phone`     VARCHAR(24)  NULL,
  -- HMAC-SHA256(code, pepper). Never the code.
  `code_hash`           VARCHAR(128) NOT NULL,
  `status`              ENUM('pending','verified','expired','cancelled','locked') NOT NULL DEFAULT 'pending',
  -- Non-NULL only while pending. See the UNIQUE index below.
  `active_key`          VARCHAR(190) NULL,
  `created_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `expires_at`          DATETIME(6)  NOT NULL,
  `attempt_count`       INTEGER      NOT NULL DEFAULT 0,
  `max_attempts`        INTEGER      NOT NULL,
  `last_attempt_at`     DATETIME(6)  NULL,
  `send_count`          INTEGER      NOT NULL DEFAULT 0,
  `last_sent_at`        DATETIME(6)  NULL,
  `resend_not_before`   DATETIME(6)  NULL,
  `verified_at`         DATETIME(6)  NULL,
  `consumed_at`         DATETIME(6)  NULL,
  `cancelled_at`        DATETIME(6)  NULL,
  `locked_at`           DATETIME(6)  NULL,
  `provider`            VARCHAR(40)  NULL,
  `provider_message_id` VARCHAR(120) NULL,
  `delivery_state`      ENUM('not_sent','accepted','channel_unavailable','rejected','temporary_failure','not_authorized') NOT NULL DEFAULT 'not_sent',
  -- Short and provider-neutral. Never a raw provider payload.
  `delivery_detail`     VARCHAR(200) NULL,
  `idempotency_key`     VARCHAR(120) NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `otp_challenges_active_key_key` (`active_key`),
  UNIQUE INDEX `otp_challenges_company_id_idempotency_key_key` (`company_id`, `idempotency_key`),
  INDEX `otp_challenges_company_id_idx` (`company_id`),
  INDEX `otp_challenges_user_id_purpose_status_idx` (`user_id`, `purpose`, `status`),
  INDEX `otp_challenges_expires_at_idx` (`expires_at`),

  CONSTRAINT `otp_challenges_company_id_fkey`
    FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `otp_challenges_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- SET NULL rather than CASCADE: revoking a device must not erase the record
  -- that a code was once requested for it.
  CONSTRAINT `otp_challenges_device_id_fkey`
    FOREIGN KEY (`device_id`) REFERENCES `user_devices`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `verification_intents` (
  `id`           BINARY(16)   NOT NULL,
  `company_id`   BINARY(16)   NOT NULL,
  `user_id`      BINARY(16)   NOT NULL,
  `purpose`      ENUM('phone_verification','device_verification','logout_reauth') NOT NULL,
  `device_id`    BINARY(16)   NULL,
  -- SHA-256 of a 256-bit random token. High entropy, so no pepper is needed
  -- here — unlike the six-digit code.
  `token_hash`   VARCHAR(128) NOT NULL,
  `challenge_id` BINARY(16)   NULL,
  `created_at`   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `expires_at`   DATETIME(6)  NOT NULL,
  `consumed_at`  DATETIME(6)  NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `verification_intents_token_hash_key` (`token_hash`),
  INDEX `verification_intents_company_id_idx` (`company_id`),
  INDEX `verification_intents_user_id_purpose_idx` (`user_id`, `purpose`),
  INDEX `verification_intents_expires_at_idx` (`expires_at`),

  CONSTRAINT `verification_intents_company_id_fkey`
    FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `verification_intents_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `verification_intents_device_id_fkey`
    FOREIGN KEY (`device_id`) REFERENCES `user_devices`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
