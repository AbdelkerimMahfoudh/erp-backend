// ===========================================================================
// Generate migration 0104 from the built-in category taxonomy.
//
//   npx ts-node scripts/generate-default-categories-migration.ts
//
// The taxonomy lives in `src/catalog/default-categories.ts`. This writes an
// immutable snapshot of it as SQL, as the device-catalogue and permission
// generators do. Runtime code never reads the migration, and
// `default-categories.spec.ts` fails the build if the two drift.
//
// Every insert is `NOT EXISTS`, never `INSERT IGNORE` or `REPLACE`: IGNORE would
// swallow a real error, REPLACE would discard ids that products point at.
// ===========================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CATEGORIES } from '../src/catalog/default-categories';

const DIR = join(__dirname, '..', 'prisma', 'migrations', '0104_general_electronics_categories');

/** MySQL string literal. Single quotes doubled; nothing else needs escaping here. */
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

const header = `-- ===========================================================================
-- 0104 — Dukan ERP as a general electronics inventory: built-in categories with stable keys, one level of
-- subcategories (the owner's decision of 2026-10-27; D223).
--
-- Why: a shop sells laptops, chargers, cases and parts as well as phones. Every company now starts with the same
-- translated taxonomy (src/catalog/default-categories.ts), identified by a stable KEY the app translates — never by a
-- name — and may still create its own categories.
--
-- product_categories gains:
--   key        — a built-in category's stable identifier; NULL for a shop's own category. UNIQUE per company.
--   parent_id  — the top-level category of a subcategory. One level only (the application refuses deeper).
--   custom_name — generated: the name when key IS NULL. The old UNIQUE (company_id, name) moves onto it, so a shop's
--                 own names stay unique among themselves while a built-in "Phones" may sit beside a shop's own
--                 "Phones". Nothing existing is renamed, merged, re-keyed or reclassified.
--
-- Existing data: NO product changes category, NO category changes its tracking mode, NO stock is relabelled. A
-- company's existing categories keep their names, modes, schemas and products, with key NULL. The built-in
-- categories are ADDED to every existing company; new companies get them when they are created (the application,
-- inside the creating transaction).
--
-- Additive for the previous release: it never reads key, parent_id or custom_name, and its own inserts (key NULL)
-- satisfy the moved uniqueness exactly as before. It never selected categories by (company_id, name) uniqueness.
--
-- Reverse (only if no category has a parent and no built-in is referenced by a product):
--   ALTER TABLE product_categories DROP FOREIGN KEY fk_product_categories_parent;
--   DELETE FROM product_categories WHERE \`key\` IS NOT NULL AND id NOT IN (SELECT category_id FROM products WHERE category_id IS NOT NULL);
--   ALTER TABLE product_categories DROP INDEX product_categories_company_id_custom_name_key,
--     DROP INDEX product_categories_company_id_key_key, DROP INDEX product_categories_parent_id_idx,
--     DROP COLUMN custom_name, DROP COLUMN parent_id, DROP COLUMN \`key\`,
--     ADD UNIQUE INDEX product_categories_company_id_name_key (company_id, name);
-- ===========================================================================
`;

const schema = `
ALTER TABLE \`product_categories\`
  ADD COLUMN \`key\` VARCHAR(48) NULL AFTER \`company_id\`,
  ADD COLUMN \`parent_id\` BINARY(16) NULL AFTER \`key\`,
  ADD COLUMN \`custom_name\` VARCHAR(80)
    GENERATED ALWAYS AS (IF(\`key\` IS NULL, \`name\`, NULL)) STORED AFTER \`name\`;

ALTER TABLE \`product_categories\`
  ADD UNIQUE INDEX \`product_categories_company_id_custom_name_key\` (\`company_id\`, \`custom_name\`),
  DROP INDEX \`product_categories_company_id_name_key\`,
  ADD UNIQUE INDEX \`product_categories_company_id_key_key\` (\`company_id\`, \`key\`),
  ADD INDEX \`product_categories_parent_id_idx\` (\`parent_id\`),
  ADD CONSTRAINT \`fk_product_categories_parent\` FOREIGN KEY (\`parent_id\`) REFERENCES \`product_categories\` (\`id\`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
`;

function insert(level: 'top' | 'child'): string {
  const rows = DEFAULT_CATEGORIES.filter((c) => (level === 'top' ? !c.parentKey : !!c.parentKey));
  const values = rows
    .map(
      (c) =>
        `  SELECT ${q(c.key)} AS k, ${c.parentKey ? q(c.parentKey) : 'NULL'} AS pk, ${q(c.name)} AS n, ${q(c.trackingType)} AS t, ${q(JSON.stringify(c.attributes))} AS s`,
    )
    .join('\n  UNION ALL\n');
  const parent =
    level === 'top'
      ? 'NULL'
      : '(SELECT p.`id` FROM `product_categories` p WHERE p.`company_id` = c.`id` AND p.`key` = d.pk)';
  return `
INSERT INTO \`product_categories\`
  (\`id\`, \`company_id\`, \`key\`, \`parent_id\`, \`name\`, \`default_tracking_type\`, \`attribute_schema\`, \`is_active\`, \`created_at\`, \`updated_at\`)
SELECT UNHEX(REPLACE(UUID(), '-', '')), c.\`id\`, d.k, ${parent}, d.n, d.t, CAST(d.s AS JSON), 1, NOW(6), NOW(6)
FROM \`companies\` c
CROSS JOIN (
${values}
) d
WHERE NOT EXISTS (SELECT 1 FROM \`product_categories\` x WHERE x.\`company_id\` = c.\`id\` AND x.\`key\` = d.k);
`;
}

/** The migration's SQL, exactly as committed (default-categories.spec.ts compares the two). */
export function buildMigrationSql(): string {
  return `${header}${schema}
-- Built-in categories for every existing company: top level first, then subcategories under them.
${insert('top')}${insert('child')}`;
}

if (require.main === module) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'migration.sql'), buildMigrationSql());
  console.log(`wrote ${join(DIR, 'migration.sql')} (${DEFAULT_CATEGORIES.length} categories)`);
}
