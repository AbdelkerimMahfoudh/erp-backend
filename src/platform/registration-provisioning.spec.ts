import { RegistrationService } from './registration.service';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';
import { ALL_PERMISSION_KEYS, ROLE_PERMISSIONS, STORE_FACING_ROLES } from '../rbac/role-permissions';

/**
 * What a self-service registration must leave behind.
 *
 * The defect: registration created the company, the branch, three `roles` rows
 * and the Owner — and no `role_permissions` at all. `AccessService` resolves
 * authority only from `role_permissions`, so the shop could sign in and then do
 * nothing.
 *
 * The other half of the fix is atomicity. Provisioning now happens inside the
 * transaction that creates the company, so a failure anywhere cannot leave a
 * half-built tenant: a shop with roles but no Owner is not recoverable by the
 * shopkeeper, and not obviously broken to anyone else.
 */

// ── A store that behaves like the database, including rollback ─────────────

function makeStore(failOn?: string) {
  const tables: Record<string, any[]> = {
    registrationAttempt: [],
    company: [],
    branch: [],
    role: [],
    rolePermission: [],
    user: [],
    userBranch: [],
    subscription: [],
    subscriptionEvent: [],
  };
  const permissions = ALL_PERMISSION_KEYS.map((key) => ({ id: newUuidV7Bin(), key }));

  /** A client bound to one set of tables — the real ones, or a scratch copy. */
  function clientOn(t: Record<string, any[]>): any {
    const simple = (name: string) => ({
      create: jest.fn(async ({ data }: any) => {
        // Lets a test fail one specific write partway through the transaction,
        // after roles and permissions have already been written.
        if (failOn === name) throw new Error(`${name} insert failed`);
        t[name].push({ ...data, createdAt: new Date() });
        return data;
      }),
      findMany: jest.fn(async () => t[name]),
    });

    return {
      permission: { findMany: jest.fn(async () => permissions) },
      role: {
        upsert: jest.fn(async ({ where, create }: any) => {
          const { companyId, key } = where.companyId_key;
          const found = t.role.find((r) => r.companyId.equals(companyId) && r.key === key);
          if (found) return { id: found.id };
          t.role.push({ ...create });
          return { id: create.id };
        }),
      },
      rolePermission: {
        createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
          let count = 0;
          for (const row of data) {
            const clash = t.rolePermission.some(
              (m: any) => m.roleId.equals(row.roleId) && m.permissionId.equals(row.permissionId),
            );
            if (clash) {
              if (!skipDuplicates) throw new Error('Duplicate entry for PRIMARY');
              continue;
            }
            t.rolePermission.push(row);
            count++;
          }
          return { count };
        }),
      },
      registrationAttempt: {
        ...simple('registrationAttempt'),
        findUnique: jest.fn(async ({ where }: any) =>
          t.registrationAttempt.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null,
        ),
      },
      company: {
        ...simple('company'),
        findUniqueOrThrow: jest.fn(async ({ where }: any) => {
          const row = t.company.find((c) => c.id.equals(where.id));
          if (!row) throw new Error('not found');
          return row;
        }),
      },
      branch: {
        ...simple('branch'),
        findFirstOrThrow: jest.fn(async ({ where }: any) => {
          const row = t.branch.find((b) => b.companyId.equals(where.companyId));
          if (!row) throw new Error('not found');
          return row;
        }),
      },
      user: {
        ...simple('user'),
        findFirstOrThrow: jest.fn(async ({ where }: any) => {
          const row = t.user.find((u) => u.companyId.equals(where.companyId));
          if (!row) throw new Error('not found');
          return row;
        }),
      },
      userBranch: simple('userBranch'),
      subscription: simple('subscription'),
      subscriptionEvent: simple('subscriptionEvent'),

      /**
       * A real transaction, in the one way that matters here: the callback
       * writes to a COPY, and the copy is published only when it resolves. A
       * throw discards everything, exactly as a rollback does.
       */
      $transaction: jest.fn(async (fn: any) => {
        const scratch: Record<string, any[]> = {};
        for (const k of Object.keys(t)) scratch[k] = [...t[k]];
        const result: unknown = await fn(clientOn(scratch));
        for (const k of Object.keys(t)) t[k] = scratch[k];
        return result;
      }),
    };
  }

  return { tables, permissions, client: clientOn(tables) };
}

const hashing = { hash: jest.fn(async (p: string) => `hashed:${p}`) };

function makeService(store: ReturnType<typeof makeStore>) {
  return new RegistrationService(store.client as any, hashing as any);
}

const INPUT = {
  idempotencyKey: 'key-1',
  ownerName: 'Aisha',
  businessName: 'Aisha Electronics',
  branchName: 'Main',
  city: 'Nouakchott',
  email: 'aisha@example.invalid',
  password: 'a-good-password',
  language: 'en' as const,
};

function keysFor(store: ReturnType<typeof makeStore>, roleKey: string): string[] {
  const role = store.tables.role.find((r: any) => r.key === roleKey);
  if (!role) return [];
  const byId = new Map(store.permissions.map((p) => [p.id.toString('hex'), p.key]));
  return store.tables.rolePermission
    .filter((m: any) => m.roleId.equals(role.id))
    .map((m: any) => byId.get(m.permissionId.toString('hex'))!)
    .sort();
}

describe('self-service registration provisions a usable tenant', () => {
  it('creates the company, branch, Owner, subscription AND all three roles', async () => {
    const store = makeStore();
    const result = await makeService(store).register(INPUT);

    expect(result.status).toBe('pending_activation');
    expect(store.tables.company).toHaveLength(1);
    expect(store.tables.branch).toHaveLength(1);
    expect(store.tables.user).toHaveLength(1);
    expect(store.tables.subscription).toHaveLength(1);
    expect(store.tables.role.map((r: any) => r.key).sort()).toEqual(
      ['owner', 'store_employee', 'store_manager'],
    );
  });

  it('gives every default role exactly its canonical permissions', async () => {
    const store = makeStore();
    await makeService(store).register(INPUT);

    for (const roleKey of STORE_FACING_ROLES) {
      expect(keysFor(store, roleKey)).toEqual([...ROLE_PERMISSIONS[roleKey]].sort());
    }
    // The Owner can actually use the app — the exact thing that was broken.
    expect(keysFor(store, 'owner')).toContain('report.view');
  });

  it('assigns no permission beyond the canonical matrix', async () => {
    const store = makeStore();
    await makeService(store).register(INPUT);

    const expected = new Set(
      STORE_FACING_ROLES.flatMap((r) => ROLE_PERMISSIONS[r]),
    );
    for (const roleKey of STORE_FACING_ROLES) {
      for (const key of keysFor(store, roleKey)) expect(expected.has(key)).toBe(true);
    }
    const total = STORE_FACING_ROLES.reduce((n, r) => n + ROLE_PERMISSIONS[r].length, 0);
    expect(store.tables.rolePermission).toHaveLength(total);
  });

  it('gives the Owner no platform-administrator authority', async () => {
    const store = makeStore();
    await makeService(store).register(INPUT);

    // Registration writes nothing to the platform side at all. Platform
    // authority lives in `platform_admins` behind its own guard, and a tenant
    // role cannot reach it.
    expect(Object.keys(store.tables)).not.toContain('platformAdmin');
    for (const key of keysFor(store, 'owner')) expect(key).not.toMatch(/^platform\./);
  });

  it('leaves the subscription pending — provisioning grants nothing', async () => {
    const store = makeStore();
    await makeService(store).register(INPUT);

    expect(store.tables.subscription[0].status).toBe('pending_activation');
    expect(store.tables.subscription[0].currentPeriodEnd).toBeNull();
    expect(store.tables.subscriptionEvent[0].kind).toBe('registered');
    expect(store.tables.subscriptionEvent[0].actor).toBe('self-service');
  });

  it('rolls the WHOLE tenant back when a later write fails', async () => {
    // The subscription insert fails — AFTER the roles and their permissions
    // have been written inside the same transaction.
    const store = makeStore('subscription');

    await expect(makeService(store).register(INPUT)).rejects.toThrow(
      'subscription insert failed',
    );

    // Nothing survived. Above all no orphan roles or mappings: a company with
    // permissions but no Owner is not something a shopkeeper can fix, and not
    // obviously broken to anybody else.
    expect(store.tables.company).toHaveLength(0);
    expect(store.tables.branch).toHaveLength(0);
    expect(store.tables.role).toHaveLength(0);
    expect(store.tables.rolePermission).toHaveLength(0);
    expect(store.tables.user).toHaveLength(0);
    expect(store.tables.registrationAttempt).toHaveLength(0);
  });

  it('replaying the same idempotency key creates no second tenant or mapping', async () => {
    const store = makeStore();
    const service = makeService(store);

    const first = await service.register(INPUT);
    const rolesAfter = store.tables.role.length;
    const mappingsAfter = store.tables.rolePermission.length;

    const second = await service.register(INPUT);

    expect(second.companyId).toBe(first.companyId);
    expect(second.created).toBe(false);
    expect(store.tables.company).toHaveLength(1);
    expect(store.tables.role).toHaveLength(rolesAfter);
    expect(store.tables.rolePermission).toHaveLength(mappingsAfter);
  });

  it('keeps two registered businesses isolated from each other', async () => {
    const store = makeStore();
    const service = makeService(store);

    await service.register(INPUT);
    await service.register({
      ...INPUT,
      idempotencyKey: 'key-2',
      businessName: 'Second Shop',
      email: 'second@example.invalid',
    });

    expect(store.tables.company).toHaveLength(2);
    expect(store.tables.role).toHaveLength(6);

    // Every mapping belongs to the company that owns its role.
    for (const m of store.tables.rolePermission) {
      const role = store.tables.role.find((r: any) => r.id.equals(m.roleId));
      expect(m.companyId.equals(role.companyId)).toBe(true);
    }

    const companies = store.tables.company.map((c: any) => binToUuid(c.id));
    expect(new Set(companies).size).toBe(2);
  });
});
