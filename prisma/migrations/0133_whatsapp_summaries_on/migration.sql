-- 0133: the Owner's WhatsApp summaries are on by default (owner, 2026-11-07), for new businesses and for every
-- existing one. The daily and monthly summaries are now sent (closing.summary / closing.monthly), each only while its
-- switch stays on; an Owner can still turn either off. Amounts stay off unless chosen. Additive: older code reads the
-- same booleans, so no rollback floor.
ALTER TABLE `company_settings`
  ALTER COLUMN `whatsapp_daily_enabled` SET DEFAULT 1,
  ALTER COLUMN `whatsapp_monthly_enabled` SET DEFAULT 1;

UPDATE `company_settings` SET `whatsapp_daily_enabled` = 1, `whatsapp_monthly_enabled` = 1;
