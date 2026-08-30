-- ===========================================================================
-- 0062 — the device catalogue: phone brands, phone models, and what a TAC means.
--
-- Two things at once, deliberately: the tables, and the reference data that
-- makes them useful. A catalogue table with no rows in it is a feature nobody
-- can use, and the permission catalogue (0059) taught this codebase exactly
-- what happens when reference data lives only in a demo seed — staging, the
-- first environment built without the seed, was the first to show the gap.
--
-- What this is
-- ------------
-- **Curated reference data, not an authoritative device database.** It covers
-- the brands traded in this market and the generations still moving
-- second-hand. It is NOT every regional SKU and never claims to be: a
-- shopkeeper who cannot find their handset types the name in, and that is a
-- first-class outcome rather than a failure.
--
-- Broad production coverage — every SKU, every region, every TAC — needs
-- LICENSED GSMA data. That is a commercial arrangement, not a scraping job.
--
-- What a model is not
-- -------------------
-- Storage, colour, cosmetic condition and an individual IMEI are NOT models.
-- `products.variant` already carries storage and colour and the unit carries
-- the identifier, so folding them in would multiply the catalogue by every SKU
-- and make search and reporting worthless.
--
-- Existing data
-- -------------
-- No existing row is modified. No product is renamed. `tac_catalog` gains
-- columns with defaults, so every row already in it keeps its brand and model
-- and simply becomes `curated` and active. Legacy free-text product brands and
-- models continue to work untouched — the catalogue is a source of CHOICES,
-- not a constraint on what a product may be called.
--
-- Semantics
-- ---------
--   * clean install: creates two tables, extends a third, inserts 13 brands
--     and 323 models;
--   * rerun: inserts nothing and changes nothing;
--   * upgrade: adds only what is missing.
--
-- Provenance
-- ----------
-- Generated from `src/catalog/device-catalogue.ts` by
-- `scripts/generate-device-catalogue-migration.ts`. Reviewed 2026-08-30.
-- ===========================================================================

-- ── Schema ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `device_brands` (
  `key`           VARCHAR(40)  NOT NULL,
  `name`          VARCHAR(80)  NOT NULL,
  `search_terms`  VARCHAR(400) NOT NULL,
  `display_order` INT          NOT NULL,
  `parent_key`    VARCHAR(40)  NULL,
  `is_active`     TINYINT(1)   NOT NULL DEFAULT 1,
  `source`        ENUM('official','curated','company_confirmed','synthetic_staging') NOT NULL DEFAULT 'curated',
  `reviewed_on`   DATE         NOT NULL,
  `created_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`key`),
  KEY `ix_device_brands_active_order` (`is_active`, `display_order`),
  CONSTRAINT `fk_device_brands_parent` FOREIGN KEY (`parent_key`)
    REFERENCES `device_brands` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `device_models` (
  `id`           INT          NOT NULL AUTO_INCREMENT,
  `brand_key`    VARCHAR(40)  NOT NULL,
  `name`         VARCHAR(120) NOT NULL,
  `family`       VARCHAR(80)  NOT NULL,
  `release_rank` INT          NOT NULL,
  `search_terms` VARCHAR(400) NOT NULL,
  `is_active`    TINYINT(1)   NOT NULL DEFAULT 1,
  `source`       ENUM('official','curated','company_confirmed','synthetic_staging') NOT NULL DEFAULT 'curated',
  `reviewed_on`  DATE         NOT NULL,
  `created_at`   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_device_models_brand_name` (`brand_key`, `name`),
  KEY `ix_device_models_brand_active_rank` (`brand_key`, `is_active`, `release_rank`),
  CONSTRAINT `fk_device_models_brand` FOREIGN KEY (`brand_key`)
    REFERENCES `device_brands` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `tac_catalog` gains provenance. Existing rows keep their brand and model and
-- become curated and active, which is what they always implicitly were.
SET @have := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'tac_catalog'
                AND column_name = 'source');
SET @sql := IF(@have = 0,
  'ALTER TABLE `tac_catalog`
     ADD COLUMN `brand_key`   VARCHAR(40) NULL,
     ADD COLUMN `model_id`    INT NULL,
     ADD COLUMN `source`      ENUM(''official'',''curated'',''company_confirmed'',''synthetic_staging'') NOT NULL DEFAULT ''curated'',
     ADD COLUMN `is_active`   TINYINT(1) NOT NULL DEFAULT 1,
     ADD COLUMN `reviewed_on` DATE NULL,
     ADD KEY `ix_tac_catalog_source` (`source`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Reference data ────────────────────────────────────────────────────────


-- Brands. Parents are inserted before children, so the foreign key holds.

INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','Apple','apple apple iphone',1,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'apple');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Samsung','samsung samsung galaxy',2,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'samsung');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi','xiaomi xiaomi mi',3,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'xiaomi');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Tecno','tecno tecno tecno mobile',6,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'tecno');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Infinix','infinix infinix',7,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'infinix');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','itel','itel itel itel mobile',8,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'itel');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','OPPO','oppo oppo',9,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'oppo');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme','realme realme',10,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'realme');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Huawei','huawei huawei',11,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'huawei');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Honor','honor honor',12,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'honor');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'other','Other brand','other brand other unknown autre',999,NULL,1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'other');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi','redmi redmi',4,'xiaomi',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'redmi');
INSERT INTO `device_brands` (`key`,`name`,`search_terms`,`display_order`,`parent_key`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO','poco poco pocophone',5,'xiaomi',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_brands` WHERE `key` = 'poco');

-- Models.

INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 17 Pro Max','iPhone 17',2025,'iphone 17 pro max iphone 17',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 17 Pro Max');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 17 Pro','iPhone 17',2025,'iphone 17 pro iphone 17',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 17 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone Air','iPhone Air',2025,'iphone air iphone air',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone Air');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 17','iPhone 17',2025,'iphone 17 iphone 17',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 17');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 17e','iPhone 17',2026,'iphone 17 e iphone 17',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 17e');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 16 Pro Max','iPhone 16',2024,'iphone 16 pro max iphone 16',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16 Pro Max');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 16 Pro','iPhone 16',2024,'iphone 16 pro iphone 16',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 16 Plus','iPhone 16',2024,'iphone 16 plus iphone 16',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16 Plus');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 16','iPhone 16',2024,'iphone 16 iphone 16',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 16e','iPhone 16',2025,'iphone 16 e iphone 16',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 16e');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 15 Pro Max','iPhone 15',2023,'iphone 15 pro max iphone 15',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 15 Pro Max');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 15 Pro','iPhone 15',2023,'iphone 15 pro iphone 15',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 15 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 15 Plus','iPhone 15',2023,'iphone 15 plus iphone 15',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 15 Plus');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 15','iPhone 15',2023,'iphone 15 iphone 15',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 15');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 14 Pro Max','iPhone 14',2022,'iphone 14 pro max iphone 14',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 14 Pro Max');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 14 Pro','iPhone 14',2022,'iphone 14 pro iphone 14',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 14 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 14 Plus','iPhone 14',2022,'iphone 14 plus iphone 14',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 14 Plus');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 14','iPhone 14',2022,'iphone 14 iphone 14',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 14');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 13 Pro Max','iPhone 13',2021,'iphone 13 pro max iphone 13',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 13 Pro Max');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 13 Pro','iPhone 13',2021,'iphone 13 pro iphone 13',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 13 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 13 mini','iPhone 13',2021,'iphone 13 mini iphone 13',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 13 mini');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 13','iPhone 13',2021,'iphone 13 iphone 13',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 13');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 12 Pro Max','iPhone 12',2020,'iphone 12 pro max iphone 12',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 12 Pro Max');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 12 Pro','iPhone 12',2020,'iphone 12 pro iphone 12',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 12 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 12 mini','iPhone 12',2020,'iphone 12 mini iphone 12',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 12 mini');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 12','iPhone 12',2020,'iphone 12 iphone 12',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone SE (3rd generation)','iPhone SE',2022,'iphone se 3 rd generation iphone se iphone se 2022 se 3',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone SE (3rd generation)');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 11 Pro Max','iPhone 11',2019,'iphone 11 pro max iphone 11',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 11 Pro Max');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 11 Pro','iPhone 11',2019,'iphone 11 pro iphone 11',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 11 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone 11','iPhone 11',2019,'iphone 11 iphone 11',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone 11');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone SE (2nd generation)','iPhone SE',2020,'iphone se 2 nd generation iphone se iphone se 2020 se 2',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone SE (2nd generation)');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone XS Max','iPhone X',2018,'iphone xs max iphone x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone XS Max');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone XS','iPhone X',2018,'iphone xs iphone x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone XS');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone XR','iPhone X',2018,'iphone xr iphone x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone XR');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'apple','iPhone X','iPhone X',2017,'iphone x iphone x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'apple' AND `name` = 'iPhone X');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S26 Ultra','Galaxy S',2026,'galaxy s 26 ultra galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S26 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S26+','Galaxy S',2026,'galaxy s 26 galaxy s galaxy s 26 plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S26+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S26','Galaxy S',2026,'galaxy s 26 galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S26');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S25 Ultra','Galaxy S',2025,'galaxy s 25 ultra galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S25 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S25+','Galaxy S',2025,'galaxy s 25 galaxy s galaxy s 25 plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S25+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S25','Galaxy S',2025,'galaxy s 25 galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S25');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S25 FE','Galaxy S',2025,'galaxy s 25 fe galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S25 FE');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S24 Ultra','Galaxy S',2024,'galaxy s 24 ultra galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S24 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S24+','Galaxy S',2024,'galaxy s 24 galaxy s galaxy s 24 plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S24+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S24','Galaxy S',2024,'galaxy s 24 galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S24');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S24 FE','Galaxy S',2024,'galaxy s 24 fe galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S24 FE');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S23 Ultra','Galaxy S',2023,'galaxy s 23 ultra galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S23 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S23+','Galaxy S',2023,'galaxy s 23 galaxy s galaxy s 23 plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S23+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S23','Galaxy S',2023,'galaxy s 23 galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S23');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S23 FE','Galaxy S',2023,'galaxy s 23 fe galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S23 FE');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S22 Ultra','Galaxy S',2022,'galaxy s 22 ultra galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S22 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S22+','Galaxy S',2022,'galaxy s 22 galaxy s galaxy s 22 plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S22+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S22','Galaxy S',2022,'galaxy s 22 galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S22');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S21 Ultra','Galaxy S',2021,'galaxy s 21 ultra galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S21 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S21+','Galaxy S',2021,'galaxy s 21 galaxy s galaxy s 21 plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S21+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S21','Galaxy S',2021,'galaxy s 21 galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S21');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy S21 FE','Galaxy S',2022,'galaxy s 21 fe galaxy s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy S21 FE');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Fold7','Galaxy Z Fold',2025,'galaxy z fold 7 galaxy z fold',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold7');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Flip7','Galaxy Z Flip',2025,'galaxy z flip 7 galaxy z flip',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip7');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Fold6','Galaxy Z Fold',2024,'galaxy z fold 6 galaxy z fold',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold6');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Flip6','Galaxy Z Flip',2024,'galaxy z flip 6 galaxy z flip',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip6');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Fold5','Galaxy Z Fold',2023,'galaxy z fold 5 galaxy z fold',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold5');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Flip5','Galaxy Z Flip',2023,'galaxy z flip 5 galaxy z flip',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip5');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Fold4','Galaxy Z Fold',2022,'galaxy z fold 4 galaxy z fold',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold4');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Flip4','Galaxy Z Flip',2022,'galaxy z flip 4 galaxy z flip',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip4');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Fold3','Galaxy Z Fold',2021,'galaxy z fold 3 galaxy z fold',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Fold3');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Z Flip3','Galaxy Z Flip',2021,'galaxy z flip 3 galaxy z flip',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Z Flip3');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A56','Galaxy A',2025,'galaxy a 56 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A56');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A36','Galaxy A',2025,'galaxy a 36 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A36');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A26','Galaxy A',2025,'galaxy a 26 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A26');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A16','Galaxy A',2024,'galaxy a 16 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A16');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A06','Galaxy A',2024,'galaxy a 06 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A06');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A55','Galaxy A',2024,'galaxy a 55 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A55');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A35','Galaxy A',2024,'galaxy a 35 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A35');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A25','Galaxy A',2023,'galaxy a 25 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A25');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A15','Galaxy A',2023,'galaxy a 15 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A15');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A05','Galaxy A',2023,'galaxy a 05 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A05');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A54','Galaxy A',2023,'galaxy a 54 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A54');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A34','Galaxy A',2023,'galaxy a 34 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A34');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A24','Galaxy A',2023,'galaxy a 24 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A24');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A14','Galaxy A',2023,'galaxy a 14 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A14');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A04','Galaxy A',2022,'galaxy a 04 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A04');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A53','Galaxy A',2022,'galaxy a 53 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A53');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A33','Galaxy A',2022,'galaxy a 33 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A33');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A23','Galaxy A',2022,'galaxy a 23 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A23');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A13','Galaxy A',2022,'galaxy a 13 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A13');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A03','Galaxy A',2021,'galaxy a 03 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A03');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A52','Galaxy A',2021,'galaxy a 52 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A52');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A32','Galaxy A',2021,'galaxy a 32 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A32');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A22','Galaxy A',2021,'galaxy a 22 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A22');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A12','Galaxy A',2020,'galaxy a 12 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy A02','Galaxy A',2021,'galaxy a 02 galaxy a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy A02');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy M55','Galaxy M',2024,'galaxy m 55 galaxy m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M55');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy M35','Galaxy M',2024,'galaxy m 35 galaxy m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M35');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy M15','Galaxy M',2024,'galaxy m 15 galaxy m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M15');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy M14','Galaxy M',2023,'galaxy m 14 galaxy m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M14');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy M13','Galaxy M',2022,'galaxy m 13 galaxy m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M13');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy M12','Galaxy M',2021,'galaxy m 12 galaxy m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy M12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Note20 Ultra','Galaxy Note',2020,'galaxy note 20 ultra galaxy note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Note20 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Note20','Galaxy Note',2020,'galaxy note 20 galaxy note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Note20');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Note10+','Galaxy Note',2019,'galaxy note 10 galaxy note note 10 plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Note10+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'samsung','Galaxy Note10','Galaxy Note',2019,'galaxy note 10 galaxy note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'samsung' AND `name` = 'Galaxy Note10');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 15 Ultra','Xiaomi numbered',2025,'xiaomi 15 ultra xiaomi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 15 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 15','Xiaomi numbered',2025,'xiaomi 15 xiaomi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 15');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 14T Pro','Xiaomi T',2024,'xiaomi 14 t pro xiaomi t',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 14T Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 14T','Xiaomi T',2024,'xiaomi 14 t xiaomi t',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 14T');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 14 Ultra','Xiaomi numbered',2024,'xiaomi 14 ultra xiaomi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 14 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 14','Xiaomi numbered',2023,'xiaomi 14 xiaomi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 14');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 13T Pro','Xiaomi T',2023,'xiaomi 13 t pro xiaomi t',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 13T Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 13T','Xiaomi T',2023,'xiaomi 13 t xiaomi t',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 13T');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 13 Pro','Xiaomi numbered',2022,'xiaomi 13 pro xiaomi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 13 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 13','Xiaomi numbered',2022,'xiaomi 13 xiaomi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 13');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 12T Pro','Xiaomi T',2022,'xiaomi 12 t pro xiaomi t',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 12T Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 12T','Xiaomi T',2022,'xiaomi 12 t xiaomi t',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 12T');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 12','Xiaomi numbered',2021,'xiaomi 12 xiaomi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 11T Pro','Xiaomi T',2021,'xiaomi 11 t pro xiaomi t',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 11T Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Xiaomi 11T','Xiaomi T',2021,'xiaomi 11 t xiaomi t',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Xiaomi 11T');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Mi 11','Mi',2021,'mi 11 mi',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Mi 11');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'xiaomi','Mi 10','Mi',2020,'mi 10 mi',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'xiaomi' AND `name` = 'Mi 10');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 14 Pro+','Redmi Note',2025,'redmi note 14 pro redmi note note 14 pro plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 14 Pro+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 14 Pro','Redmi Note',2025,'redmi note 14 pro redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 14 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 14','Redmi Note',2025,'redmi note 14 redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 14');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 13 Pro+','Redmi Note',2024,'redmi note 13 pro redmi note note 13 pro plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 13 Pro+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 13 Pro','Redmi Note',2024,'redmi note 13 pro redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 13 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 13','Redmi Note',2024,'redmi note 13 redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 13');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 12 Pro+','Redmi Note',2023,'redmi note 12 pro redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 12 Pro+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 12 Pro','Redmi Note',2023,'redmi note 12 pro redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 12 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 12','Redmi Note',2023,'redmi note 12 redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 11 Pro','Redmi Note',2022,'redmi note 11 pro redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 11 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 11','Redmi Note',2022,'redmi note 11 redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 11');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 10 Pro','Redmi Note',2021,'redmi note 10 pro redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 10 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 10','Redmi Note',2021,'redmi note 10 redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 10');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi Note 9','Redmi Note',2020,'redmi note 9 redmi note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi Note 9');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi 14C','Redmi numbered',2024,'redmi 14 c redmi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 14C');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi 13C','Redmi numbered',2023,'redmi 13 c redmi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 13C');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi 13','Redmi numbered',2024,'redmi 13 redmi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 13');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi 12C','Redmi numbered',2023,'redmi 12 c redmi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 12C');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi 12','Redmi numbered',2023,'redmi 12 redmi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi 10C','Redmi numbered',2022,'redmi 10 c redmi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 10C');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi 10','Redmi numbered',2021,'redmi 10 redmi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 10');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi 9A','Redmi numbered',2020,'redmi 9 a redmi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 9A');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi 9C','Redmi numbered',2020,'redmi 9 c redmi numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi 9C');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi A3','Redmi A',2024,'redmi a 3 redmi a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi A3');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi A2','Redmi A',2023,'redmi a 2 redmi a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi A2');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'redmi','Redmi A1','Redmi A',2022,'redmi a 1 redmi a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'redmi' AND `name` = 'Redmi A1');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO F7 Pro','POCO F',2025,'poco f 7 pro poco f',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO F7 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO F6 Pro','POCO F',2024,'poco f 6 pro poco f',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO F6 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO F6','POCO F',2024,'poco f 6 poco f',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO F6');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO F5 Pro','POCO F',2023,'poco f 5 pro poco f',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO F5 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO F5','POCO F',2023,'poco f 5 poco f',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO F5');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO F4','POCO F',2022,'poco f 4 poco f',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO F4');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO X7 Pro','POCO X',2025,'poco x 7 pro poco x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO X7 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO X6 Pro','POCO X',2024,'poco x 6 pro poco x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO X6 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO X6','POCO X',2024,'poco x 6 poco x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO X6');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO X5 Pro','POCO X',2023,'poco x 5 pro poco x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO X5 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO X5','POCO X',2023,'poco x 5 poco x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO X5');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO X4 Pro','POCO X',2022,'poco x 4 pro poco x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO X4 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO M6 Pro','POCO M',2024,'poco m 6 pro poco m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO M6 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO M6','POCO M',2023,'poco m 6 poco m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO M6');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO M5','POCO M',2022,'poco m 5 poco m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO M5');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO M4 Pro','POCO M',2021,'poco m 4 pro poco m',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO M4 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO C75','POCO C',2024,'poco c 75 poco c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO C75');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO C65','POCO C',2023,'poco c 65 poco c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO C65');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'poco','POCO C55','POCO C',2023,'poco c 55 poco c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'poco' AND `name` = 'POCO C55');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Phantom V Fold2','Phantom',2024,'phantom v fold 2 phantom',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Phantom V Fold2');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Phantom V Flip2','Phantom',2024,'phantom v flip 2 phantom',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Phantom V Flip2');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Phantom V Fold','Phantom',2023,'phantom v fold phantom',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Phantom V Fold');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Phantom X2 Pro','Phantom',2022,'phantom x 2 pro phantom',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Phantom X2 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Phantom X2','Phantom',2022,'phantom x 2 phantom',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Phantom X2');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Camon 40 Pro','Camon',2025,'camon 40 pro camon',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Camon 40 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Camon 40','Camon',2025,'camon 40 camon',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Camon 40');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Camon 30 Pro','Camon',2024,'camon 30 pro camon',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Camon 30 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Camon 30','Camon',2024,'camon 30 camon',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Camon 30');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Camon 20 Pro','Camon',2023,'camon 20 pro camon',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Camon 20 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Camon 20','Camon',2023,'camon 20 camon',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Camon 20');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Camon 19 Pro','Camon',2022,'camon 19 pro camon',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Camon 19 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Pova 6 Pro','Pova',2024,'pova 6 pro pova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Pova 6 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Pova 6','Pova',2024,'pova 6 pova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Pova 6');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Pova 5 Pro','Pova',2023,'pova 5 pro pova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Pova 5 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Pova 5','Pova',2023,'pova 5 pova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Pova 5');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Pova 4','Pova',2022,'pova 4 pova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Pova 4');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Spark 30 Pro','Spark',2024,'spark 30 pro spark',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Spark 30 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Spark 30','Spark',2024,'spark 30 spark',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Spark 30');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Spark 20 Pro','Spark',2024,'spark 20 pro spark',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Spark 20 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Spark 20','Spark',2023,'spark 20 spark',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Spark 20');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Spark 10 Pro','Spark',2023,'spark 10 pro spark',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Spark 10 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Spark 10','Spark',2023,'spark 10 spark',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Spark 10');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Spark 9','Spark',2022,'spark 9 spark',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Spark 9');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Spark Go 2024','Spark',2024,'spark go 2024 spark',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Spark Go 2024');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Pop 8','Pop',2024,'pop 8 pop',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Pop 8');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Pop 7','Pop',2023,'pop 7 pop',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Pop 7');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'tecno','Pop 6','Pop',2022,'pop 6 pop',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'tecno' AND `name` = 'Pop 6');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Zero 40','Zero',2024,'zero 40 zero',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Zero 40');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Zero 30','Zero',2023,'zero 30 zero',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Zero 30');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Zero 20','Zero',2022,'zero 20 zero',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Zero 20');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','GT 20 Pro','GT',2024,'gt 20 pro gt',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'GT 20 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','GT 10 Pro','GT',2023,'gt 10 pro gt',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'GT 10 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Note 40 Pro+','Note',2024,'note 40 pro note note 40 pro plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Note 40 Pro+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Note 40 Pro','Note',2024,'note 40 pro note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Note 40 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Note 40','Note',2024,'note 40 note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Note 40');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Note 30 Pro','Note',2023,'note 30 pro note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Note 30 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Note 30','Note',2023,'note 30 note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Note 30');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Note 12','Note',2022,'note 12 note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Note 12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Hot 50 Pro','Hot',2024,'hot 50 pro hot',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Hot 50 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Hot 50','Hot',2024,'hot 50 hot',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Hot 50');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Hot 40 Pro','Hot',2023,'hot 40 pro hot',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Hot 40 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Hot 40','Hot',2023,'hot 40 hot',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Hot 40');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Hot 30','Hot',2023,'hot 30 hot',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Hot 30');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Hot 20','Hot',2022,'hot 20 hot',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Hot 20');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Hot 12','Hot',2022,'hot 12 hot',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Hot 12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Smart 9','Smart',2024,'smart 9 smart',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Smart 9');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Smart 8','Smart',2023,'smart 8 smart',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Smart 8');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Smart 7','Smart',2023,'smart 7 smart',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Smart 7');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'infinix','Smart 6','Smart',2022,'smart 6 smart',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'infinix' AND `name` = 'Smart 6');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','City 100','City',2024,'city 100 city',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'City 100');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','Super 30','Super',2024,'super 30 super',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'Super 30');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','Super 27','Super',2024,'super 27 super',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'Super 27');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','Super 25','Super',2023,'super 25 super',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'Super 25');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','S25 Ultra','itel S',2024,'s 25 ultra itel s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'S25 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','S25','itel S',2024,'s 25 itel s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'S25');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','S24','itel S',2023,'s 24 itel s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'S24');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','S23+','itel S',2023,'s 23 itel s s 23 plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'S23+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','S23','itel S',2023,'s 23 itel s',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'S23');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','A80','itel A',2024,'a 80 itel a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'A80');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','A70','itel A',2024,'a 70 itel a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'A70');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','A60s','itel A',2023,'a 60 s itel a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'A60s');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','A60','itel A',2023,'a 60 itel a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'A60');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','A50','itel A',2022,'a 50 itel a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'A50');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','Power 70','Power',2024,'power 70 power',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'Power 70');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','P55','Power',2023,'p 55 power',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'P55');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','P40','Power',2023,'p 40 power',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'P40');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'itel','RS4','RS',2023,'rs 4 rs',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'itel' AND `name` = 'RS4');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Find X8 Pro','Find X',2024,'find x 8 pro find x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Find X8 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Find X8','Find X',2024,'find x 8 find x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Find X8');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Find X7 Ultra','Find X',2024,'find x 7 ultra find x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Find X7 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Find X6 Pro','Find X',2023,'find x 6 pro find x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Find X6 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Find X5 Pro','Find X',2022,'find x 5 pro find x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Find X5 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Find N5','Find N',2025,'find n 5 find n',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Find N5');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Find N3','Find N',2023,'find n 3 find n',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Find N3');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Find N3 Flip','Find N',2023,'find n 3 flip find n',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Find N3 Flip');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno13 Pro','Reno',2024,'reno 13 pro reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno13 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno13','Reno',2024,'reno 13 reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno13');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno12 Pro','Reno',2024,'reno 12 pro reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno12 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno12','Reno',2024,'reno 12 reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno11 Pro','Reno',2023,'reno 11 pro reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno11 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno11','Reno',2023,'reno 11 reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno11');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno10 Pro','Reno',2023,'reno 10 pro reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno10 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno10','Reno',2023,'reno 10 reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno10');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno8','Reno',2022,'reno 8 reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno8');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','Reno7','Reno',2021,'reno 7 reno',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'Reno7');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','A80','OPPO A',2024,'a 80 oppo a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'A80');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','A60','OPPO A',2024,'a 60 oppo a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'A60');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','A58','OPPO A',2023,'a 58 oppo a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'A58');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','A38','OPPO A',2023,'a 38 oppo a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'A38');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','A18','OPPO A',2023,'a 18 oppo a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'A18');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','A78','OPPO A',2023,'a 78 oppo a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'A78');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','A57','OPPO A',2022,'a 57 oppo a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'A57');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','A17','OPPO A',2022,'a 17 oppo a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'A17');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'oppo','A16','OPPO A',2021,'a 16 oppo a',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'oppo' AND `name` = 'A16');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','GT 7 Pro','realme GT',2024,'gt 7 pro realme gt',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'GT 7 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','GT 6','realme GT',2024,'gt 6 realme gt',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'GT 6');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','GT 5 Pro','realme GT',2023,'gt 5 pro realme gt',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'GT 5 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','GT Neo 5','realme GT',2023,'gt neo 5 realme gt',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'GT Neo 5');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 13 Pro+','realme numbered',2024,'realme 13 pro realme numbered 13 pro plus',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 13 Pro+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 13 Pro','realme numbered',2024,'realme 13 pro realme numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 13 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 12 Pro+','realme numbered',2024,'realme 12 pro realme numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 12 Pro+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 12 Pro','realme numbered',2024,'realme 12 pro realme numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 12 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 12','realme numbered',2024,'realme 12 realme numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 11 Pro+','realme numbered',2023,'realme 11 pro realme numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 11 Pro+');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 11 Pro','realme numbered',2023,'realme 11 pro realme numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 11 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 11','realme numbered',2023,'realme 11 realme numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 11');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 10','realme numbered',2022,'realme 10 realme numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 10');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','realme 9','realme numbered',2022,'realme 9 realme numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'realme 9');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','C75','realme C',2024,'c 75 realme c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'C75');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','C65','realme C',2024,'c 65 realme c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'C65');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','C55','realme C',2023,'c 55 realme c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'C55');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','C53','realme C',2023,'c 53 realme c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'C53');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','C35','realme C',2022,'c 35 realme c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'C35');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','C33','realme C',2022,'c 33 realme c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'C33');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','C30','realme C',2022,'c 30 realme c',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'C30');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','Note 60','realme Note',2024,'note 60 realme note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'Note 60');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','Note 50','realme Note',2024,'note 50 realme note',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'Note 50');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','P1 Pro','realme P',2024,'p 1 pro realme p',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'P1 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','P1','realme P',2024,'p 1 realme p',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'P1');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','Narzo 70 Pro','Narzo',2024,'narzo 70 pro narzo',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'Narzo 70 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','Narzo 60','Narzo',2023,'narzo 60 narzo',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'Narzo 60');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'realme','Narzo 50','Narzo',2022,'narzo 50 narzo',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'realme' AND `name` = 'Narzo 50');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Pura 70 Ultra','Pura',2024,'pura 70 ultra pura',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Pura 70 Ultra');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Pura 70 Pro','Pura',2024,'pura 70 pro pura',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Pura 70 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Pura 70','Pura',2024,'pura 70 pura',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Pura 70');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','P60 Pro','Huawei P',2023,'p 60 pro huawei p',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'P60 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','P50 Pro','Huawei P',2021,'p 50 pro huawei p',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'P50 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','P40 Pro','Huawei P',2020,'p 40 pro huawei p',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'P40 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','P30 Pro','Huawei P',2019,'p 30 pro huawei p',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'P30 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Mate 60 Pro','Mate',2023,'mate 60 pro mate',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Mate 60 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Mate 50 Pro','Mate',2022,'mate 50 pro mate',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Mate 50 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Mate X5','Mate',2023,'mate x 5 mate',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Mate X5');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Mate 40 Pro','Mate',2020,'mate 40 pro mate',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Mate 40 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','nova 13','nova',2024,'nova 13 nova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'nova 13');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','nova 12','nova',2023,'nova 12 nova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'nova 12');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','nova 11','nova',2023,'nova 11 nova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'nova 11');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','nova 10','nova',2022,'nova 10 nova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'nova 10');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','nova 9','nova',2021,'nova 9 nova',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'nova 9');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Y9a','Huawei Y',2020,'y 9 a huawei y',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Y9a');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Y7a','Huawei Y',2020,'y 7 a huawei y',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Y7a');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'huawei','Y6p','Huawei Y',2020,'y 6 p huawei y',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'huawei' AND `name` = 'Y6p');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Magic7 Pro','Magic',2024,'magic 7 pro magic',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Magic7 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Magic7','Magic',2024,'magic 7 magic',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Magic7');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Magic6 Pro','Magic',2024,'magic 6 pro magic',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Magic6 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Magic5 Pro','Magic',2023,'magic 5 pro magic',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Magic5 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Magic V3','Magic V',2024,'magic v 3 magic v',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Magic V3');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Magic V2','Magic V',2023,'magic v 2 magic v',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Magic V2');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Honor 200 Pro','Honor numbered',2024,'honor 200 pro honor numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Honor 200 Pro');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Honor 200','Honor numbered',2024,'honor 200 honor numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Honor 200');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Honor 90','Honor numbered',2023,'honor 90 honor numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Honor 90');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','Honor 70','Honor numbered',2022,'honor 70 honor numbered',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'Honor 70');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','X9c','Honor X',2024,'x 9 c honor x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'X9c');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','X9b','Honor X',2023,'x 9 b honor x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'X9b');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','X8b','Honor X',2024,'x 8 b honor x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'X8b');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','X7b','Honor X',2024,'x 7 b honor x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'X7b');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','X6b','Honor X',2024,'x 6 b honor x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'X6b');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','X8a','Honor X',2023,'x 8 a honor x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'X8a');
INSERT INTO `device_models` (`brand_key`,`name`,`family`,`release_rank`,`search_terms`,`is_active`,`source`,`reviewed_on`)
SELECT 'honor','X7a','Honor X',2023,'x 7 a honor x',1,'curated','2026-08-30'
WHERE NOT EXISTS (SELECT 1 FROM `device_models` WHERE `brand_key` = 'honor' AND `name` = 'X7a');

-- Existing TAC rows are reference data too, and are now labelled as such.
UPDATE `tac_catalog` SET `reviewed_on` = '2026-08-30' WHERE `reviewed_on` IS NULL;

