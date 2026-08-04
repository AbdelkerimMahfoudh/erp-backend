-- ===========================================================================
-- 0008_units_generalize — generic unit identifier (IMEI or Serial). (2C.5a)
-- imei_primary becomes nullable; a generated `identifier` = COALESCE(imei, serial)
-- with a UNIQUE index enforces global uniqueness for BOTH IMEI and serial units.
-- ===========================================================================

ALTER TABLE `units` MODIFY COLUMN `imei_primary` VARCHAR(15) NULL;

-- Relax the IMEI format check to allow NULL (serial units have no IMEI).
ALTER TABLE `units` DROP CHECK `units_imei_primary_format_chk`;
ALTER TABLE `units` ADD CONSTRAINT `units_imei_primary_format_chk`
  CHECK (`imei_primary` IS NULL OR `imei_primary` REGEXP '^[0-9]{15}$');

-- Universal identifier + uniqueness (replaces the IMEI-only unique index).
ALTER TABLE `units`
  ADD COLUMN `identifier` VARCHAR(64)
  GENERATED ALWAYS AS (COALESCE(`imei_primary`, `serial_no`)) STORED AFTER `serial_no`;
DROP INDEX `units_imei_primary_key` ON `units`;
CREATE UNIQUE INDEX `ux_units_identifier` ON `units`(`identifier`);
