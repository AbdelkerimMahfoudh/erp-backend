// ===========================================================================
// Generate migration 0062 from the device catalogue.
//
//   npx ts-node scripts/generate-device-catalogue-migration.ts
//
// The catalogue lives in `src/catalog/device-catalogue.ts`. This writes an
// immutable snapshot of it as SQL, exactly as `generate-catalogue-migration.ts`
// does for permissions. Runtime code never reads the migration, and
// `device-catalogue.spec.ts` fails the build if the two drift — so the snapshot
// is history, not a second source of authority.
//
// Every insert is `NOT EXISTS`, never `INSERT IGNORE` or `REPLACE`. IGNORE
// would also swallow a real error and leave the catalogue quietly short;
// REPLACE would delete and reinsert, discarding ids that other rows point at.
// ===========================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRANDS,
  MODELS,
  CATALOGUE_REVIEWED_ON,
  searchTermsFor,
  normaliseSearch,
} from '../src/catalog/device-catalogue';

const DIR = join(__dirname, '..', 'prisma', 'migrations', '0062_device_catalogue');

/** MySQL string literal. Single quotes doubled; nothing else needs escaping here. */
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

const header = `-- ===========================================================================
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
-- \`products.variant\` already carries storage and colour and the unit carries
-- the identifier, so folding them in would multiply the catalogue by every SKU
-- and make search and reporting worthless.
--
-- Existing data
-- -------------
-- No existing row is modified. No product is renamed. \`tac_catalog\` gains
-- columns with defaults, so every row already in it keeps its brand and model
-- and simply becomes \`curated\` and active. Legacy free-text product brands and
-- models continue to work untouched — the catalogue is a source of CHOICES,
-- not a constraint on what a product may be called.
--
-- Semantics
-- ---------
--   * clean install: creates two tables, extends a third, inserts ${BRANDS.length} brands
--     and ${MODELS.length} models;
--   * rerun: inserts nothing and changes nothing;
--   * upgrade: adds only what is missing.
--
-- Provenance
-- ----------
-- Generated from \`src/catalog/device-catalogue.ts\` by
-- \`scripts/generate-device-catalogue-migration.ts\`. Reviewed ${CATALOGUE_REVIEWED_ON}.
-- ===========================================================================

-- ── Schema ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS \`device_brands\` (
  \`key\`           VARCHAR(40)  NOT NULL,
  \`name\`          VARCHAR(80)  NOT NULL,
  \`search_terms\`  VARCHAR(400) NOT NULL,
  \`display_order\` INT          NOT NULL,
  \`parent_key\`    VARCHAR(40)  NULL,
  \`is_active\`     TINYINT(1)   NOT NULL DEFAULT 1,
  \`source\`        ENUM('official','curated','company_confirmed','synthetic_staging') NOT NULL DEFAULT 'curated',
  \`reviewed_on\`   DATE         NOT NULL,
  \`created_at\`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  \`updated_at\`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (\`key\`),
  KEY \`ix_device_brands_active_order\` (\`is_active\`, \`display_order\`),
  CONSTRAINT \`fk_device_brands_parent\` FOREIGN KEY (\`parent_key\`)
    REFERENCES \`device_brands\` (\`key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS \`device_models\` (
  \`id\`           INT          NOT NULL AUTO_INCREMENT,
  \`brand_key\`    VARCHAR(40)  NOT NULL,
  \`name\`         VARCHAR(120) NOT NULL,
  \`family\`       VARCHAR(80)  NOT NULL,
  \`release_rank\` INT          NOT NULL,
  \`search_terms\` VARCHAR(400) NOT NULL,
  \`is_active\`    TINYINT(1)   NOT NULL DEFAULT 1,
  \`source\`       ENUM('official','curated','company_confirmed','synthetic_staging') NOT NULL DEFAULT 'curated',
  \`reviewed_on\`  DATE         NOT NULL,
  \`created_at\`   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  \`updated_at\`   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`ux_device_models_brand_name\` (\`brand_key\`, \`name\`),
  KEY \`ix_device_models_brand_active_rank\` (\`brand_key\`, \`is_active\`, \`release_rank\`),
  CONSTRAINT \`fk_device_models_brand\` FOREIGN KEY (\`brand_key\`)
    REFERENCES \`device_brands\` (\`key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- \`tac_catalog\` gains provenance. Existing rows keep their brand and model and
-- become curated and active, which is what they always implicitly were.
SET @have := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'tac_catalog'
                AND column_name = 'source');
SET @sql := IF(@have = 0,
  'ALTER TABLE \`tac_catalog\`
     ADD COLUMN \`brand_key\`   VARCHAR(40) NULL,
     ADD COLUMN \`model_id\`    INT NULL,
     ADD COLUMN \`source\`      ENUM(''official'',''curated'',''company_confirmed'',''synthetic_staging'') NOT NULL DEFAULT ''curated'',
     ADD COLUMN \`is_active\`   TINYINT(1) NOT NULL DEFAULT 1,
     ADD COLUMN \`reviewed_on\` DATE NULL,
     ADD KEY \`ix_tac_catalog_source\` (\`source\`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Reference data ────────────────────────────────────────────────────────
`;

const lines: string[] = [header];

lines.push('\n-- Brands. Parents are inserted before children, so the foreign key holds.\n');
const ordered = [...BRANDS].sort((a, b) => (a.parentKey ? 1 : 0) - (b.parentKey ? 1 : 0));
for (const b of ordered) {
  const terms = normaliseSearch([b.name, b.key, ...b.aliases].join(' '));
  lines.push(
    `INSERT INTO \`device_brands\` (\`key\`,\`name\`,\`search_terms\`,\`display_order\`,\`parent_key\`,\`is_active\`,\`source\`,\`reviewed_on\`)\n` +
      `SELECT ${q(b.key)},${q(b.name)},${q(terms)},${b.order},${b.parentKey ? q(b.parentKey) : 'NULL'},1,'curated',${q(CATALOGUE_REVIEWED_ON)}\n` +
      `WHERE NOT EXISTS (SELECT 1 FROM \`device_brands\` WHERE \`key\` = ${q(b.key)});`,
  );
}

lines.push('\n-- Models.\n');
for (const m of MODELS) {
  lines.push(
    `INSERT INTO \`device_models\` (\`brand_key\`,\`name\`,\`family\`,\`release_rank\`,\`search_terms\`,\`is_active\`,\`source\`,\`reviewed_on\`)\n` +
      `SELECT ${q(m.brandKey)},${q(m.name)},${q(m.family)},${m.releaseRank},${q(searchTermsFor(m))},1,'curated',${q(CATALOGUE_REVIEWED_ON)}\n` +
      `WHERE NOT EXISTS (SELECT 1 FROM \`device_models\` WHERE \`brand_key\` = ${q(m.brandKey)} AND \`name\` = ${q(m.name)});`,
  );
}

lines.push(
  '\n-- Existing TAC rows are reference data too, and are now labelled as such.\n' +
    "UPDATE `tac_catalog` SET `reviewed_on` = " +
    q(CATALOGUE_REVIEWED_ON) +
    ' WHERE `reviewed_on` IS NULL;\n',
);

mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'migration.sql'), lines.join('\n') + '\n', 'utf8');
console.log(
  `0062 written: ${BRANDS.length} brands, ${MODELS.length} models, reviewed ${CATALOGUE_REVIEWED_ON}`,
);
