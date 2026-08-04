-- ===========================================================================
-- 0012_digest_line_identifier — naming cleanup (Sprint 2D.4)
--   Rename the phone-specific digest_lines.imei to the generic `identifier`.
--   Same meaning (the tracked unit's IMEI or serial, null for quantity), but
--   widened 15 -> 64 so it can actually hold serials.
-- ===========================================================================

ALTER TABLE `digest_lines` CHANGE COLUMN `imei` `identifier` VARCHAR(64) NULL;
