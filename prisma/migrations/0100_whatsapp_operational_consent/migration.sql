-- ===========================================================================
-- 0100 — The operational WhatsApp consent, recorded as an immutable history with a lifecycle (the owner's briefs of
--        2026-10-19; D213).
--
-- Why: registration, an employee's activation and a number change now ask for an explicit, versioned agreement to
-- operational Dukan ERP messages on WhatsApp, and every sender refuses a number without a consent in force. The consent
-- history of 0098 (`whatsapp_consents`) already holds the number as a keyed hash and a masked form, the event, the copy's
-- version, its purposes, the business and person acting, the source and the time. Three things were missing:
--
--   1. the language the copy was shown in — a record of what the person read, next to the version of what they agreed
--      to (`locale`; null for rows written before this migration, which never recorded it);
--   2. the difference between a box ticked and a number proved. The agreement is recorded when the person ticks it and
--      asks for a code (`pending_unverified`); it becomes the consent in force (`active`) only when that number is
--      verified, in the same transaction, as a new row naming the pending row it concludes (`pending_id`). A pending row
--      left unverified for 24 hours is concluded `expired`; one whose employee invitation the Owner cancels or replaces
--      is concluded `cancelled` (0101). UNIQUE (`pending_id`) lets a pending agreement be concluded exactly once — a
--      verification racing a retry, a cancellation or the expiry sweep writes one conclusion and the others lose;
--   3. the guarantee that the history is a history: no decision is ever edited or deleted by the application, and
--      re-consent, withdrawal, a replaced number (`superseded`) and expiry are new rows (triggers, like 0099's grace
--      decisions). The migrator and an operator's maintenance account are not refused, so a counsel-approved erasure
--      policy stays possible.
--
-- The request's address is not stored here: each grant, activation and withdrawal made from an account is an audit
-- event, and `audit_logs.ip` already holds it under the audit log's own rules — one place, not two.
--
-- Additive: no existing row changes and nothing is backfilled. Rows of 0098 (`granted` to the earlier copy
-- `wa-consent-2026-10-17`, `opted_out_optional`, `withdrawn`) stay as they are and count for nothing: the application
-- treats a consent to any copy but the one in force as outdated, so no account is opted in by this migration.
-- ===========================================================================

-- 1. The language shown, and the pending agreement a conclusion names ----------------------
ALTER TABLE `whatsapp_consents`
  ADD COLUMN `locale` VARCHAR(5) NULL AFTER `version`,
  ADD COLUMN `pending_id` BINARY(16) NULL AFTER `locale`;

-- 2. A pending agreement is concluded once: activated, expired or cancelled — one of them, never twice ----
CREATE UNIQUE INDEX `ux_whatsapp_consents_pending` ON `whatsapp_consents` (`pending_id`);

-- 3. What a row may say -----------------------------------------------------------------------
ALTER TABLE `whatsapp_consents`
  ADD CONSTRAINT `ck_whatsapp_consent_event`
    CHECK (`event` IN ('pending_unverified', 'active', 'withdrawn', 'superseded', 'expired', 'cancelled', 'granted', 'opted_out_optional')),
  ADD CONSTRAINT `ck_whatsapp_consent_grant_version`
    CHECK (`event` NOT IN ('pending_unverified', 'active', 'granted') OR `version` IS NOT NULL),
  ADD CONSTRAINT `ck_whatsapp_consent_conclusion`
    CHECK ((`event` IN ('expired', 'cancelled') AND `pending_id` IS NOT NULL) OR `event` = 'active'
           OR (`event` NOT IN ('expired', 'cancelled') AND `pending_id` IS NULL)),
  ADD CONSTRAINT `ck_whatsapp_consent_locale` CHECK (`locale` IS NULL OR `locale` IN ('en', 'fr', 'ar'));

-- 4. The history is append-only for the application -----------------------------------------
DROP TRIGGER IF EXISTS `trg_whatsapp_consent_no_update`;
CREATE TRIGGER `trg_whatsapp_consent_no_update`
BEFORE UPDATE ON `whatsapp_consents`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'whatsapp_consents is immutable: a consent decision is never edited';
  END IF;
END;

DROP TRIGGER IF EXISTS `trg_whatsapp_consent_no_delete`;
CREATE TRIGGER `trg_whatsapp_consent_no_delete`
BEFORE DELETE ON `whatsapp_consents`
FOR EACH ROW
BEGIN
  IF USER() LIKE 'phonestore\_app@%' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'whatsapp_consents is immutable: a consent decision is never deleted';
  END IF;
END;
