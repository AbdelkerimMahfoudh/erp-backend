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

/**
 * Permission keys a revocation migration removes from a role.
 *
 * Handles both shapes in use: 0018 names one role per DELETE
 * (`r.\`key\` = 'x'`), while 0031 revokes the same key from several at once
 * (`r.\`key\` IN ('x','y')`).
 */
function revokedInSql(sql: string, roleKey: string): string[] {
  const blocks = sql.split('DELETE rp FROM').slice(1);
  const mine = blocks.filter((b) => {
    const scope = b.slice(0, b.indexOf('p.`key`') >= 0 ? b.indexOf('p.`key`') : b.length);
    return new RegExp(`r\\.\`key\`\\s*(=\\s*'${roleKey}'|IN\\s*\\([^)]*'${roleKey}')`).test(scope);
  });
  return [
    ...new Set(
      mine.flatMap((b) => {
        const after = b.slice(b.indexOf('p.`key`'));
        return [...after.matchAll(/'([a-z._]+)'/g)].map((m) => m[1]);
      }),
    ),
  ].sort();
}

/**
 * Permission keys a LATER, additive migration grants to a role. Those use the
 * `JOIN permissions p ON p.key = '<key>' … WHERE r.key = '<role>'` shape rather
 * than the backfill's `IN ( … )` list, so they need their own reader. Without
 * this, every permission added after 0017 would look like drift.
 */
function grantedInKeyedSql(sql: string, roleKey: string): string[] {
  const blocks = sql
    .split('INSERT INTO `role_permissions`')
    .slice(1)
    // A block runs until the next statement type. Without this the final INSERT
    // swallows a trailing DELETE, and the key that DELETE revokes reads as a
    // grant — which would have hidden exactly the revocation H1.2 depends on.
    .map((b) => b.split('DELETE rp FROM')[0]);
  return [
    ...new Set(
      blocks
        .filter((b) => b.includes(`r.\`key\` = '${roleKey}'`))
        // Underscores belong to a key: `transfer.cancel_own`.
        .flatMap((b) => [...b.matchAll(/p\.`key` = '([a-z._]+)'/g)].map((m) => m[1])),
    ),
  ].sort();
}

/**
 * Permission keys granted by a migration that names SEVERAL roles at once:
 * `JOIN permissions p ON p.key = '<key>' … WHERE r.key IN ('a','b')`.
 *
 * `0035` grants `sale.view` to three roles in one statement, which neither
 * earlier reader could see — so the matrix looked like it had drifted when it
 * had not. Extending the reader is the fix; loosening the assertion would throw
 * away the guarantee this test exists for.
 */
function grantedInRoleListSql(sql: string, roleKey: string): string[] {
  const blocks = sql
    .split('INSERT INTO `role_permissions`')
    .slice(1)
    .map((b) => b.split('DELETE rp FROM')[0]);
  const namesRole = new RegExp(`r\\.\`key\`\\s+IN\\s*\\([^)]*'${roleKey}'`);
  return [
    ...new Set(
      blocks
        .filter((b) => namesRole.test(b))
        .flatMap((b) => [...b.matchAll(/p\.`key` = '([a-z._]+)'/g)].map((m) => m[1])),
    ),
  ].sort();
}

/**
 * Permission keys granted by a migration that names ONE role and SEVERAL
 * permissions: `JOIN permissions p ON p.key IN ('a','b') … WHERE r.key = '<role>'`.
 *
 * The inverse of `grantedInRoleListSql`. `0036` grants six return keys to the
 * Owner in one statement and five to the Store Manager in another, which no
 * earlier reader could see — so the matrix looked like it had drifted when it
 * had not. Four readers for four shapes is more code than one loose regex, and
 * it is the reason this test can still be trusted: each reader knows exactly
 * what it is looking at, so a shape nobody taught it fails loudly instead of
 * silently returning nothing.
 */
function grantedInPermissionListSql(sql: string, roleKey: string): string[] {
  const blocks = sql
    .split('INSERT INTO \`role_permissions\`')
    .slice(1)
    .map((b) => b.split('DELETE rp FROM')[0]);
  return [
    ...new Set(
      blocks
        .filter((b) => new RegExp(`r\\.\`key\` = '${roleKey}'`).test(b))
        .flatMap((b) => {
          const start = b.indexOf('IN (');
          if (start < 0) return [];
          const list = b.slice(start, b.indexOf(')', start));
          return [...list.matchAll(/'([a-z._]+)'/g)].map((m) => m[1]);
        }),
    ),
  ].sort();
}

describe('role matrix — SQL and TypeScript must agree', () => {
  const backfill = sqlOf('0017_store_role_backfill');
  const revoke = sqlOf('0018_store_role_revoke');
  /** Additive permission migrations that grant to store-facing roles after 0017. */
  const laterGrants = [
    sqlOf('0022_price_edit_permission_backfill'),
    sqlOf('0026_catalog_manage_permission'),
    sqlOf('0031_transfer_permissions_and_lifecycle'),
    sqlOf('0032_manager_cancel_route_permission'),
    sqlOf('0035_sale_return_policy_and_view_permissions'),
    sqlOf('0036_returns_workflow'),
    sqlOf('0038_refund_payout'),
    /**
     * `0039` was missing here, and that omission hid a real drift: it grants
     * `supplier.payment.*` to the store roles, the seed matrix did not, and the
     * test compared two sets that were both silently short. A migrated company
     * could report a supplier payment and a freshly seeded one could not.
     *
     * Any migration that grants to a store role belongs in this list. The list
     * being hand-maintained is the weakness; until it is derived, adding to it
     * is part of writing a permission migration.
     */
    sqlOf('0039_supplier_settlement'),
    sqlOf('0040_financial_correction'),
    sqlOf('0044_expense_workflow'),
    sqlOf('0045_progressive_closing'),
    sqlOf('0047_goals'),
  ];
  /**
   * Revocations, applied AFTER the grants. 0031 takes `unit.transfer` away from
   * both store roles, so without subtracting these the SQL would look like it
   * still grants a permission a deployed system no longer has.
   */
  const revocations = [revoke, sqlOf('0031_transfer_permissions_and_lifecycle')];

  for (const role of ['store_manager', 'store_employee'] as const) {
    it(`${role}: migrations grant exactly what the seed grants`, () => {
      // 0017 established the baseline; later migrations add to it. A deploy
      // applies all of them, so the union is what a deployed system really has.
      const granted = new Set([
        ...grantedInSql(backfill, role),
        ...laterGrants.flatMap((sql) => grantedInKeyedSql(sql, role)),
        ...laterGrants.flatMap((sql) => grantedInRoleListSql(sql, role)),
        ...laterGrants.flatMap((sql) => grantedInPermissionListSql(sql, role)),
      ]);
      for (const sql of revocations) {
        for (const key of revokedInSql(sql, role)) granted.delete(key);
      }
      const fromSql = [...granted].sort();
      const fromTs = [...ROLE_PERMISSIONS[role]].sort();

      expect(fromSql).toEqual(fromTs);
    });
  }

  it('revocation removes exactly what the matrix no longer grants', () => {
    // Anything a revocation deletes must be absent from the TS matrix,
    // otherwise a deploy would grant it and then immediately take it away.
    for (const role of ['store_employee', 'store_manager'] as const) {
      for (const sql of revocations) {
        for (const perm of revokedInSql(sql, role)) {
          expect(ROLE_PERMISSIONS[role]).not.toContain(perm);
        }
      }
    }
  });

  it('H1.2 takes the blanket unit.transfer away from both store roles', () => {
    // The whole point of the split: one permission must no longer stand for
    // request, ship, receive and cancel at once.
    const h12 = sqlOf('0031_transfer_permissions_and_lifecycle');
    expect(revokedInSql(h12, 'store_employee')).toContain('unit.transfer');
    expect(revokedInSql(h12, 'store_manager')).toContain('unit.transfer');
  });

  it('an employee is granted no approval or general-cancel authority', () => {
    // Separation of duties, asserted against the matrix a deploy actually gets.
    const h12 = sqlOf('0031_transfer_permissions_and_lifecycle');
    const employee = grantedInKeyedSql(h12, 'store_employee');
    expect(employee).toContain('transfer.request');
    expect(employee).toContain('transfer.cancel_own');
    expect(employee).not.toContain('transfer.approve');
    expect(employee).not.toContain('transfer.cancel');
  });

  it('a manager is granted approval and both cancel keys', () => {
    /**
     * The two keys do different jobs. `transfer.cancel` is BREADTH — may cancel
     * somebody else's transfer. `transfer.cancel_own` is the ROUTE key, and
     * `PermissionsGuard` requires ALL listed permissions, so without it a
     * manager is refused before the service can decide anything. A live run
     * proved exactly that: the manager could not cancel at all, which 0032
     * repairs.
     */
    const manager = grantedInKeyedSql(sqlOf('0031_transfer_permissions_and_lifecycle'), 'store_manager');
    expect(manager).toContain('transfer.approve');
    expect(manager).toContain('transfer.cancel');

    const routeKey = grantedInKeyedSql(sqlOf('0032_manager_cancel_route_permission'), 'store_manager');
    expect(routeKey).toContain('transfer.cancel_own');
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
