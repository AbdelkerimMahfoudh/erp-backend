import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_PERMISSIONS } from '../../prisma/seed-data/permissions';

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
