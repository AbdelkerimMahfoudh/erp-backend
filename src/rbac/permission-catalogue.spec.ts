import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_PERMISSION_KEYS,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  STORE_FACING_ROLES,
} from './role-permissions';
import {
  CATALOGUE_MIGRATION,
  catalogueKeys,
  checkCommittedMigration,
} from '../../scripts/generate-catalogue-migration';

/**
 * The permission catalogue, and the migration that publishes it.
 *
 * Background: until `0059` **no migration created the catalogue**. The base
 * keys existed only in `prisma/seed.ts`, which also seeds the demo company and
 * therefore never runs against staging or a real deployment. A database built
 * by `prisma migrate deploy` alone held 44 of the 61 keys — and nothing said so,
 * because every environment anybody looked at had run the seed.
 *
 * These tests pin the catalogue itself, and pin the migration to it, so the two
 * cannot drift apart the way the matrix and registration once did.
 */

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

describe('the canonical catalogue', () => {
  it('holds exactly 61 keys, all unique', () => {
    expect(PERMISSIONS).toHaveLength(61);
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(61);
  });

  it('gives Owner 61, Manager 43 and Employee 20', () => {
    expect(ROLE_PERMISSIONS.owner).toHaveLength(61);
    expect(ROLE_PERMISSIONS.store_manager).toHaveLength(43);
    expect(ROLE_PERMISSIONS.store_employee).toHaveLength(20);
  });

  it('grants no role a key the catalogue does not define', () => {
    const catalogue = new Set(ALL_PERMISSION_KEYS);
    for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
      for (const key of keys) {
        expect(catalogue.has(key)).toBe(true);
        if (!catalogue.has(key)) throw new Error(`${role} references unknown ${key}`);
      }
    }
  });

  it('labels every key, with no duplicate label-less entry', () => {
    for (const p of PERMISSIONS) {
      expect(p.key).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      expect(p.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe(`migration ${CATALOGUE_MIGRATION}`, () => {
  const sql = readFileSync(join(MIGRATIONS, CATALOGUE_MIGRATION, 'migration.sql'), 'utf8');

  /*
   * The EXECUTABLE statement, with the header comment stripped.
   *
   * The header explains at length why this migration does not use INSERT
   * IGNORE or REPLACE and does not touch role_permissions — so a naive search
   * of the whole file finds all of those words in the prose that forbids them.
   * What matters is what the migration RUNS.
   */
  const executable = sql.replace(/^\s*--.*$/gm, '');

  it('exists, and is the highest migration in the tree', () => {
    const all = readdirSync(MIGRATIONS).filter((d) => /^\d{4}_/.test(d)).sort();
    expect(all).toContain(CATALOGUE_MIGRATION);
    expect(all[all.length - 1]).toBe(CATALOGUE_MIGRATION);
  });

  it('publishes exactly the canonical key set', () => {
    const { ok, missing, extra } = checkCommittedMigration();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect(ok).toBe(true);
  });

  it('is derived from the canonical source, not hand-maintained', () => {
    // Every canonical key appears; the generator is what produced them.
    for (const key of catalogueKeys()) expect(sql).toContain(`'${key}'`);
    expect(sql).toContain('scripts/generate-catalogue-migration.ts');
  });

  it('uses conditional insert semantics, never IGNORE or REPLACE', () => {
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM `permissions` p WHERE p\.`key` = want\.k\)/);
    /*
     * INSERT IGNORE would also swallow a genuine error — a truncated label
     * under strict mode, a broken constraint — and leave the catalogue quietly
     * short, which is the exact class of silent failure this migration exists
     * to end. REPLACE would delete and reinsert, discarding ids that
     * `role_permissions` rows point at.
     */
    expect(executable).not.toMatch(/INSERT\s+IGNORE/i);
    expect(executable).not.toMatch(/\bREPLACE\s+INTO\b/i);
    expect(executable).not.toMatch(/ON DUPLICATE KEY UPDATE/i);
  });

  it('changes no existing row and grants no authority', () => {
    // Reference data only: no UPDATE, no DELETE, and nothing touching mappings.
    expect(executable).not.toMatch(/\bUPDATE\s+`?permissions`?/i);
    expect(executable).not.toMatch(/\bDELETE\s+FROM/i);
    expect(executable).not.toMatch(/`role_permissions`/);
    expect(executable).not.toMatch(/`user_branch_permissions`/);
  });

  it('creates no tenant, demo or business data', () => {
    for (const table of [
      'companies', 'users', 'branches', 'roles', 'subscriptions',
      'sales', 'sale_items', 'products', 'units', 'platform_admins',
    ]) {
      expect(executable).not.toMatch(new RegExp(`INSERT INTO \`${table}\``, 'i'));
    }
  });

  it('makes no schema change', () => {
    expect(executable).not.toMatch(/\bALTER TABLE\b/i);
    expect(executable).not.toMatch(/\bCREATE TABLE\b/i);
    expect(executable).not.toMatch(/\bDROP\b/i);
  });

  it('is the only migration that publishes the whole catalogue', () => {
    /*
     * Earlier migrations legitimately add the handful of keys their own feature
     * introduced. What must never happen again is a SECOND migration claiming
     * to publish the entire catalogue — two of those, and which one is
     * authoritative depends on the order somebody happened to apply them.
     */
    const wholeCatalogue = readdirSync(MIGRATIONS)
      .filter((d) => /^\d{4}_/.test(d) && d !== CATALOGUE_MIGRATION)
      .filter((d) => {
        const body = readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');
        const hits = catalogueKeys().filter((k) => body.includes(`'${k}'`)).length;
        return hits > 40;
      });
    expect(wholeCatalogue).toEqual([]);
  });
});

describe('the deployment contract', () => {
  it('the seed-data path is still only a pure re-export', () => {
    const shim = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'seed-data', 'permissions.ts'),
      'utf8',
    );
    expect(shim).toMatch(/export\s*\{[\s\S]*ROLE_PERMISSIONS[\s\S]*\}\s*from\s*'\.\.\/\.\.\/src\/rbac\/role-permissions'/);
    // It must not have grown a definition of its own.
    expect(shim).not.toMatch(/ROLE_PERMISSIONS\s*[:=]\s*\{/);
    expect(shim).not.toMatch(/PERMISSIONS\s*:\s*\{?\s*key/);
  });

  it('runtime code never reads a migration file', () => {
    /*
     * The SQL is an immutable historical snapshot, not a second runtime source
     * of authority. If the server ever read it, the snapshot would become live
     * configuration and editing history would change behaviour.
     */
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.name === 'node_modules' ? []
          : e.isDirectory() ? walk(join(dir, e.name))
          : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
      );

    const offenders = walk(join(__dirname, '..'))
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => /prisma\/migrations|prisma\\\\migrations/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the verification command exists and refuses on a bad catalogue', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'scripts', 'verify-permission-catalogue.ts'),
      'utf8',
    );
    expect(source).toMatch(/process\.exitCode = r\.ok \? 0 : 1/);
    // It reports an unknown key; it must never remove one on its own.
    expect(source).not.toMatch(/permission\.delete/);
    expect(source).toMatch(/Nothing was deleted/);
    // No secret in its output.
    expect(source).not.toMatch(/DATABASE_URL.*console\.log|console\.log.*DATABASE_URL/);
  });

  it('the store-facing roles are unchanged by any of this', () => {
    expect(STORE_FACING_ROLES).toEqual(['owner', 'store_manager', 'store_employee']);
    expect(STORE_FACING_ROLES).not.toContain('administrator');
  });
});
