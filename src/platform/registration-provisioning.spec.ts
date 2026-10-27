import { RegistrationService } from './registration.service';
import { newUuidV7Bin, binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { ALL_PERMISSION_KEYS, ROLE_PERMISSIONS, STORE_FACING_ROLES } from '../rbac/role-permissions';
import { stateOf } from '../entitlement/entitlement-rules';
import { trialFactsOf } from './trial/trial-rules';
import { DEFAULT_CATEGORIES } from '../catalog/default-categories';

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
    trialEligibility: [],
    trialClaim: [],
    productCategory: [],
  };
  const permissions = ALL_PERMISSION_KEYS.map((key) => ({ id: newUuidV7Bin(), key }));

  /** A client bound to one set of tables — the real ones, or a scratch copy. */
  function clientOn(t: Record<string, any[]>): any {
    const simple = (name: string) => ({
      create: jest.fn(async ({ data }: any) => {
        // Lets a test fail one specific write partway through the transaction,
        // after roles and permissions have already been written.
        if (failOn === name) throw new Error(`${name} insert failed`);
        // The instant the service passes wins; the column default stands in only when it passes none.
        t[name].push({ createdAt: new Date(), ...data });
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
      productCategory: simple('productCategory'),
      subscription: simple('subscription'),
      subscriptionEvent: simple('subscriptionEvent'),
      // The free trial's rows (0095): one eligibility per company, and the claim the Owner may make later.
      trialEligibility: {
        // The columns' defaults: an eligibility is created open, on the only basis there is.
        create: jest.fn(async ({ data }: any) => {
          if (failOn === 'trialEligibility') throw new Error('trialEligibility insert failed');
          t.trialEligibility.push({ basis: 'self_registration', closedAt: null, closedReason: null, ...data });
          return data;
        }),
        findUnique: jest.fn(async ({ where }: any) => t.trialEligibility.find((e) => e.companyId.equals(where.companyId)) ?? null),
      },
      trialClaim: {
        findUnique: jest.fn(async ({ where }: any) => t.trialClaim.find((c) => c.companyId.equals(where.companyId)) ?? null),
      },

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
const REGISTERED_AT = new Date('2026-10-13T08:30:00.250Z');
const clock = { now: () => REGISTERED_AT };

function makeService(store: ReturnType<typeof makeStore>) {
  return new RegistrationService(store.client as any, hashing as any, clock);
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

  it('gives the new company the built-in categories, each subcategory under its own parent (D223)', async () => {
    const store = makeStore();
    await makeService(store).register(INPUT);

    const rows = store.tables.productCategory;
    expect(rows).toHaveLength(DEFAULT_CATEGORIES.length);
    const companyId = store.tables.company[0].id;
    const byKey = new Map(rows.map((r: any) => [r.key, r]));
    for (const c of DEFAULT_CATEGORIES) {
      const row: any = byKey.get(c.key);
      expect(row.companyId.equals(companyId)).toBe(true);
      expect(row.defaultTrackingType).toBe(c.trackingType);
      if (c.parentKey) expect(row.parentId.equals((byKey.get(c.parentKey) as any).id)).toBe(true);
      else expect(row.parentId).toBeNull();
    }
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
    expect(store.tables.productCategory).toHaveLength(0);
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

/**
 * The free trial's eligibility (0095; the owner's decisions of 2026-10-13).
 *
 * A business that registers ITSELF — the public routes, on the website or in the app — is eligible for one free
 * trial: eligible, never started. A business the Super Admin creates is not, and nothing else that creates people or
 * stores makes anybody eligible. The registration itself starts nothing.
 */
describe('a business that registers itself may claim one free trial — and registering starts nothing', () => {
  /** The state the shop is told, from the registration's own rows, by the rules every request is judged by. */
  function stateAfter(store: ReturnType<typeof makeStore>, companyId: string, now = REGISTERED_AT) {
    const id = uuidToBin(companyId);
    const sub = store.tables.subscription.find((r: any) => r.companyId.equals(id));
    const eligibility = store.tables.trialEligibility.find((r: any) => r.companyId.equals(id)) ?? null;
    return stateOf({ ...sub, trial: trialFactsOf(eligibility, null) }, now);
  }

  it('public self-registration: one open eligibility, by the contact given, at the server instant — and no claim', async () => {
    const store = makeStore();
    const result = await makeService(store).register({ ...INPUT, trialEligible: true });

    expect(result.trialEligible).toBe(true);
    expect(store.tables.trialEligibility).toHaveLength(1);
    const eligibility = store.tables.trialEligibility[0];
    expect(eligibility.companyId.equals(uuidToBin(result.companyId))).toBe(true);
    expect(eligibility.ownerUserId.equals(uuidToBin(result.ownerUserId))).toBe(true);
    expect(eligibility.registrationMethod).toBe('email');
    expect(eligibility.createdAt).toEqual(REGISTERED_AT);
    expect(eligibility).toMatchObject({ basis: 'self_registration', closedAt: null, closedReason: null });
    // Nothing started: no claim, the subscription still pending with no period, and the state "not started".
    expect(store.tables.trialClaim).toHaveLength(0);
    expect(store.tables.subscription[0]).toMatchObject({ status: 'pending_activation', currentPeriodEnd: null });
    expect(stateAfter(store, result.companyId)).toBe('trial_available');
  });

  it('the timeline says eligible and not started — after the registration it belongs to', async () => {
    const store = makeStore();
    await makeService(store).register({ ...INPUT, trialEligible: true });

    expect(store.tables.subscriptionEvent.map((e: any) => e.kind)).toEqual(['registered', 'trial_eligible']);
    const [registered, eligible] = store.tables.subscriptionEvent;
    expect(registered.note).toBe('Self-service registration. Nothing is active yet.');
    expect(eligible).toMatchObject({
      note: 'Eligible for one 7-day free trial, to be claimed by the Owner on the Dukan ERP website. Not started.',
      actor: 'self-service',
      createdAt: REGISTERED_AT,
    });
    expect(eligible.subscriptionId.equals(store.tables.subscription[0].id)).toBe(true);
  });

  it('records which contacts were given: both given, both required', async () => {
    const both = makeStore();
    await makeService(both).register({ ...INPUT, phone: '+22236001234', trialEligible: true });
    expect(both.tables.trialEligibility[0].registrationMethod).toBe('both');

    const phoneOnly = makeStore();
    await makeService(phoneOnly).register({ ...INPUT, email: undefined, phone: '+22236001234', trialEligible: true });
    expect(phoneOnly.tables.trialEligibility[0].registrationMethod).toBe('phone');
  });

  it('a business the Super Admin creates is not eligible: no eligibility, no trial event, pending', async () => {
    const store = makeStore();
    const result = await makeService(store).register({
      ...INPUT,
      idempotencyKey: 'admin:key-1',
      actor: 'ops@example.test',
      note: 'Created by the platform for the shop. Awaiting approval.',
    });

    expect(result.trialEligible).toBe(false);
    expect(store.tables.trialEligibility).toHaveLength(0);
    expect(store.tables.subscriptionEvent.map((e: any) => e.kind)).toEqual(['registered']);
    expect(stateAfter(store, result.companyId)).toBe('pending');
  });

  it('eligibility is never the default: a caller that says nothing makes nobody eligible', async () => {
    const store = makeStore();
    const result = await makeService(store).register(INPUT);
    expect(result.trialEligible).toBe(false);
    expect(store.tables.trialEligibility).toHaveLength(0);
    expect(store.tables.subscriptionEvent[0].note).toBe('Self-service registration. Awaiting activation.');
  });

  it('a retry creates no second eligibility, and says what the business holds now', async () => {
    const store = makeStore();
    const service = makeService(store);
    const first = await service.register({ ...INPUT, trialEligible: true });
    const again = await service.register({ ...INPUT, trialEligible: true });

    expect(again).toMatchObject({ companyId: first.companyId, created: false, trialEligible: true });
    expect(store.tables.trialEligibility).toHaveLength(1);
    expect(store.tables.subscriptionEvent.filter((e: any) => e.kind === 'trial_eligible')).toHaveLength(1);

    // Once the trial was claimed, the same retry no longer reports an unused trial.
    store.tables.trialClaim.push({ companyId: uuidToBin(first.companyId), claimedAt: REGISTERED_AT });
    expect((await service.register({ ...INPUT, trialEligible: true })).trialEligible).toBe(false);
  });

  it('a closed eligibility is no trial to report', async () => {
    const store = makeStore();
    const service = makeService(store);
    const first = await service.register({ ...INPUT, trialEligible: true });
    store.tables.trialEligibility[0].closedAt = new Date('2026-10-14T00:00:00.000Z');
    expect((await service.register({ ...INPUT, trialEligible: true })).trialEligible).toBe(false);
    expect(first.trialEligible).toBe(true);
  });

  it('the eligibility rolls back with the tenant it belongs to', async () => {
    const store = makeStore('trialEligibility');
    await expect(makeService(store).register({ ...INPUT, trialEligible: true })).rejects.toThrow('trialEligibility insert failed');
    expect(store.tables.company).toHaveLength(0);
    expect(store.tables.trialEligibility).toHaveLength(0);
    expect(store.tables.subscriptionEvent).toHaveLength(0);
  });
});
