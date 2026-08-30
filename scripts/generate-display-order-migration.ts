// ===========================================================================
// Generate migration 0063 — the display order, as reference data.
//
//   npx ts-node scripts/generate-display-order-migration.ts
//
// `0062` is immutable history and is not touched. This adds the column the
// catalogue needed and backfills it from `src/catalog/device-catalogue.ts`,
// which remains the single source of truth.
//
// Every UPDATE is keyed on (brand, name) and sets one column. No row is
// created, renamed or deleted, and `release_rank` — the release YEAR — is left
// exactly as it was.
// ===========================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MODELS } from '../src/catalog/device-catalogue';

const DIR = join(__dirname, '..', 'prisma', 'migrations', '0063_device_model_display_order');
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

const header = `-- ===========================================================================
-- 0063 — models sort the way a shopkeeper reads them.
--
-- The defect
-- ----------
-- \`release_rank\` was the release YEAR and was also doing duty as the display
-- order. It cannot do both, and the catalogue showed exactly why:
--
--   * \`iPhone 16e\` (2025) sorted ABOVE \`iPhone 17\` (2025), because models
--     sharing a year fell back to alphabetical order;
--   * \`iPhone 17e\` (2026) sat alone at the top, split from the \`iPhone 17\`
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
-- Pro, Air/Plus, standard, then value variants (\`e\`, mini, SE). Samsung reads
-- Ultra, Plus, standard, FE. \`display_rank\` is derived from each model's
-- POSITION in its brand's list, so correcting the order means moving a line.
--
-- Ranks are spaced by ten so a model can be slipped between two others without
-- renumbering the brand. Every model has a distinct rank, so there is no
-- tie-break — which is what stops the order changing with the language.
--
-- Existing data
-- -------------
-- One column added with a default, then one UPDATE per model keyed on
-- (brand, name). No row is created, renamed or deleted. \`release_rank\` is not
-- touched. A rerun sets the same values.
--
-- Provenance
-- ----------
-- Generated from \`src/catalog/device-catalogue.ts\` by
-- \`scripts/generate-display-order-migration.ts\`.
-- ===========================================================================

SET @have := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'device_models'
                AND column_name = 'display_rank');
SET @sql := IF(@have = 0,
  'ALTER TABLE \`device_models\` ADD COLUMN \`display_rank\` INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @haveIx := (SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'device_models'
                  AND index_name = 'ix_device_models_brand_active_display');
SET @sql := IF(@haveIx = 0,
  'CREATE INDEX \`ix_device_models_brand_active_display\`
     ON \`device_models\` (\`brand_key\`, \`is_active\`, \`display_rank\`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── The order itself ──────────────────────────────────────────────────────
`;

const lines = [header];
for (const m of MODELS) {
  lines.push(
    `UPDATE \`device_models\` SET \`display_rank\` = ${m.displayRank}` +
      ` WHERE \`brand_key\` = ${q(m.brandKey)} AND \`name\` = ${q(m.name)};`,
  );
}

mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'migration.sql'), lines.join('\n') + '\n', 'utf8');
console.log(`0063 written: ${MODELS.length} models ranked`);
