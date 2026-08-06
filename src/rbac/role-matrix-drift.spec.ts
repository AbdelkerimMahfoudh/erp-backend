import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../prisma/seed-data/permissions';

/**
 * The permission matrix is written down twice, and both copies matter.
 *
 * TypeScript (`seed-data/permissions.ts`) is what the seed applies. SQL
 * (`0017_store_role_backfill`) is what a production `migrate deploy` applies —
 * and deploy never runs the seed, so the SQL is the only thing a real
 * deployment gets. If they drift, a deployed system silently has different
 * access from a seeded one, which is the worst kind of permission bug: nothing
 * errors, the wrong people just can or cannot do things.
 *
 * These tests fail the build the moment the two disagree.
 */

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

function sqlOf(name: string): string {
  return readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');
}

/** Permission keys the backfill grants to a role, read out of the SQL. */
function grantedInSql(sql: string, roleKey: string): string[] {
  // Each grant is an INSERT ... JOIN permissions p ON p.`key` IN ( ... )
  // followed by WHERE r.`key` = '<role>'.
  const blocks = sql.split('INSERT INTO `role_permissions`').slice(1);
  const block = blocks.find((b) => b.includes(`r.\`key\` = '${roleKey}'`));
  if (!block) return [];
  const list = block.slice(block.indexOf('IN ('), block.indexOf(')', block.indexOf('IN (')));
  return [...list.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]).sort();
}

/** Permission keys the revocation migration removes from a role. */
function revokedInSql(sql: string, roleKey: string): string[] {
  const blocks = sql.split('DELETE rp FROM').slice(1);
  const block = blocks.find((b) => b.includes(`r.\`key\` = '${roleKey}'`));
  if (!block) return [];
  const after = block.slice(block.indexOf('p.`key`'));
  return [...after.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]).sort();
}

describe('role matrix — SQL and TypeScript must agree', () => {
  const backfill = sqlOf('0017_store_role_backfill');
  const revoke = sqlOf('0018_store_role_revoke');

  for (const role of ['store_manager', 'store_employee'] as const) {
    it(`${role}: backfill SQL grants exactly what the seed grants`, () => {
      const fromSql = grantedInSql(backfill, role);
      const fromTs = [...ROLE_PERMISSIONS[role]].sort();

      expect(fromSql).toEqual(fromTs);
    });
  }

  it('revocation removes exactly what the matrix no longer grants', () => {
    // Anything the revocation deletes must be absent from the TS matrix,
    // otherwise a deploy would grant it and then immediately take it away.
    for (const role of ['store_employee', 'store_manager'] as const) {
      for (const perm of revokedInSql(revoke, role)) {
        expect(ROLE_PERMISSIONS[role]).not.toContain(perm);
      }
    }
  });

  it('revokes the specific over-grants the audit found', () => {
    expect(revokedInSql(revoke, 'store_employee')).toEqual(['import.run', 'sale.return']);
    expect(revokedInSql(revoke, 'store_manager')).toEqual(['discount.override']);
  });

  it('the backfill never touches owner or administrator', () => {
    // Owner must be unchanged, and administrator is an internal SaaS role that
    // has no business in a store-role migration.
    expect(backfill).not.toMatch(/r\.`key` = 'owner'/);
    expect(backfill).not.toMatch(/r\.`key` = 'administrator'/);
  });

  it('the backfill only ever remaps away from legacy roles', () => {
    // Matching solely on the old value is what makes a rerun a no-op.
    expect(backfill).toMatch(/old\.`key` IN \('sales_employee', 'warehouse_employee'\)/);
    expect(backfill).toMatch(/old\.`key` = 'branch_manager'/);
  });

  it('every inserting statement is guarded so a rerun changes nothing', () => {
    const inserts = backfill.split('INSERT INTO').slice(1);
    expect(inserts.length).toBeGreaterThan(0);
    for (const stmt of inserts) {
      expect(stmt).toMatch(/NOT EXISTS/);
    }
  });
});

/**
 * `price.edit` repeats the D2.1 lesson one level down.
 *
 * 0021 created the delegation TABLE, but the permission ROW is reference data,
 * and reference data lives in the seed — which `migrate deploy` never runs. A
 * production deploy would have produced a delegation table with nothing
 * delegatable and Owners silently missing an authority the code assumes they
 * hold. 0022 closes that, and these tests keep the SQL and the TypeScript
 * catalogue from drifting apart again.
 */
describe('price.edit — migration and seed must agree', () => {
  const backfill = sqlOf('0022_price_edit_permission_backfill');

  /** Roles the migration inserts a `role_permissions` row for. */
  const rolesGrantedInSql = (): string[] =>
    [...backfill.split('INSERT INTO `role_permissions`').slice(1).join('\n').matchAll(/r\.`key` = '(\w+)'/g)]
      .map((m) => m[1])
      .sort();

  it('creates the catalogue row the seed defines, with the same key and label', () => {
    const seeded = PERMISSIONS.find((p) => p.key === 'price.edit');
    expect(seeded).toBeDefined();
    expect(backfill).toContain("'price.edit'");
    // The label is user-visible; a mismatch between deploy and seed would show
    // two different names for one authority depending on how you installed.
    expect(backfill).toContain(`'${seeded!.label}'`);
  });

  it('grants it to Owner and to nobody else', () => {
    expect(rolesGrantedInSql()).toEqual(['owner']);
  });

  it('never grants it to a manager, an employee or the administrator', () => {
    // Store Manager receives it only per branch, per assignment, by an explicit
    // Owner grant — never from the base role.
    for (const role of ['store_manager', 'store_employee', 'administrator']) {
      expect(backfill).not.toMatch(new RegExp(`r\\.\`key\` = '${role}'`));
    }
  });

  it('agrees with the TypeScript matrix about who holds it by role', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('price.edit');
    expect(ROLE_PERMISSIONS.store_manager).not.toContain('price.edit');
    expect(ROLE_PERMISSIONS.store_employee).not.toContain('price.edit');
    expect(ROLE_PERMISSIONS.administrator).not.toContain('price.edit');
  });

  it('matches on the stable KEY, never on an id', () => {
    // The development database already had `price.edit` with a hand-generated
    // id before this migration existed. Guarding on the key is what makes the
    // migration correct there AND on a fresh deploy.
    expect(backfill).toMatch(/p\.`key` = 'price\.edit'/);
    expect(backfill).toMatch(/NOT EXISTS/);
  });

  it('every inserting statement is guarded, so a rerun cannot duplicate', () => {
    const inserts = backfill.split('INSERT INTO').slice(1);
    expect(inserts).toHaveLength(2); // the permission row, and the Owner mapping
    for (const stmt of inserts) {
      expect(stmt).toMatch(/NOT EXISTS/);
    }
  });

  it('carries company_id from the role, preserving the tenant relationship', () => {
    expect(backfill).toMatch(/SELECT r\.`company_id`, r\.`id`, p\.`id`/);
  });

  it('does not edit the already-applied 0021 migration', () => {
    // 0021 is recorded in _prisma_migrations; changing it would break every
    // database that already ran it. Corrections move forward.
    const applied = sqlOf('0021_user_branch_permissions');
    expect(applied).not.toContain("'price.edit'");
    expect(applied).not.toContain('INSERT INTO `role_permissions`');
  });
});
