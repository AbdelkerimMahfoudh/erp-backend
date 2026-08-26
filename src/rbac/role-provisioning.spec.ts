import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import {
  DEFAULT_TENANT_ROLE_KEYS,
  provisionDefaultRoles,
  type ProvisioningClient,
} from './role-provisioning';
import {
  ALL_PERMISSION_KEYS,
  ROLE_PERMISSIONS,
  STORE_FACING_ROLES,
  type RoleKey,
} from './role-permissions';

/**
 * Default role provisioning.
 *
 * The defect these pin: `RegistrationService` created three `roles` rows and no
 * `role_permissions` at all, while `AccessService` resolves authority *only*
 * from `role_permissions`. Every self-registered shop got an Owner who could
 * sign in and then do nothing. The demo company looked fine because the seed
 * carried its own separate copy of the provisioning loop — which is exactly why
 * nothing caught it.
 *
 * So these tests check two different things: that a tenant comes out with the
 * canonical matrix and nothing more, and that there is still only ONE
 * implementation and ONE matrix behind every path that provisions a tenant.
 */

// ── A fake that enforces the constraints that make this correct ────────────
//
// `roles` is unique on (company_id, key) and `role_permissions` is keyed on
// (role_id, permission_id). Idempotency and concurrency safety come from those
// constraints, so a fake that ignores them would prove nothing.

interface FakeRole {
  id: Buffer;
  companyId: Buffer;
  key: RoleKey;
  name: string;
}
interface FakeMapping {
  companyId: Buffer;
  roleId: Buffer;
  permissionId: Buffer;
}

function makeDb(catalogueKeys: string[] = ALL_PERMISSION_KEYS) {
  const permissions = catalogueKeys.map((key) => ({ id: newUuidV7Bin(), key }));
  const roles: FakeRole[] = [];
  const mappings: FakeMapping[] = [];

  const db = {
    permission: {
      findMany: jest.fn(async () => permissions.map((p) => ({ id: p.id, key: p.key }))),
    },
    role: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const { companyId, key } = where.companyId_key;
        const existing = roles.find(
          (r) => r.companyId.equals(companyId) && r.key === key,
        );
        if (existing) return { id: existing.id };
        const row: FakeRole = {
          id: create.id,
          companyId: create.companyId,
          key: create.key,
          name: create.name,
        };
        roles.push(row);
        return { id: row.id };
      }),
    },
    rolePermission: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const row of data as FakeMapping[]) {
          const clash = mappings.some(
            (m) => m.roleId.equals(row.roleId) && m.permissionId.equals(row.permissionId),
          );
          if (clash) {
            // The composite primary key. Without skipDuplicates a real database
            // would throw here, which is what makes a concurrent replay safe.
            if (!skipDuplicates) throw new Error('Duplicate entry for PRIMARY');
            continue;
          }
          mappings.push(row);
          count++;
        }
        return { count };
      }),
    },
  };

  return { db: db as unknown as ProvisioningClient, roles, mappings, permissions };
}

/** What a role actually ended up holding, as permission KEYS. */
function keysOf(
  ctx: ReturnType<typeof makeDb>,
  companyId: Buffer,
  roleKey: RoleKey,
): string[] {
  const role = ctx.roles.find((r) => r.companyId.equals(companyId) && r.key === roleKey);
  if (!role) return [];
  const byId = new Map(ctx.permissions.map((p) => [p.id.toString('hex'), p.key]));
  return ctx.mappings
    .filter((m) => m.roleId.equals(role.id))
    .map((m) => byId.get(m.permissionId.toString('hex'))!)
    .sort();
}

describe('provisioning a new tenant', () => {
  it('creates exactly the three default roles', async () => {
    const ctx = makeDb();
    const companyId = newUuidV7Bin();

    const { roleIds } = await provisionDefaultRoles(ctx.db, companyId);

    expect(ctx.roles.map((r) => r.key).sort()).toEqual(
      ['owner', 'store_employee', 'store_manager'],
    );
    expect(Object.keys(roleIds).sort()).toEqual(['owner', 'store_employee', 'store_manager']);
    // The internal SaaS role is never provisioned for a shop.
    expect(ctx.roles.map((r) => r.key)).not.toContain('administrator');
  });

  it('gives each role EXACTLY its canonical permissions — no more, no fewer', async () => {
    const ctx = makeDb();
    const companyId = newUuidV7Bin();

    await provisionDefaultRoles(ctx.db, companyId);

    for (const roleKey of STORE_FACING_ROLES) {
      expect(keysOf(ctx, companyId, roleKey)).toEqual([...ROLE_PERMISSIONS[roleKey]].sort());
    }
  });

  it('grants the Owner the whole catalogue, and the others strictly less', async () => {
    const ctx = makeDb();
    const companyId = newUuidV7Bin();
    await provisionDefaultRoles(ctx.db, companyId);

    const owner = keysOf(ctx, companyId, 'owner');
    const manager = keysOf(ctx, companyId, 'store_manager');
    const employee = keysOf(ctx, companyId, 'store_employee');

    expect(owner).toEqual([...ALL_PERMISSION_KEYS].sort());
    expect(manager.length).toBeLessThan(owner.length);
    expect(employee.length).toBeLessThan(manager.length);
    // Every subordinate permission is one the Owner also holds.
    for (const k of [...manager, ...employee]) expect(owner).toContain(k);
  });

  it('assigns no permission that is not in the catalogue', async () => {
    const ctx = makeDb();
    const companyId = newUuidV7Bin();
    await provisionDefaultRoles(ctx.db, companyId);

    const catalogue = new Set(ALL_PERMISSION_KEYS);
    for (const roleKey of STORE_FACING_ROLES) {
      for (const key of keysOf(ctx, companyId, roleKey)) expect(catalogue.has(key)).toBe(true);
    }
  });

  it('keeps the Manager and Employee boundaries that were decided', async () => {
    const ctx = makeDb();
    const companyId = newUuidV7Bin();
    await provisionDefaultRoles(ctx.db, companyId);

    const manager = keysOf(ctx, companyId, 'store_manager');
    const employee = keysOf(ctx, companyId, 'store_employee');

    // Positive: a manager runs the return workflow and sees cost.
    expect(manager).toEqual(expect.arrayContaining(['return.approve', 'cost.view', 'sale.view']));
    // Negative: spend authority and below-cost override stay with the Owner.
    expect(manager).not.toContain('expense.manage');
    expect(manager).not.toContain('discount.override');
    expect(manager).not.toContain('return.exception');

    /*
     * Positive: an employee sells, and — deliberately — SEES COST. That is not
     * an oversight in the matrix: an employee who cannot see cost cannot tell
     * whether the price they are about to accept loses money, which is one of
     * the mistakes this product exists to prevent. They still cannot override
     * it.
     */
    expect(employee).toEqual(expect.arrayContaining(['sale.create', 'cost.view']));

    // Negative: they report, they do not decide. Approving a return, signing
    // the day off, reviewing spend and overriding cost are all elsewhere.
    expect(employee).not.toContain('return.approve');
    expect(employee).not.toContain('closing.perform');
    expect(employee).not.toContain('expense.manage');
    expect(employee).not.toContain('discount.override');
    expect(employee).not.toContain('settings.manage');
  });

  it('confers no platform-administrator authority', async () => {
    const ctx = makeDb();
    const companyId = newUuidV7Bin();
    await provisionDefaultRoles(ctx.db, companyId);

    /*
     * Platform authority is not a permission at all — it lives in the separate
     * `platform_admins` table behind its own guard, so no tenant role can reach
     * it. This asserts the other half: nothing platform-shaped leaked INTO the
     * tenant catalogue where a role could pick it up.
     */
    const everything = STORE_FACING_ROLES.flatMap((r) => keysOf(ctx, companyId, r));
    for (const key of everything) {
      expect(key).not.toMatch(/^platform\./);
      expect(key).not.toMatch(/admin\.(impersonate|businesses|subscription)/);
    }
  });

  it('is company-scoped: two tenants get their own roles and mappings', async () => {
    const ctx = makeDb();
    const a = newUuidV7Bin();
    const b = newUuidV7Bin();

    await provisionDefaultRoles(ctx.db, a);
    await provisionDefaultRoles(ctx.db, b);

    expect(ctx.roles.filter((r) => r.companyId.equals(a))).toHaveLength(3);
    expect(ctx.roles.filter((r) => r.companyId.equals(b))).toHaveLength(3);
    // No mapping is attributed to the wrong company.
    for (const m of ctx.mappings) {
      const role = ctx.roles.find((r) => r.id.equals(m.roleId))!;
      expect(m.companyId.equals(role.companyId)).toBe(true);
    }
    expect(keysOf(ctx, a, 'owner')).toEqual(keysOf(ctx, b, 'owner'));
  });

  it('is idempotent: a replay creates no duplicate role or mapping', async () => {
    const ctx = makeDb();
    const companyId = newUuidV7Bin();

    const first = await provisionDefaultRoles(ctx.db, companyId);
    const rolesAfterFirst = ctx.roles.length;
    const mappingsAfterFirst = ctx.mappings.length;

    const second = await provisionDefaultRoles(ctx.db, companyId);

    expect(first.mappingsCreated).toBeGreaterThan(0);
    expect(second.mappingsCreated).toBe(0);
    expect(ctx.roles).toHaveLength(rolesAfterFirst);
    expect(ctx.mappings).toHaveLength(mappingsAfterFirst);
    // The same rows, not replacements.
    expect(second.roleIds.owner.equals(first.roleIds.owner)).toBe(true);
  });

  it('survives a concurrent replay without duplicate rows', async () => {
    const ctx = makeDb();
    const companyId = newUuidV7Bin();

    // Both calls interleave against the same store, as two retries of the same
    // idempotent registration would.
    const [a, b] = await Promise.all([
      provisionDefaultRoles(ctx.db, companyId),
      provisionDefaultRoles(ctx.db, companyId),
    ]);

    expect(ctx.roles).toHaveLength(3);
    for (const roleKey of STORE_FACING_ROLES) {
      expect(keysOf(ctx, companyId, roleKey)).toEqual([...ROLE_PERMISSIONS[roleKey]].sort());
    }
    // Between them they inserted each mapping exactly once.
    expect(a.mappingsCreated + b.mappingsCreated).toBe(ctx.mappings.length);
  });

  it('refuses an unknown role key rather than provisioning something undefined', async () => {
    const ctx = makeDb();
    await expect(
      provisionDefaultRoles(ctx.db, newUuidV7Bin(), ['not_a_role' as RoleKey]),
    ).rejects.toThrow(/Unknown role key/);
    expect(ctx.roles).toHaveLength(0);
  });

  it('refuses a partial role when the catalogue is missing a permission', async () => {
    // A database whose `permissions` table is short one row. Provisioning a
    // silently smaller Owner is the failure being repaired, so this must throw
    // rather than quietly grant 60 of 61.
    const short = ALL_PERMISSION_KEYS.filter((k) => k !== 'sale.create');
    const ctx = makeDb(short);

    await expect(provisionDefaultRoles(ctx.db, newUuidV7Bin())).rejects.toThrow(
      /not in the database catalogue/,
    );
    expect(ctx.mappings).toHaveLength(0);
  });

  it('provisions exactly the store-facing three by default', () => {
    expect([...DEFAULT_TENANT_ROLE_KEYS]).toEqual([...STORE_FACING_ROLES]);
    expect([...DEFAULT_TENANT_ROLE_KEYS]).not.toContain('administrator');
  });
});

// ── One matrix, one implementation ────────────────────────────────────────

describe('there is only one canonical source', () => {
  const SRC = join(__dirname, '..');
  const PRISMA = join(__dirname, '..', '..', 'prisma');
  const CANONICAL = join(SRC, 'rbac', 'role-permissions.ts');

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'migrations' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...tsFiles(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('registration and the seed both provision through the same function', () => {
    const registration = readFileSync(
      join(SRC, 'platform', 'registration.service.ts'),
      'utf8',
    );
    const seed = readFileSync(join(PRISMA, 'seed.ts'), 'utf8');

    for (const source of [registration, seed]) {
      expect(source).toMatch(/provisionDefaultRoles\(/);
      // Neither may build role_permissions rows by hand any more.
      expect(source).not.toMatch(/rolePermission\.(create|createMany|upsert)\b/);
    }
    // And registration no longer creates bare roles without permissions.
    expect(registration).not.toMatch(/tx\.role\.create\(/);
  });

  it('the seed re-exports the matrix rather than redeclaring it', () => {
    const shim = readFileSync(join(PRISMA, 'seed-data', 'permissions.ts'), 'utf8');
    expect(shim).toMatch(/export\s*\{[\s\S]*ROLE_PERMISSIONS[\s\S]*\}\s*from\s*'\.\.\/\.\.\/src\/rbac\/role-permissions'/);
    expect(shim).not.toMatch(/ROLE_PERMISSIONS\s*[:=]\s*\{/);
  });

  it('no second hand-maintained role matrix exists anywhere', () => {
    /*
     * A copied permission array is what caused this defect, so the shape itself
     * is banned rather than trusted to review: any non-canonical source file
     * that declares a mapping from a default role key to a list of permission
     * keys fails here.
     */
    const offenders: string[] = [];
    const roleKeyPattern = /(owner|store_manager|store_employee)\s*:\s*\[/;

    for (const file of [...tsFiles(SRC), ...tsFiles(PRISMA)]) {
      if (file === CANONICAL) continue;
      if (file.endsWith('.spec.ts')) continue; // tests assert on the matrix by design
      const source = readFileSync(file, 'utf8');
      if (!roleKeyPattern.test(source)) continue;

      // Only complain when the array actually holds permission keys.
      const looksLikePermissions = ALL_PERMISSION_KEYS.some((k) =>
        source.includes(`'${k}'`),
      );
      if (looksLikePermissions) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
