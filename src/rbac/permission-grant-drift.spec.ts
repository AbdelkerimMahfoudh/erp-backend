import { PrismaClient } from '@prisma/client';
import { verifyCatalogue } from '../../scripts/verify-permission-catalogue';
import { ALL_PERMISSION_KEYS, ROLE_LABELS, ROLE_PERMISSIONS } from './role-permissions';

/**
 * A perfect catalogue with wrong grants.
 *
 * The CP6 live run found `discount.override` still mapped to the retired
 * `branch_manager` role in the database. A2 removed it from the code when
 * approval became Owner-only; the `role_permissions` row stayed, and
 * `AccessService` resolves authority from that table and nothing else — so the
 * retired role could still approve a discount at a shop that still assigned it.
 *
 * The deploy gate reported **61/61, catalogue complete**, because it only ever
 * asked whether the KEYS exist. Every key existing says nothing about who holds
 * them. These tests pin the difference.
 */

/** Just enough of a Prisma client for the two reads the verifier makes. */
function fakePrisma(roles: { name: string; keys: string[] }[]): PrismaClient {
  return {
    permission: {
      findMany: async () => ALL_PERMISSION_KEYS.map((key) => ({ key, label: labelFor(key) })),
    },
    role: {
      findMany: async () =>
        roles.map((r) => ({
          name: r.name,
          rolePermissions: r.keys.map((key) => ({ permission: { key } })),
        })),
    },
  } as unknown as PrismaClient;
}

// Labels are display text and drift harmlessly; the verifier already says so.
function labelFor(key: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PERMISSIONS } = require('./role-permissions') as { PERMISSIONS: { key: string; label: string }[] };
  return PERMISSIONS.find((p) => p.key === key)?.label ?? key;
}

const correctRole = (roleKey: keyof typeof ROLE_PERMISSIONS) => ({
  name: ROLE_LABELS[roleKey],
  keys: ROLE_PERMISSIONS[roleKey],
});

describe('grants, not just keys', () => {
  it('passes when every role holds exactly what the codebase grants it', async () => {
    const report = await verifyCatalogue(fakePrisma([correctRole('owner'), correctRole('store_manager')]));
    expect(report.grants).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('REFUSES a role holding authority the codebase does not give it', async () => {
    /*
     * The live finding, in miniature. An extra grant is authority nobody
     * decided to give — the shape of every privilege escalation — so it fails
     * the gate rather than being reported and shrugged at.
     */
    const report = await verifyCatalogue(
      fakePrisma([
        correctRole('owner'),
        { name: ROLE_LABELS.branch_manager, keys: [...ROLE_PERMISSIONS.branch_manager, 'discount.override'] },
      ]),
    );
    expect(report.ok).toBe(false);
    const drift = report.grants.find((g) => g.roleKey === 'branch_manager');
    expect(drift?.extra).toEqual(['discount.override']);
  });

  it('reports a narrowed role without failing, because a shop may mean it', async () => {
    /*
     * Not symmetrical with the above, deliberately. A missing grant is a shop
     * that deliberately narrowed a role, and this command has no business
     * overruling that — completing somebody's deliberately narrowed role would
     * be a worse bug than the one it is looking for, and a silent one.
     */
    const report = await verifyCatalogue(
      fakePrisma([{ name: ROLE_LABELS.store_manager, keys: ROLE_PERMISSIONS.store_manager.slice(1) }]),
    );
    expect(report.ok).toBe(true);
    expect(report.grants[0]?.missing.length).toBeGreaterThan(0);
    expect(report.grants[0]?.extra).toEqual([]);
  });

  it('leaves a role the codebase does not know alone', async () => {
    // A tenant may legitimately have invented one, and judging it would be
    // inventing policy from a name.
    const report = await verifyCatalogue(fakePrisma([{ name: 'Night Cashier', keys: ['sale.create'] }]));
    expect(report.grants).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('still fails on a missing catalogue key, as it always did', async () => {
    const prisma = {
      permission: { findMany: async () => [{ key: 'sale.create', label: 'Create sales' }] },
      role: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const report = await verifyCatalogue(prisma);
    expect(report.ok).toBe(false);
    expect(report.missing.length).toBeGreaterThan(0);
  });
});
