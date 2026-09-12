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
  PUBLISHED_AFTER_CATALOGUE,
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
  it('holds exactly 62 keys, all unique', () => {
    // 61 → 62 in 4a: `customer.manage`, the authority to ADD a customer.
    // Finding one stays under `sale.create`, because a credit sale requires a
    // customer and gating the lookup would gate the sale.
    expect(PERMISSIONS).toHaveLength(62);
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(62);
  });

  it('gives Owner 62, Manager 44 and Employee 20', () => {
    expect(ROLE_PERMISSIONS.owner).toHaveLength(62);
    expect(ROLE_PERMISSIONS.store_manager).toHaveLength(44);
    // The Employee is deliberately unchanged: they attribute a sale to an
    // existing customer, and do not create one.
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

  it('exists, and no later migration touches the catalogue', () => {
    /*
     * Originally this asserted 0059 was the LAST migration, which was only
     * true on the day it was written — 0060 followed for an unrelated reason.
     * The property that actually matters is narrower and permanent: 0059 is
     * present, and nothing applied after it changes the `permissions` table
     * behind its back.
     */
    const all = readdirSync(MIGRATIONS).filter((d) => /^\d{4}_/.test(d)).sort();
    expect(all).toContain(CATALOGUE_MIGRATION);

    const later = all.slice(all.indexOf(CATALOGUE_MIGRATION) + 1);
    const touching = later.filter((d) =>
      writesToCatalogue(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8')),
    );
    /*
     * A later migration may ADD the one key its own feature introduces — that
     * is how every permission before 0059 arrived, and refusing it would mean
     * no feature could ever ship a permission again. What must never happen is
     * a second migration republishing the WHOLE catalogue (pinned separately
     * below), or one that updates or deletes catalogue rows.
     *
     * Each entry here is a single additive insert, guarded by NOT EXISTS on the
     * key. Adding to this list is part of writing such a migration.
     */
    const additive = ['0068_customer_manage_permission'];
    expect(touching).toEqual(additive);

    for (const name of additive) {
      const body = readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8').replace(/^\s*--.*$/gm, '');
      expect(body).not.toMatch(/\bUPDATE\s+`?permissions`?/i);
      expect(body).not.toMatch(/\bDELETE\s+FROM/i);
      expect(body).toMatch(/WHERE NOT EXISTS/i);
    }

    /*
     * Not vacuous: 0067 names the `permissions` table — it has to, to find the
     * grant by key — and it must be judged a READ, not waved through unseen.
     */
    const repair = '0067_revoke_branch_manager_discount_override';
    expect(later).toContain(repair);
    const repairSql = readFileSync(join(MIGRATIONS, repair, 'migration.sql'), 'utf8').replace(/^\s*--.*$/gm, '');
    expect(repairSql).toMatch(/`permissions`/);
    expect(writesToCatalogue(repairSql)).toBe(false);
  });

  /**
   * Does this SQL CHANGE the `permissions` table?
   *
   * A write is identified by its TARGET, not by the table's name appearing
   * anywhere. The first version failed any later migration that so much as
   * mentioned `permissions` — which is every grant or revocation, because
   * permission ids are generated per installation (0059 uses `UUID()` at apply
   * time, and a seeded database carries the seed's own ids), so the only
   * correct way for a migration to name a permission is by key, through a
   * JOIN. 0067 revokes one stale grant exactly that way, in 0018's shape, and
   * was refused for reading the catalogue it has to read.
   *
   * The guarantee this test exists for is unchanged: every statement that can
   * alter the table is still caught — including a DELETE or UPDATE that
   * reaches catalogue rows through a join alias, which a target-only pattern
   * would miss. The cases below pin that.
   */
  function writesToCatalogue(sql: string): boolean {
    const body = sql.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const T = '`permissions`';
    const direct = [
      new RegExp('INSERT\\s+(?:IGNORE\\s+)?INTO\\s+' + T, 'i'),
      new RegExp('REPLACE\\s+(?:INTO\\s+)?' + T, 'i'),
      new RegExp('UPDATE\\s+(?:IGNORE\\s+)?' + T, 'i'),
      new RegExp('DELETE\\s+(?:IGNORE\\s+)?FROM\\s+' + T, 'i'),
      new RegExp('(?:ALTER|DROP)\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?' + T, 'i'),
      new RegExp('TRUNCATE\\s+(?:TABLE\\s+)?' + T, 'i'),
      new RegExp('RENAME\\s+TABLE\\s+' + T, 'i'),
    ];
    if (direct.some((r) => r.test(body))) return true;

    // Multi-table statements: find the alias the catalogue is joined under,
    // then ask whether the statement deletes that alias or sets its columns.
    for (const statement of body.split(';')) {
      const joined = new RegExp(T + '(?:\\s+(?:AS\\s+)?(\\w+))?', 'i').exec(statement);
      if (!joined) continue;
      const alias = joined[1] && !/^(ON|JOIN|WHERE|SET|INNER|LEFT|RIGHT|USING)$/i.test(joined[1]) ? joined[1] : 'permissions';

      const del = /^\s*DELETE\s+(?:IGNORE\s+)?([\w`\s,.]+?)\s+FROM\s/i.exec(statement);
      if (del) {
        const targets = del[1].split(',').map((t) => t.replace(/[`\s]/g, '').replace(/\.\*$/, ''));
        if (targets.includes(alias) || targets.includes('permissions')) return true;
      }

      if (/^\s*UPDATE\s/i.test(statement)) {
        const set = statement.slice(statement.search(/\bSET\b/i));
        if (new RegExp('\\b`?' + alias + '`?\\.`?\\w+`?\\s*=', 'i').test(set)) return true;
      }
    }
    return false;
  }

  describe('the catalogue-write detector', () => {
    it.each([
      ['an INSERT', 'INSERT INTO `permissions` (`id`, `key`, `label`) VALUES (0x01, \'x.y\', \'X\');'],
      ['an INSERT IGNORE', 'INSERT IGNORE INTO `permissions` (`key`) VALUES (\'x.y\');'],
      ['a REPLACE', 'REPLACE INTO `permissions` (`key`) VALUES (\'x.y\');'],
      ['an UPDATE', 'UPDATE `permissions` SET `label` = \'renamed\' WHERE `key` = \'x.y\';'],
      ['a DELETE', 'DELETE FROM `permissions` WHERE `key` = \'x.y\';'],
      ['a DELETE of catalogue rows through a join alias', 'DELETE p FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id` WHERE rp.`company_id` = 0x01;'],
      ['an UPDATE setting a catalogue column through a join alias', 'UPDATE `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id` SET p.`label` = \'x\' WHERE rp.`company_id` = 0x01;'],
      ['an ALTER', 'ALTER TABLE `permissions` ADD COLUMN `x` INT;'],
      ['a DROP', 'DROP TABLE IF EXISTS `permissions`;'],
      ['a TRUNCATE', 'TRUNCATE TABLE `permissions`;'],
      ['a RENAME', 'RENAME TABLE `permissions` TO `permissions_old`;'],
    ])('still catches %s', (_label, sql) => {
      expect(writesToCatalogue(sql)).toBe(true);
    });

    it('does not mistake a revocation that reads the catalogue by key for a write', () => {
      expect(writesToCatalogue(sqlOfMigration('0018_store_role_revoke'))).toBe(false);
      expect(
        writesToCatalogue(
          'DELETE rp FROM `role_permissions` rp JOIN `roles` r ON r.`id` = rp.`role_id` JOIN `permissions` p ON p.`id` = rp.`permission_id` WHERE r.`key` = \'branch_manager\' AND p.`key` = \'discount.override\';',
        ),
      ).toBe(false);
    });

    it('does not mistake a grant that reads the catalogue by key for a write', () => {
      expect(
        writesToCatalogue(
          'INSERT INTO `role_permissions` (`company_id`, `role_id`, `permission_id`) SELECT r.`company_id`, r.`id`, p.`id` FROM `roles` r JOIN `permissions` p ON p.`key` = \'x.y\' WHERE r.`key` = \'owner\';',
        ),
      ).toBe(false);
    });

    it('ignores the table named only in a comment', () => {
      expect(writesToCatalogue('-- DELETE FROM `permissions` would be wrong here\nSELECT 1;')).toBe(false);
    });
  });

  function sqlOfMigration(name: string): string {
    return readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');
  }

  it('publishes exactly the canonical key set', () => {
    const { ok, missing, extra } = checkCommittedMigration();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect(ok).toBe(true);
  });

  it('is derived from the canonical source, not hand-maintained', () => {
    /*
     * Every canonical key of ITS OWN TIME appears; the generator produced them.
     * Keys added since are published by their own additive migration — 0059 is
     * an immutable snapshot and is never rewritten to include them.
     */
    for (const key of catalogueKeys()) {
      if (PUBLISHED_AFTER_CATALOGUE.has(key)) continue;
      expect(sql).toContain(`'${key}'`);
    }
    expect(sql).toContain('scripts/generate-catalogue-migration.ts');

    // Not vacuous: each later key really is published somewhere.
    for (const [key, migration] of PUBLISHED_AFTER_CATALOGUE) {
      const body = readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8');
      expect(body).toContain(`'${key}'`);
    }
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
