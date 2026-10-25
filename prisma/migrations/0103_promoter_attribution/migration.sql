-- ===========================================================================
-- 0103 — Where a self-registered business came from: a promoter's code or QR link, or another business's invitation
-- (the owner's decision of 2026-10-25; D221).
--
-- Why: the platform wants to know, as a fact, which registrations a promoter brought and which a business invited —
-- nothing more. These tables record attribution and allow factual counts, and nothing else.
--
-- Four tables:
--
--   promoters — a person the platform administrator registered as a promoter: a public display name (shown to a
--     registrant who enters their code), a normalised WhatsApp number and an optional private note (both visible to the
--     platform administrator only — never in a public answer, a QR link, a registration, an analytics event or a log),
--     active or not, and which administrator created and last changed it. `public_ref` is a random 16-byte reference
--     the QR link carries instead of the row id; it is not a secret on its own (the link is signed under REFERRAL_KEY).
--
--   promoter_codes — every six-digit code a promoter has held. A code is drawn by a CSPRNG and is UNIQUE for ever: a
--     retired code is never issued again, so an old card can never lead to somebody else. `version` numbers a
--     promoter's codes from 1 and is also the version the QR link is signed with: regenerating retires the code and its
--     QR link together. At most one usable code per promoter (`live_promoter_id`, UNIQUE while not retired).
--
--   referral_invitations — a link a signed-in user of a business shares to invite somebody to register. It belongs to
--     the business; the user who created it is kept for the audit. A language, a time, and revocation. No recipient:
--     nobody's number or name is ever recorded. One live link per user and language (`live_user_id`, `language`).
--
--   business_acquisitions — the one original attribution of a business, written in the registration's own
--     transaction: a promoter (by code or by QR link) or a user invitation, never both (CHECK). The promoter's display
--     name is snapshotted as it was; the promoter's number never is. `registration_attempt_id` ties it to the
--     registration's idempotency record. A business registered without a source has no row.
--
-- The application account may retire a code once and change a promoter's own details, but never rewrite a code,
-- re-point an invitation, change or delete an attribution, nor delete any of these rows (triggers, like 0099–0101).
-- The migrator and an operator's maintenance account are not refused.
--
-- Additive: four new tables; no existing row changes, and no existing business is given a source.
--
-- Reverse (only after a restore point; older code never reads these tables, so an application rollback does not
-- need it):
--   DROP TRIGGER IF EXISTS `trg_business_acquisition_no_delete`; DROP TRIGGER IF EXISTS `trg_business_acquisition_no_update`;
--   DROP TRIGGER IF EXISTS `trg_referral_invitation_no_delete`; DROP TRIGGER IF EXISTS `trg_referral_invitation_guard_update`;
--   DROP TRIGGER IF EXISTS `trg_promoter_code_no_delete`; DROP TRIGGER IF EXISTS `trg_promoter_code_guard_update`;
--   DROP TRIGGER IF EXISTS `trg_promoter_no_delete`; DROP TRIGGER IF EXISTS `trg_promoter_guard_update`;
--   ALTER TABLE `promoters` DROP FOREIGN KEY `fk_promoters_current_code`;
--   DROP TABLE `business_acquisitions`, `referral_invitations`, `promoter_codes`, `promoters`;
-- ===========================================================================

CREATE TABLE `promoters` (
  `id`               BINARY(16)   NOT NULL,
  `public_ref`       BINARY(16)   NOT NULL,
  `display_name`     VARCHAR(80)  NOT NULL,
  `whatsapp_number`  VARCHAR(24)  NOT NULL,
  `note`             VARCHAR(500) NULL,
  `is_active`        TINYINT(1)   NOT NULL DEFAULT 1,
  `current_code_id`  BINARY(16)   NULL,
  `created_by`       VARCHAR(160) NOT NULL,
  `updated_by`       VARCHAR(160) NOT NULL,
  `created_at`       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_promoters_public_ref` (`public_ref`),
  UNIQUE KEY `ux_promoters_current_code` (`current_code_id`),
  KEY `ix_promoters_created` (`created_at`),
  KEY `ix_promoters_name` (`display_name`),
  CONSTRAINT `ck_promoter_name` CHECK (CHAR_LENGTH(TRIM(`display_name`)) > 0),
  CONSTRAINT `ck_promoter_number` CHECK (`whatsapp_number` REGEXP '^\\+[0-9]{6,20}$')
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE `promoter_codes` (
  `id`               BINARY(16)   NOT NULL,
  `promoter_id`      BINARY(16)   NOT NULL,
  `code`             CHAR(6)      NOT NULL,
  `version`          INT UNSIGNED NOT NULL,
  `issued_by`        VARCHAR(160) NOT NULL,
  `issued_at`        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `retired_at`       DATETIME(6)  NULL,
  `retired_by`       VARCHAR(160) NULL,
  `live_promoter_id` BINARY(16)   GENERATED ALWAYS AS (IF(`retired_at` IS NULL, `promoter_id`, NULL)) VIRTUAL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_promoter_codes_code` (`code`),
  UNIQUE KEY `ux_promoter_codes_version` (`promoter_id`, `version`),
  UNIQUE KEY `ux_promoter_codes_live` (`live_promoter_id`),
  CONSTRAINT `fk_promoter_codes_promoter` FOREIGN KEY (`promoter_id`) REFERENCES `promoters` (`id`),
  CONSTRAINT `ck_promoter_code_digits` CHECK (`code` REGEXP '^[0-9]{6}$'),
  CONSTRAINT `ck_promoter_code_version` CHECK (`version` >= 1),
  CONSTRAINT `ck_promoter_code_retired` CHECK ((`retired_at` IS NULL) = (`retired_by` IS NULL))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

ALTER TABLE `promoters`
  ADD CONSTRAINT `fk_promoters_current_code` FOREIGN KEY (`current_code_id`) REFERENCES `promoter_codes` (`id`);

CREATE TABLE `referral_invitations` (
  `id`                 BINARY(16)  NOT NULL,
  `public_ref`         BINARY(16)  NOT NULL,
  `company_id`         BINARY(16)  NOT NULL,
  `created_by_user_id` BINARY(16)  NOT NULL,
  `language`           VARCHAR(2)  NOT NULL,
  `created_at`         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `revoked_at`         DATETIME(6) NULL,
  `revoked_by_user_id` BINARY(16)  NULL,
  `live_user_id`       BINARY(16)  GENERATED ALWAYS AS (IF(`revoked_at` IS NULL, `created_by_user_id`, NULL)) VIRTUAL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_referral_invitations_ref` (`public_ref`),
  UNIQUE KEY `ux_referral_invitations_live` (`live_user_id`, `language`),
  KEY `ix_referral_invitations_company` (`company_id`, `created_at`),
  KEY `ix_referral_invitations_user` (`created_by_user_id`, `created_at`),
  CONSTRAINT `fk_referral_invitations_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_referral_invitations_user` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_referral_invitations_revoker` FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_referral_invitation_language` CHECK (`language` IN ('en', 'fr', 'ar')),
  CONSTRAINT `ck_referral_invitation_revoked` CHECK ((`revoked_at` IS NULL) = (`revoked_by_user_id` IS NULL))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE `business_acquisitions` (
  `id`                      BINARY(16)   NOT NULL,
  `company_id`              BINARY(16)   NOT NULL,
  `registration_attempt_id` BINARY(16)   NOT NULL,
  `source`                  VARCHAR(16)  NOT NULL,
  `mechanism`               VARCHAR(16)  NOT NULL,
  `promoter_id`             BINARY(16)   NULL,
  `promoter_code_id`        BINARY(16)   NULL,
  `code_version`            INT UNSIGNED NULL,
  `promoter_name`           VARCHAR(80)  NULL,
  `invitation_id`           BINARY(16)   NULL,
  `inviter_company_id`      BINARY(16)   NULL,
  `inviter_user_id`         BINARY(16)   NULL,
  `attributed_at`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_business_acquisitions_company` (`company_id`),
  UNIQUE KEY `ux_business_acquisitions_attempt` (`registration_attempt_id`),
  KEY `ix_business_acquisitions_source` (`source`, `attributed_at`),
  KEY `ix_business_acquisitions_promoter` (`promoter_id`, `attributed_at`),
  KEY `ix_business_acquisitions_inviter` (`inviter_company_id`, `attributed_at`),
  CONSTRAINT `fk_business_acquisitions_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_business_acquisitions_attempt` FOREIGN KEY (`registration_attempt_id`) REFERENCES `registration_attempts` (`id`),
  CONSTRAINT `fk_business_acquisitions_promoter` FOREIGN KEY (`promoter_id`) REFERENCES `promoters` (`id`),
  CONSTRAINT `fk_business_acquisitions_code` FOREIGN KEY (`promoter_code_id`) REFERENCES `promoter_codes` (`id`),
  CONSTRAINT `fk_business_acquisitions_invitation` FOREIGN KEY (`invitation_id`) REFERENCES `referral_invitations` (`id`),
  CONSTRAINT `fk_business_acquisitions_inviter_company` FOREIGN KEY (`inviter_company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_business_acquisitions_inviter_user` FOREIGN KEY (`inviter_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_business_acquisition_shape` CHECK (
    (`source` = 'promoter' AND `mechanism` IN ('promo_code', 'promoter_qr')
      AND `promoter_id` IS NOT NULL AND `promoter_code_id` IS NOT NULL AND `code_version` IS NOT NULL AND `promoter_name` IS NOT NULL
      AND `invitation_id` IS NULL AND `inviter_company_id` IS NULL AND `inviter_user_id` IS NULL)
    OR
    (`source` = 'user_invite' AND `mechanism` = 'user_invite'
      AND `invitation_id` IS NOT NULL AND `inviter_company_id` IS NOT NULL AND `inviter_user_id` IS NOT NULL
      AND `promoter_id` IS NULL AND `promoter_code_id` IS NULL AND `code_version` IS NULL AND `promoter_name` IS NULL)
  ),
  CONSTRAINT `ck_business_acquisition_not_self` CHECK (`inviter_company_id` IS NULL OR `inviter_company_id` <> `company_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `trg_promoter_guard_update`;
CREATE TRIGGER `trg_promoter_guard_update`
BEFORE UPDATE ON `promoters`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    IF NOT (NEW.`public_ref` <=> OLD.`public_ref`) OR NOT (NEW.`created_by` <=> OLD.`created_by`)
       OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'promoters: a promoter keeps its reference and its creation';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_promoter_no_delete`;
CREATE TRIGGER `trg_promoter_no_delete`
BEFORE DELETE ON `promoters`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'promoters: a promoter is never deleted';
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_promoter_code_guard_update`;
CREATE TRIGGER `trg_promoter_code_guard_update`
BEFORE UPDATE ON `promoter_codes`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    IF OLD.`retired_at` IS NOT NULL THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'promoter_codes: a retired code is never changed';
    END IF;
    IF NOT (NEW.`promoter_id` <=> OLD.`promoter_id`) OR NOT (NEW.`code` <=> OLD.`code`)
       OR NOT (NEW.`version` <=> OLD.`version`) OR NOT (NEW.`issued_by` <=> OLD.`issued_by`)
       OR NOT (NEW.`issued_at` <=> OLD.`issued_at`) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'promoter_codes: a code keeps its promoter, digits, version and issue';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_promoter_code_no_delete`;
CREATE TRIGGER `trg_promoter_code_no_delete`
BEFORE DELETE ON `promoter_codes`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'promoter_codes: a code is never deleted';
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_referral_invitation_guard_update`;
CREATE TRIGGER `trg_referral_invitation_guard_update`
BEFORE UPDATE ON `referral_invitations`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    IF OLD.`revoked_at` IS NOT NULL THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'referral_invitations: a revoked invitation is never changed';
    END IF;
    IF NOT (NEW.`public_ref` <=> OLD.`public_ref`) OR NOT (NEW.`company_id` <=> OLD.`company_id`)
       OR NOT (NEW.`created_by_user_id` <=> OLD.`created_by_user_id`) OR NOT (NEW.`language` <=> OLD.`language`)
       OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'referral_invitations: an invitation keeps its business, person, language and reference';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_referral_invitation_no_delete`;
CREATE TRIGGER `trg_referral_invitation_no_delete`
BEFORE DELETE ON `referral_invitations`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'referral_invitations: an invitation is never deleted';
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_business_acquisition_no_update`;
CREATE TRIGGER `trg_business_acquisition_no_update`
BEFORE UPDATE ON `business_acquisitions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'business_acquisitions: an attribution is immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_business_acquisition_no_delete`;
CREATE TRIGGER `trg_business_acquisition_no_delete`
BEFORE DELETE ON `business_acquisitions`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'business_acquisitions: an attribution is immutable';
  END IF;
END;
