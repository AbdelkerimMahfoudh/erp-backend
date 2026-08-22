-- Milestone M: the app now ships a French catalogue, so the Owner summary
-- language gains a matching option.
--
-- Purely additive: an ENUM widened from ('en','ar') to ('en','ar','fr'). No row
-- changes value, the default is untouched, and every existing setting keeps
-- reading exactly as before. Narrowing it back is the destructive direction,
-- which is why the reverse statement below is only safe while no row holds
-- 'fr' -- see docs/22.
--
-- Reverse (only when no company_settings row has whatsapp_language = 'fr'):
--   ALTER TABLE `company_settings`
--     MODIFY COLUMN `whatsapp_language` ENUM('en', 'ar') NOT NULL DEFAULT 'en';

ALTER TABLE `company_settings`
  MODIFY COLUMN `whatsapp_language` ENUM('en', 'ar', 'fr') NOT NULL DEFAULT 'en';
