-- ===========================================================================
-- 0101 — An employee activates their own account from an invitation (the owner's decision of 2026-10-19; D214).
--
-- Why: an Owner adding an employee used to send that person a verification code on the Owner's say-so. An employee's
-- WhatsApp number is now mandatory and its operational consent is the employee's own (D213), so creating the account
-- sends nothing — no WhatsApp, no email. Instead the server issues an invitation: a short reference the Owner is shown
-- once and passes on themselves. The employee enters it in the app, types their number, accepts the consent and asks
-- for the code; verifying it activates the consent, uses the invitation and activates the account in one transaction.
--
-- What a row holds:
--   - one business and one person — never a phone number, never the reference: `token_hash` is an HMAC-SHA256 of the
--     reference under a key that lives outside the database (STAFF_INVITATION_KEY), in its own purpose domain, so a
--     leaked database yields no working reference and no hash comparable with any other secret's;
--   - a 72-hour life (`expires_at`);
--   - the employee's pending WhatsApp consent its code went out under (`pending_consent_id`, `whatsapp_consents.id`);
--   - how it ended, once: used (`used_at`) or revoked (`revoked_at`, `revoked_reason` reinvited | cancelled).
--
-- At most one live invitation per person: `live_user_id` is the person while the invitation is neither used nor
-- revoked, and is UNIQUE — issuing a new one must revoke the old in the same transaction. Expiry is a time, not a
-- state, and needs no sweep: an expired invitation simply opens nothing.
--
-- The application account may record how an invitation ends, and its pending consent, but never edit an ended one,
-- re-point one at another business, person or hash, nor delete any (triggers, like 0099 and 0100). The migrator and an
-- operator's maintenance account are not refused.
--
-- Additive: a new table; no existing row changes. Pending employees from before this migration get no invitation
-- until their Owner issues one: nothing is created for them silently.
-- ===========================================================================

CREATE TABLE `staff_invitations` (
  `id`                 BINARY(16)   NOT NULL,
  `company_id`         BINARY(16)   NOT NULL,
  `user_id`            BINARY(16)   NOT NULL,
  `token_hash`         CHAR(64)     NOT NULL,
  `issued_by`          VARCHAR(160) NOT NULL,
  `expires_at`         DATETIME(6)  NOT NULL,
  `pending_consent_id` BINARY(16)   NULL,
  `used_at`            DATETIME(6)  NULL,
  `revoked_at`         DATETIME(6)  NULL,
  `revoked_reason`     VARCHAR(20)  NULL,
  `created_at`         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `live_user_id`       BINARY(16)   GENERATED ALWAYS AS (IF(`used_at` IS NULL AND `revoked_at` IS NULL, `user_id`, NULL)) VIRTUAL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_staff_invitations_token` (`token_hash`),
  UNIQUE KEY `ux_staff_invitations_live` (`live_user_id`),
  KEY `ix_staff_invitations_company` (`company_id`, `created_at`),
  KEY `ix_staff_invitations_user` (`user_id`, `created_at`),
  CONSTRAINT `fk_staff_invitations_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`),
  CONSTRAINT `fk_staff_invitations_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `ck_staff_invitation_one_end` CHECK (`used_at` IS NULL OR `revoked_at` IS NULL),
  CONSTRAINT `ck_staff_invitation_revoked` CHECK ((`revoked_at` IS NULL) = (`revoked_reason` IS NULL)),
  CONSTRAINT `ck_staff_invitation_reason` CHECK (`revoked_reason` IS NULL OR `revoked_reason` IN ('reinvited', 'cancelled')),
  CONSTRAINT `ck_staff_invitation_used` CHECK (`used_at` IS NULL OR `pending_consent_id` IS NOT NULL)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

DROP TRIGGER IF EXISTS `trg_staff_invitation_guard_update`;
CREATE TRIGGER `trg_staff_invitation_guard_update`
BEFORE UPDATE ON `staff_invitations`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    IF OLD.`used_at` IS NOT NULL OR OLD.`revoked_at` IS NOT NULL THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'staff_invitations: an ended invitation is never changed';
    END IF;
    IF NOT (NEW.`company_id` <=> OLD.`company_id`) OR NOT (NEW.`user_id` <=> OLD.`user_id`)
       OR NOT (NEW.`token_hash` <=> OLD.`token_hash`) OR NOT (NEW.`expires_at` <=> OLD.`expires_at`)
       OR NOT (NEW.`issued_by` <=> OLD.`issued_by`) OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'staff_invitations: an invitation keeps its business, person, reference and life';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_staff_invitation_no_delete`;
CREATE TRIGGER `trg_staff_invitation_no_delete`
BEFORE DELETE ON `staff_invitations`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'staff_invitations: an invitation is never deleted';
  END IF;
END;
