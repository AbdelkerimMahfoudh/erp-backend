-- ===========================================================================
-- 0063 — models sort the way a shopkeeper reads them.
--
-- The defect
-- ----------
-- `release_rank` was the release YEAR and was also doing duty as the display
-- order. It cannot do both, and the catalogue showed exactly why:
--
--   * `iPhone 16e` (2025) sorted ABOVE `iPhone 17` (2025), because models
--     sharing a year fell back to alphabetical order;
--   * `iPhone 17e` (2026) sat alone at the top, split from the `iPhone 17`
--     family it belongs to, because it shipped in a later year.
--
-- A family spans years. Ordering by family and ordering by date are two
-- different orderings, and one integer cannot express both — so this adds a
-- second column rather than overloading the first. The release year stays
-- exactly where it was and stays separately queryable, because a phone's
-- release year is real curated data that would have to be curated again.
--
-- The order
-- ---------
-- Newest family first; within a family the premium variant first — Pro Max,
-- Pro, Air/Plus, standard, then value variants (`e`, mini, SE). Samsung reads
-- Ultra, Plus, standard, FE. `display_rank` is derived from each model's
-- POSITION in its brand's list, so correcting the order means moving a line.
--
-- Ranks are spaced by ten so a model can be slipped between two others without
-- renumbering the brand. Every model has a distinct rank, so there is no
-- tie-break — which is what stops the order changing with the language.
--
-- Existing data
-- -------------
-- One column added with a default, then one UPDATE per model keyed on
-- (brand, name). No row is created, renamed or deleted. `release_rank` is not
-- touched. A rerun sets the same values.
--
-- Provenance
-- ----------
-- Generated from `src/catalog/device-catalogue.ts` by
-- `scripts/generate-display-order-migration.ts`.
-- ===========================================================================

SET @have := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'device_models'
                AND column_name = 'display_rank');
SET @sql := IF(@have = 0,
  'ALTER TABLE `device_models` ADD COLUMN `display_rank` INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @haveIx := (SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'device_models'
                  AND index_name = 'ix_device_models_brand_active_display');
SET @sql := IF(@haveIx = 0,
  'CREATE INDEX `ix_device_models_brand_active_display`
     ON `device_models` (`brand_key`, `is_active`, `display_rank`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── The order itself ──────────────────────────────────────────────────────

UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 17 Pro Max';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 17 Pro';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'apple' AND `name` = 'iPhone Air';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 17';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 17e';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16 Pro Max';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16 Pro';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16 Plus';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16e';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 15 Pro Max';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 15 Pro';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 15 Plus';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 15';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 14 Pro Max';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 14 Pro';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 14 Plus';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 14';
UPDATE `device_models` SET `display_rank` = 99820 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 13 Pro Max';
UPDATE `device_models` SET `display_rank` = 99810 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 13 Pro';
UPDATE `device_models` SET `display_rank` = 99800 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 13';
UPDATE `device_models` SET `display_rank` = 99790 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 13 mini';
UPDATE `device_models` SET `display_rank` = 99780 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 12 Pro Max';
UPDATE `device_models` SET `display_rank` = 99770 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 12 Pro';
UPDATE `device_models` SET `display_rank` = 99760 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 12';
UPDATE `device_models` SET `display_rank` = 99750 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 12 mini';
UPDATE `device_models` SET `display_rank` = 99740 WHERE `brand_key` = 'apple' AND `name` = 'iPhone SE (3rd generation)';
UPDATE `device_models` SET `display_rank` = 99730 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 11 Pro Max';
UPDATE `device_models` SET `display_rank` = 99720 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 11 Pro';
UPDATE `device_models` SET `display_rank` = 99710 WHERE `brand_key` = 'apple' AND `name` = 'iPhone 11';
UPDATE `device_models` SET `display_rank` = 99700 WHERE `brand_key` = 'apple' AND `name` = 'iPhone SE (2nd generation)';
UPDATE `device_models` SET `display_rank` = 99690 WHERE `brand_key` = 'apple' AND `name` = 'iPhone XS Max';
UPDATE `device_models` SET `display_rank` = 99680 WHERE `brand_key` = 'apple' AND `name` = 'iPhone XS';
UPDATE `device_models` SET `display_rank` = 99670 WHERE `brand_key` = 'apple' AND `name` = 'iPhone XR';
UPDATE `device_models` SET `display_rank` = 99660 WHERE `brand_key` = 'apple' AND `name` = 'iPhone X';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S26 Ultra';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S26+';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S26';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S25 Ultra';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S25+';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S25';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S25 FE';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S24 Ultra';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S24+';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S24';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S24 FE';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S23 Ultra';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S23+';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S23';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S23 FE';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S22 Ultra';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S22+';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S22';
UPDATE `device_models` SET `display_rank` = 99820 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S21 Ultra';
UPDATE `device_models` SET `display_rank` = 99810 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S21+';
UPDATE `device_models` SET `display_rank` = 99800 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S21';
UPDATE `device_models` SET `display_rank` = 99790 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S21 FE';
UPDATE `device_models` SET `display_rank` = 99780 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold7';
UPDATE `device_models` SET `display_rank` = 99770 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip7';
UPDATE `device_models` SET `display_rank` = 99760 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold6';
UPDATE `device_models` SET `display_rank` = 99750 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip6';
UPDATE `device_models` SET `display_rank` = 99740 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold5';
UPDATE `device_models` SET `display_rank` = 99730 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip5';
UPDATE `device_models` SET `display_rank` = 99720 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold4';
UPDATE `device_models` SET `display_rank` = 99710 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip4';
UPDATE `device_models` SET `display_rank` = 99700 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold3';
UPDATE `device_models` SET `display_rank` = 99690 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip3';
UPDATE `device_models` SET `display_rank` = 99680 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A56';
UPDATE `device_models` SET `display_rank` = 99670 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A36';
UPDATE `device_models` SET `display_rank` = 99660 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A26';
UPDATE `device_models` SET `display_rank` = 99650 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A16';
UPDATE `device_models` SET `display_rank` = 99640 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A06';
UPDATE `device_models` SET `display_rank` = 99630 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A55';
UPDATE `device_models` SET `display_rank` = 99620 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A35';
UPDATE `device_models` SET `display_rank` = 99610 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A25';
UPDATE `device_models` SET `display_rank` = 99600 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A15';
UPDATE `device_models` SET `display_rank` = 99590 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A05';
UPDATE `device_models` SET `display_rank` = 99580 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A54';
UPDATE `device_models` SET `display_rank` = 99570 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A34';
UPDATE `device_models` SET `display_rank` = 99560 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A24';
UPDATE `device_models` SET `display_rank` = 99550 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A14';
UPDATE `device_models` SET `display_rank` = 99540 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A04';
UPDATE `device_models` SET `display_rank` = 99530 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A53';
UPDATE `device_models` SET `display_rank` = 99520 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A33';
UPDATE `device_models` SET `display_rank` = 99510 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A23';
UPDATE `device_models` SET `display_rank` = 99500 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A13';
UPDATE `device_models` SET `display_rank` = 99490 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A03';
UPDATE `device_models` SET `display_rank` = 99480 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A52';
UPDATE `device_models` SET `display_rank` = 99470 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A32';
UPDATE `device_models` SET `display_rank` = 99460 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A22';
UPDATE `device_models` SET `display_rank` = 99450 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A12';
UPDATE `device_models` SET `display_rank` = 99440 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A02';
UPDATE `device_models` SET `display_rank` = 99430 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M55';
UPDATE `device_models` SET `display_rank` = 99420 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M35';
UPDATE `device_models` SET `display_rank` = 99410 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M15';
UPDATE `device_models` SET `display_rank` = 99400 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M14';
UPDATE `device_models` SET `display_rank` = 99390 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M13';
UPDATE `device_models` SET `display_rank` = 99380 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M12';
UPDATE `device_models` SET `display_rank` = 99370 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Note20 Ultra';
UPDATE `device_models` SET `display_rank` = 99360 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Note20';
UPDATE `device_models` SET `display_rank` = 99350 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Note10+';
UPDATE `device_models` SET `display_rank` = 99340 WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Note10';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 15 Ultra';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 15';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 14T Pro';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 14T';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 14 Ultra';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 14';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 13T Pro';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 13T';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 13 Pro';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 13';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 12T Pro';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 12T';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 12';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 11T Pro';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 11T';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'xiaomi' AND `name` = 'Mi 11';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'xiaomi' AND `name` = 'Mi 10';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 14 Pro+';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 14 Pro';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 14';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 13 Pro+';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 13 Pro';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 13';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 12 Pro+';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 12 Pro';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 12';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 11 Pro';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 11';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 10 Pro';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 10';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 9';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 14C';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 13C';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 13';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 12C';
UPDATE `device_models` SET `display_rank` = 99820 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 12';
UPDATE `device_models` SET `display_rank` = 99810 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 10C';
UPDATE `device_models` SET `display_rank` = 99800 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 10';
UPDATE `device_models` SET `display_rank` = 99790 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 9A';
UPDATE `device_models` SET `display_rank` = 99780 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 9C';
UPDATE `device_models` SET `display_rank` = 99770 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi A3';
UPDATE `device_models` SET `display_rank` = 99760 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi A2';
UPDATE `device_models` SET `display_rank` = 99750 WHERE `brand_key` = 'redmi' AND `name` = 'Redmi A1';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'poco' AND `name` = 'POCO F7 Pro';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'poco' AND `name` = 'POCO F6 Pro';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'poco' AND `name` = 'POCO F6';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'poco' AND `name` = 'POCO F5 Pro';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'poco' AND `name` = 'POCO F5';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'poco' AND `name` = 'POCO F4';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'poco' AND `name` = 'POCO X7 Pro';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'poco' AND `name` = 'POCO X6 Pro';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'poco' AND `name` = 'POCO X6';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'poco' AND `name` = 'POCO X5 Pro';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'poco' AND `name` = 'POCO X5';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'poco' AND `name` = 'POCO X4 Pro';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'poco' AND `name` = 'POCO M6 Pro';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'poco' AND `name` = 'POCO M6';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'poco' AND `name` = 'POCO M5';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'poco' AND `name` = 'POCO M4 Pro';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'poco' AND `name` = 'POCO C75';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'poco' AND `name` = 'POCO C65';
UPDATE `device_models` SET `display_rank` = 99820 WHERE `brand_key` = 'poco' AND `name` = 'POCO C55';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'tecno' AND `name` = 'Phantom V Fold2';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'tecno' AND `name` = 'Phantom V Flip2';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'tecno' AND `name` = 'Phantom V Fold';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'tecno' AND `name` = 'Phantom X2 Pro';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'tecno' AND `name` = 'Phantom X2';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'tecno' AND `name` = 'Camon 40 Pro';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'tecno' AND `name` = 'Camon 40';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'tecno' AND `name` = 'Camon 30 Pro';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'tecno' AND `name` = 'Camon 30';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'tecno' AND `name` = 'Camon 20 Pro';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'tecno' AND `name` = 'Camon 20';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'tecno' AND `name` = 'Camon 19 Pro';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'tecno' AND `name` = 'Pova 6 Pro';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'tecno' AND `name` = 'Pova 6';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'tecno' AND `name` = 'Pova 5 Pro';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'tecno' AND `name` = 'Pova 5';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'tecno' AND `name` = 'Pova 4';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'tecno' AND `name` = 'Spark 30 Pro';
UPDATE `device_models` SET `display_rank` = 99820 WHERE `brand_key` = 'tecno' AND `name` = 'Spark 30';
UPDATE `device_models` SET `display_rank` = 99810 WHERE `brand_key` = 'tecno' AND `name` = 'Spark 20 Pro';
UPDATE `device_models` SET `display_rank` = 99800 WHERE `brand_key` = 'tecno' AND `name` = 'Spark 20';
UPDATE `device_models` SET `display_rank` = 99790 WHERE `brand_key` = 'tecno' AND `name` = 'Spark 10 Pro';
UPDATE `device_models` SET `display_rank` = 99780 WHERE `brand_key` = 'tecno' AND `name` = 'Spark 10';
UPDATE `device_models` SET `display_rank` = 99770 WHERE `brand_key` = 'tecno' AND `name` = 'Spark 9';
UPDATE `device_models` SET `display_rank` = 99760 WHERE `brand_key` = 'tecno' AND `name` = 'Spark Go 2024';
UPDATE `device_models` SET `display_rank` = 99750 WHERE `brand_key` = 'tecno' AND `name` = 'Pop 8';
UPDATE `device_models` SET `display_rank` = 99740 WHERE `brand_key` = 'tecno' AND `name` = 'Pop 7';
UPDATE `device_models` SET `display_rank` = 99730 WHERE `brand_key` = 'tecno' AND `name` = 'Pop 6';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'infinix' AND `name` = 'Zero 40';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'infinix' AND `name` = 'Zero 30';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'infinix' AND `name` = 'Zero 20';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'infinix' AND `name` = 'GT 20 Pro';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'infinix' AND `name` = 'GT 10 Pro';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'infinix' AND `name` = 'Note 40 Pro+';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'infinix' AND `name` = 'Note 40 Pro';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'infinix' AND `name` = 'Note 40';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'infinix' AND `name` = 'Note 30 Pro';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'infinix' AND `name` = 'Note 30';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'infinix' AND `name` = 'Note 12';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'infinix' AND `name` = 'Hot 50 Pro';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'infinix' AND `name` = 'Hot 50';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'infinix' AND `name` = 'Hot 40 Pro';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'infinix' AND `name` = 'Hot 40';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'infinix' AND `name` = 'Hot 30';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'infinix' AND `name` = 'Hot 20';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'infinix' AND `name` = 'Hot 12';
UPDATE `device_models` SET `display_rank` = 99820 WHERE `brand_key` = 'infinix' AND `name` = 'Smart 9';
UPDATE `device_models` SET `display_rank` = 99810 WHERE `brand_key` = 'infinix' AND `name` = 'Smart 8';
UPDATE `device_models` SET `display_rank` = 99800 WHERE `brand_key` = 'infinix' AND `name` = 'Smart 7';
UPDATE `device_models` SET `display_rank` = 99790 WHERE `brand_key` = 'infinix' AND `name` = 'Smart 6';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'itel' AND `name` = 'City 100';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'itel' AND `name` = 'Super 30';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'itel' AND `name` = 'Super 27';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'itel' AND `name` = 'Super 25';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'itel' AND `name` = 'S25 Ultra';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'itel' AND `name` = 'S25';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'itel' AND `name` = 'S24';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'itel' AND `name` = 'S23+';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'itel' AND `name` = 'S23';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'itel' AND `name` = 'A80';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'itel' AND `name` = 'A70';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'itel' AND `name` = 'A60s';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'itel' AND `name` = 'A60';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'itel' AND `name` = 'A50';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'itel' AND `name` = 'Power 70';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'itel' AND `name` = 'P55';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'itel' AND `name` = 'P40';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'itel' AND `name` = 'RS4';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'oppo' AND `name` = 'Find X8 Pro';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'oppo' AND `name` = 'Find X8';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'oppo' AND `name` = 'Find X7 Ultra';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'oppo' AND `name` = 'Find X6 Pro';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'oppo' AND `name` = 'Find X5 Pro';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'oppo' AND `name` = 'Find N5';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'oppo' AND `name` = 'Find N3';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'oppo' AND `name` = 'Find N3 Flip';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'oppo' AND `name` = 'Reno13 Pro';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'oppo' AND `name` = 'Reno13';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'oppo' AND `name` = 'Reno12 Pro';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'oppo' AND `name` = 'Reno12';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'oppo' AND `name` = 'Reno11 Pro';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'oppo' AND `name` = 'Reno11';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'oppo' AND `name` = 'Reno10 Pro';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'oppo' AND `name` = 'Reno10';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'oppo' AND `name` = 'Reno8';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'oppo' AND `name` = 'Reno7';
UPDATE `device_models` SET `display_rank` = 99820 WHERE `brand_key` = 'oppo' AND `name` = 'A80';
UPDATE `device_models` SET `display_rank` = 99810 WHERE `brand_key` = 'oppo' AND `name` = 'A60';
UPDATE `device_models` SET `display_rank` = 99800 WHERE `brand_key` = 'oppo' AND `name` = 'A58';
UPDATE `device_models` SET `display_rank` = 99790 WHERE `brand_key` = 'oppo' AND `name` = 'A38';
UPDATE `device_models` SET `display_rank` = 99780 WHERE `brand_key` = 'oppo' AND `name` = 'A18';
UPDATE `device_models` SET `display_rank` = 99770 WHERE `brand_key` = 'oppo' AND `name` = 'A78';
UPDATE `device_models` SET `display_rank` = 99760 WHERE `brand_key` = 'oppo' AND `name` = 'A57';
UPDATE `device_models` SET `display_rank` = 99750 WHERE `brand_key` = 'oppo' AND `name` = 'A17';
UPDATE `device_models` SET `display_rank` = 99740 WHERE `brand_key` = 'oppo' AND `name` = 'A16';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'realme' AND `name` = 'GT 7 Pro';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'realme' AND `name` = 'GT 6';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'realme' AND `name` = 'GT 5 Pro';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'realme' AND `name` = 'GT Neo 5';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'realme' AND `name` = 'realme 13 Pro+';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'realme' AND `name` = 'realme 13 Pro';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'realme' AND `name` = 'realme 12 Pro+';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'realme' AND `name` = 'realme 12 Pro';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'realme' AND `name` = 'realme 12';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'realme' AND `name` = 'realme 11 Pro+';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'realme' AND `name` = 'realme 11 Pro';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'realme' AND `name` = 'realme 11';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'realme' AND `name` = 'realme 10';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'realme' AND `name` = 'realme 9';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'realme' AND `name` = 'C75';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'realme' AND `name` = 'C65';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'realme' AND `name` = 'C55';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'realme' AND `name` = 'C53';
UPDATE `device_models` SET `display_rank` = 99820 WHERE `brand_key` = 'realme' AND `name` = 'C35';
UPDATE `device_models` SET `display_rank` = 99810 WHERE `brand_key` = 'realme' AND `name` = 'C33';
UPDATE `device_models` SET `display_rank` = 99800 WHERE `brand_key` = 'realme' AND `name` = 'C30';
UPDATE `device_models` SET `display_rank` = 99790 WHERE `brand_key` = 'realme' AND `name` = 'Note 60';
UPDATE `device_models` SET `display_rank` = 99780 WHERE `brand_key` = 'realme' AND `name` = 'Note 50';
UPDATE `device_models` SET `display_rank` = 99770 WHERE `brand_key` = 'realme' AND `name` = 'P1 Pro';
UPDATE `device_models` SET `display_rank` = 99760 WHERE `brand_key` = 'realme' AND `name` = 'P1';
UPDATE `device_models` SET `display_rank` = 99750 WHERE `brand_key` = 'realme' AND `name` = 'Narzo 70 Pro';
UPDATE `device_models` SET `display_rank` = 99740 WHERE `brand_key` = 'realme' AND `name` = 'Narzo 60';
UPDATE `device_models` SET `display_rank` = 99730 WHERE `brand_key` = 'realme' AND `name` = 'Narzo 50';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'huawei' AND `name` = 'Pura 70 Ultra';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'huawei' AND `name` = 'Pura 70 Pro';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'huawei' AND `name` = 'Pura 70';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'huawei' AND `name` = 'P60 Pro';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'huawei' AND `name` = 'P50 Pro';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'huawei' AND `name` = 'P40 Pro';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'huawei' AND `name` = 'P30 Pro';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'huawei' AND `name` = 'Mate 60 Pro';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'huawei' AND `name` = 'Mate 50 Pro';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'huawei' AND `name` = 'Mate X5';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'huawei' AND `name` = 'Mate 40 Pro';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'huawei' AND `name` = 'nova 13';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'huawei' AND `name` = 'nova 12';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'huawei' AND `name` = 'nova 11';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'huawei' AND `name` = 'nova 10';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'huawei' AND `name` = 'nova 9';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'huawei' AND `name` = 'Y9a';
UPDATE `device_models` SET `display_rank` = 99830 WHERE `brand_key` = 'huawei' AND `name` = 'Y7a';
UPDATE `device_models` SET `display_rank` = 99820 WHERE `brand_key` = 'huawei' AND `name` = 'Y6p';
UPDATE `device_models` SET `display_rank` = 100000 WHERE `brand_key` = 'honor' AND `name` = 'Magic7 Pro';
UPDATE `device_models` SET `display_rank` = 99990 WHERE `brand_key` = 'honor' AND `name` = 'Magic7';
UPDATE `device_models` SET `display_rank` = 99980 WHERE `brand_key` = 'honor' AND `name` = 'Magic6 Pro';
UPDATE `device_models` SET `display_rank` = 99970 WHERE `brand_key` = 'honor' AND `name` = 'Magic5 Pro';
UPDATE `device_models` SET `display_rank` = 99960 WHERE `brand_key` = 'honor' AND `name` = 'Magic V3';
UPDATE `device_models` SET `display_rank` = 99950 WHERE `brand_key` = 'honor' AND `name` = 'Magic V2';
UPDATE `device_models` SET `display_rank` = 99940 WHERE `brand_key` = 'honor' AND `name` = 'Honor 200 Pro';
UPDATE `device_models` SET `display_rank` = 99930 WHERE `brand_key` = 'honor' AND `name` = 'Honor 200';
UPDATE `device_models` SET `display_rank` = 99920 WHERE `brand_key` = 'honor' AND `name` = 'Honor 90';
UPDATE `device_models` SET `display_rank` = 99910 WHERE `brand_key` = 'honor' AND `name` = 'Honor 70';
UPDATE `device_models` SET `display_rank` = 99900 WHERE `brand_key` = 'honor' AND `name` = 'X9c';
UPDATE `device_models` SET `display_rank` = 99890 WHERE `brand_key` = 'honor' AND `name` = 'X9b';
UPDATE `device_models` SET `display_rank` = 99880 WHERE `brand_key` = 'honor' AND `name` = 'X8b';
UPDATE `device_models` SET `display_rank` = 99870 WHERE `brand_key` = 'honor' AND `name` = 'X7b';
UPDATE `device_models` SET `display_rank` = 99860 WHERE `brand_key` = 'honor' AND `name` = 'X6b';
UPDATE `device_models` SET `display_rank` = 99850 WHERE `brand_key` = 'honor' AND `name` = 'X8a';
UPDATE `device_models` SET `display_rank` = 99840 WHERE `brand_key` = 'honor' AND `name` = 'X7a';
