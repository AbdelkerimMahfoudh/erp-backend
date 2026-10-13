-- ===========================================================================
-- 0095 — The website-only seven-day free trial (the owner's decisions of 2026-10-13 and his correction of the same
--        day; docs/76).
--
-- Why: a business that registered itself may use Dukan ERP for exactly 168 hours, once, from the instant its Owner
-- confirms it on the Dukan ERP website. The trial is stored as FACTS, never as a status: `subscriptions.status` keeps
-- its five values (a claim leaves it `pending_activation`), and available / active / expired are computed from these
-- rows and the server clock on every request, as grace is. Nothing here is a payment, a billing period, a grace or a
-- renewal, and nothing here is ever written for a business the Super Admin created.
--
-- trial_eligibilities: one row per company, ever, written only by public self-registration and never backfilled —
--   which contacts were given (both given, both must be verified) and when. Closed once, NULL → value, when the
--   business is approved, granted, given a paid period, refused or cancelled, so a business that was ever paid for,
--   refused or closed can never start a trial. Nothing else in the row ever moves (trigger).
-- trial_claims: the trial itself — one per company, ever (UNIQUE), immutable (triggers): claimed and started at one
--   server instant, ending exactly 168 hours later (two CHECKs), with the terms version the website showed, its
--   idempotency key and request hash, the subscription version the claim left and the setup link it consumed. The
--   single later write is `expiry_recorded_at`, NULL → value once, so the expiry is audited exactly once.
-- trial_setup_links: the single-purpose links sent to the Owner's verified contacts — the token's SHA-256 only, never
--   the token, bound to the Owner by a keyed digest of their credentials and contacts; 24 hours; consumed only by a
--   claim; revoked by a newer send, a sign-out everywhere, a contact or password change, a deletion or a closure.
-- trial_setup_messages: every attempt to send the setup instructions, append-only (triggers) — which channel accepted,
--   failed or could not be used; never a destination, a token or a code. Also the durable resend throttle.
-- subscription_events.kind gains `trial_eligible`, `trial_claimed` and `trial_expired`, with the Prisma enum: this
--   server's empty sql_mode would store an unlisted kind as '' (0057).
--
-- Every instant in the four tables is written by the API from the server clock, in UTC; the column defaults are a
-- fallback only. The triggers refuse the application account (`phonestore_app`), as every append-only guard in this
-- schema does; the CHECKs bind every account, whatever the sql_mode.
--
-- Additive: no existing row changes, and no existing business becomes eligible.
-- Reverse (delete the subscription_events rows of the three new kinds first, or MySQL blanks them):
--   DROP TABLE `trial_claims`;
--   DROP TABLE `trial_setup_messages`;
--   DROP TABLE `trial_setup_links`;
--   DROP TABLE `trial_eligibilities`;
--   ALTER TABLE `subscription_events` MODIFY `kind` ENUM('created','extended','branches_changed','seats_changed','complimentary_granted','complimentary_revoked','backfilled','registered','administrative_grant','suspended','reinstated','cancelled','approved','rejected','period_corrected','seat_requested','seat_paid','staff_activated','seat_closed','store_requested','activity_requested','activity_changed','activity_scheduled','renewed') NOT NULL;
-- ===========================================================================

-- 1. Who may claim: one row per company, ever, closed once ---------------------------
CREATE TABLE IF NOT EXISTS `trial_eligibilities` (
  `id`                  BINARY(16)   NOT NULL,
  `company_id`          BINARY(16)   NOT NULL,
  `owner_user_id`       BINARY(16)   NOT NULL,
  `registration_method` ENUM('email','phone','both') NOT NULL,
  `basis`               ENUM('self_registration') NOT NULL DEFAULT 'self_registration',
  `created_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `closed_at`           DATETIME(6)  NULL,
  `closed_reason`       ENUM('approved','granted','paid_period','refused','cancelled') NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_trial_eligibility_company` (`company_id`),
  CONSTRAINT `ck_trial_eligibility_closure` CHECK ((`closed_at` IS NULL) = (`closed_reason` IS NULL)),
  CONSTRAINT `fk_trial_eligibilities_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_trial_eligibilities_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. The links the setup instructions carry: hashes only ------------------------------
CREATE TABLE IF NOT EXISTS `trial_setup_links` (
  `id`             BINARY(16)  NOT NULL,
  `company_id`     BINARY(16)  NOT NULL,
  `user_id`        BINARY(16)  NOT NULL,
  `token_hash`     CHAR(64)    NOT NULL,
  `binding_digest` CHAR(64)    NOT NULL,
  `expires_at`     DATETIME(6) NOT NULL,
  `consumed_at`    DATETIME(6) NULL,
  `revoked_at`     DATETIME(6) NULL,
  `revoked_reason` ENUM('reissued','signed_out_everywhere','contact_changed','password_changed','deleted','closed') NULL,
  `created_at`     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_trial_setup_link_token` (`token_hash`),
  KEY `ix_trial_setup_links_company` (`company_id`, `created_at`),
  CONSTRAINT `ck_trial_setup_link_revocation` CHECK ((`revoked_at` IS NULL) = (`revoked_reason` IS NULL)),
  CONSTRAINT `fk_trial_setup_links_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_trial_setup_links_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 3. The trial: one per company, ever, exactly 168 hours ------------------------------
--    The optional link is RESTRICT, not the SET NULL a nullable relation would default to: MySQL runs no trigger for
--    a cascaded change, so a deleted link would otherwise rewrite a claim behind the trigger's back.
CREATE TABLE IF NOT EXISTS `trial_claims` (
  `id`                         BINARY(16)   NOT NULL,
  `company_id`                 BINARY(16)   NOT NULL,
  `eligibility_id`             BINARY(16)   NOT NULL,
  `claimant_user_id`           BINARY(16)   NOT NULL,
  `claimed_at`                 DATETIME(6)  NOT NULL,
  `started_at`                 DATETIME(6)  NOT NULL,
  `ends_at`                    DATETIME(6)  NOT NULL,
  `terms_version`              VARCHAR(40)  NOT NULL,
  `idempotency_key`            VARCHAR(80)  NOT NULL,
  `request_hash`               CHAR(64)     NOT NULL,
  `subscription_version_after` INT UNSIGNED NOT NULL,
  `setup_link_id`              BINARY(16)   NULL,
  `expiry_recorded_at`         DATETIME(6)  NULL,
  `created_at`                 DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_trial_claim_company` (`company_id`),
  CONSTRAINT `ck_trial_claim_start` CHECK (`started_at` = `claimed_at`),
  CONSTRAINT `ck_trial_claim_end` CHECK (`ends_at` = `started_at` + INTERVAL 168 HOUR),
  CONSTRAINT `fk_trial_claims_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_trial_claims_eligibility` FOREIGN KEY (`eligibility_id`) REFERENCES `trial_eligibilities` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_trial_claims_claimant` FOREIGN KEY (`claimant_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_trial_claims_setup_link` FOREIGN KEY (`setup_link_id`) REFERENCES `trial_setup_links` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 4. Every attempt to send the setup instructions -------------------------------------
--    `trigger` is a reserved word: always quoted. The optional references are RESTRICT for the same reason as above.
CREATE TABLE IF NOT EXISTS `trial_setup_messages` (
  `id`                   BINARY(16)  NOT NULL,
  `company_id`           BINARY(16)  NOT NULL,
  `requested_by_user_id` BINARY(16)  NULL,
  `trigger`              ENUM('verified','resend') NOT NULL,
  `link_id`              BINARY(16)  NULL,
  `email_outcome`        ENUM('accepted','failed','unavailable','not_applicable') NOT NULL,
  `whatsapp_outcome`     ENUM('accepted','failed','unavailable','not_applicable') NOT NULL,
  `created_at`           DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_trial_setup_messages_company` (`company_id`, `created_at`),
  CONSTRAINT `fk_trial_setup_messages_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_trial_setup_messages_requested_by` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_trial_setup_messages_link` FOREIGN KEY (`link_id`) REFERENCES `trial_setup_links` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 5. The guards -----------------------------------------------------------------------
--    An eligibility is closed, never edited and never deleted: only `closed_at` and `closed_reason` may move, together
--    (the CHECK), and only from NULL.
DROP TRIGGER IF EXISTS `trg_trial_eligibility_update`;
CREATE TRIGGER `trg_trial_eligibility_update`
BEFORE UPDATE ON `trial_eligibilities`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    IF NOT (NEW.`id` <=> OLD.`id`) OR NOT (NEW.`company_id` <=> OLD.`company_id`)
       OR NOT (NEW.`owner_user_id` <=> OLD.`owner_user_id`)
       OR NOT (NEW.`registration_method` <=> OLD.`registration_method`) OR NOT (NEW.`basis` <=> OLD.`basis`)
       OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'trial_eligibilities: an eligibility is never edited — it is only closed, once';
    END IF;
    IF OLD.`closed_at` IS NOT NULL
       AND NOT (NEW.`closed_at` <=> OLD.`closed_at` AND NEW.`closed_reason` <=> OLD.`closed_reason`) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'trial_eligibilities: a closed eligibility is final';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_trial_eligibility_no_delete`;
CREATE TRIGGER `trg_trial_eligibility_no_delete`
BEFORE DELETE ON `trial_eligibilities`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'trial_eligibilities: an eligibility is never deleted — it is closed';
  END IF;
END;

--    A claim is final. Its one later write is the expiry record, NULL → value, once. The text columns are compared as
--    bytes: under the case-insensitive collation `<=>` would let a key or a hash change case unnoticed.
DROP TRIGGER IF EXISTS `trg_trial_claim_update`;
CREATE TRIGGER `trg_trial_claim_update`
BEFORE UPDATE ON `trial_claims`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    IF NOT (NEW.`id` <=> OLD.`id`) OR NOT (NEW.`company_id` <=> OLD.`company_id`)
       OR NOT (NEW.`eligibility_id` <=> OLD.`eligibility_id`) OR NOT (NEW.`claimant_user_id` <=> OLD.`claimant_user_id`)
       OR NOT (NEW.`claimed_at` <=> OLD.`claimed_at`) OR NOT (NEW.`started_at` <=> OLD.`started_at`)
       OR NOT (NEW.`ends_at` <=> OLD.`ends_at`)
       OR NOT (CAST(NEW.`terms_version` AS BINARY) <=> CAST(OLD.`terms_version` AS BINARY))
       OR NOT (CAST(NEW.`idempotency_key` AS BINARY) <=> CAST(OLD.`idempotency_key` AS BINARY))
       OR NOT (CAST(NEW.`request_hash` AS BINARY) <=> CAST(OLD.`request_hash` AS BINARY))
       OR NOT (NEW.`subscription_version_after` <=> OLD.`subscription_version_after`)
       OR NOT (NEW.`setup_link_id` <=> OLD.`setup_link_id`) OR NOT (NEW.`created_at` <=> OLD.`created_at`)
       OR (OLD.`expiry_recorded_at` IS NOT NULL AND NOT (NEW.`expiry_recorded_at` <=> OLD.`expiry_recorded_at`)) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'trial_claims: a claim is never edited — only its expiry is recorded, once';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_trial_claim_no_delete`;
CREATE TRIGGER `trg_trial_claim_no_delete`
BEFORE DELETE ON `trial_claims`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'trial_claims: a claim is never deleted — one trial per business, ever';
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_trial_setup_message_no_update`;
CREATE TRIGGER `trg_trial_setup_message_no_update`
BEFORE UPDATE ON `trial_setup_messages`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'trial_setup_messages is append-only: a send attempt is never edited';
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_trial_setup_message_no_delete`;
CREATE TRIGGER `trg_trial_setup_message_no_delete`
BEFORE DELETE ON `trial_setup_messages`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'trial_setup_messages is append-only: a send attempt is never deleted';
  END IF;
END;

-- 6. The timeline learns the trial ----------------------------------------------------
ALTER TABLE `subscription_events`
  MODIFY `kind` ENUM('created','extended','branches_changed','seats_changed','complimentary_granted','complimentary_revoked','backfilled','registered','administrative_grant','suspended','reinstated','cancelled','approved','rejected','period_corrected','seat_requested','seat_paid','staff_activated','seat_closed','store_requested','activity_requested','activity_changed','activity_scheduled','renewed','trial_eligible','trial_claimed','trial_expired') NOT NULL;
