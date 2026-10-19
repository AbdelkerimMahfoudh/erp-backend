-- ===========================================================================
-- 0100 — The operational WhatsApp consent, recorded as an immutable history (the owner's brief of 2026-10-19; D213).
--
-- Why: registration now always asks for an explicit, versioned agreement to operational Dukan ERP messages on
-- WhatsApp, and every sender refuses a number without a consent to the copy in force. The consent history of 0098
-- (`whatsapp_consents`) already holds the number as a keyed hash and a masked form, the event, the copy's version, its
-- purposes, the business and person acting, the source and the time. Two things were missing:
--
--   1. the language the copy was shown in — a record of what the person read, next to the version of what they agreed
--      to (`locale`; null for rows written before this migration, which never recorded it);
--   2. the guarantee that the history is a history: a grant, a withdrawal or a keyword STOP is never edited or deleted
--      by the application, and re-consent is a new row (triggers, like 0099's grace decisions). The migrator and an
--      operator's maintenance account are not refused, so a counsel-approved erasure policy stays possible.
--
-- The request's address is not stored here: each grant and withdrawal made from an account is an audit event, and
-- `audit_logs.ip` already holds it under the audit log's own rules — one place, not two.
--
-- Additive: no existing row changes and nothing is backfilled. Rows granted to the earlier copy
-- (`wa-consent-2026-10-17`) stay as they are and simply stop counting: the application treats a consent to any copy but
-- the one in force as outdated, so no account is opted in by this migration.
-- ===========================================================================

-- 1. The language the copy was shown in ---------------------------------------------------
ALTER TABLE `whatsapp_consents`
  ADD COLUMN `locale` VARCHAR(5) NULL AFTER `version`;

-- 2. What a row may say ---------------------------------------------------------------------
ALTER TABLE `whatsapp_consents`
  ADD CONSTRAINT `ck_whatsapp_consent_event` CHECK (`event` IN ('granted', 'withdrawn', 'opted_out_optional')),
  ADD CONSTRAINT `ck_whatsapp_consent_grant_version` CHECK (`event` <> 'granted' OR `version` IS NOT NULL),
  ADD CONSTRAINT `ck_whatsapp_consent_locale` CHECK (`locale` IS NULL OR `locale` IN ('en', 'fr', 'ar'));

-- 3. The history is append-only for the application ------------------------------------
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
