import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEMO_COMPANY_UUID,
  judgeCompany,
  type CompanySnapshot,
} from './role-repair-eligibility';
import { ROLE_PERMISSIONS } from './role-permissions';

/**
 * Who may be repaired, and — far more importantly — who may not.
 *
 * The repair writes permissions into live tenants. A false positive silently
 * rewrites a real shop's access, which is worse than the empty roles being
 * fixed and much quieter. So most of these tests are about refusing.
 */

const EMPTY_DEFAULTS = [
  { key: 'owner', mappingCount: 0 },
  { key: 'store_manager', mappingCount: 0 },
  { key: 'store_employee', mappingCount: 0 },
];

function company(over: Partial<CompanySnapshot> = {}): CompanySnapshot {
  return {
    uuid: '01a03f96-1d0e-71be-afba-2206398a8e55',
    cameFromSelfRegistration: true,
    roles: EMPTY_DEFAULTS,
    ...over,
  };
}

describe('repair eligibility', () => {
  it('repairs a self-registered company whose three default roles are all empty', () => {
    const verdict = judgeCompany(company());

    expect(verdict.kind).toBe('eligible');
    if (verdict.kind !== 'eligible') return;
    expect(verdict.willAdd).toEqual({
      owner: ROLE_PERMISSIONS.owner.length,
      store_manager: ROLE_PERMISSIONS.store_manager.length,
      store_employee: ROLE_PERMISSIONS.store_employee.length,
    });
  });

  it('NEVER touches the demo tenant', () => {
    // Even though it otherwise looks exactly like the empty case.
    const verdict = judgeCompany(company({ uuid: DEMO_COMPANY_UUID }));
    expect(verdict).toEqual({ kind: 'skip', why: expect.stringContaining('demo tenant') });
  });

  it('skips a company with no registration provenance', () => {
    /*
     * Only companies that came through the affected path are in scope. One
     * created another way that happens to have empty roles is somebody else's
     * situation, and guessing at it is not repair.
     */
    const verdict = judgeCompany(company({ cameFromSelfRegistration: false }));
    expect(verdict).toEqual({ kind: 'skip', why: expect.stringContaining('provenance') });
  });

  it('skips a company where ANY default role already has mappings', () => {
    const verdict = judgeCompany(
      company({
        roles: [
          { key: 'owner', mappingCount: 61 },
          { key: 'store_manager', mappingCount: 0 },
          { key: 'store_employee', mappingCount: 0 },
        ],
      }),
    );
    expect(verdict.kind).toBe('skip');
    if (verdict.kind !== 'skip') return;
    expect(verdict.why).toContain('owner(61)');
    expect(verdict.why).toContain('manual review');
  });

  it('skips a PARTIALLY configured company entirely, rather than completing it', () => {
    /*
     * The tempting wrong behaviour: "owner and employee are empty, fill those
     * in". A shop that deliberately narrowed a manager would silently get the
     * full matrix back. The whole company is skipped instead.
     */
    const verdict = judgeCompany(
      company({
        roles: [
          { key: 'owner', mappingCount: 0 },
          { key: 'store_manager', mappingCount: 12 },
          { key: 'store_employee', mappingCount: 0 },
        ],
      }),
    );
    expect(verdict.kind).toBe('skip');
    if (verdict.kind !== 'skip') return;
    expect(verdict.why).toContain('store_manager(12)');
  });

  it('skips a company carrying a custom role alongside the defaults', () => {
    const verdict = judgeCompany(
      company({
        roles: [...EMPTY_DEFAULTS, { key: 'night_supervisor', mappingCount: 0 }],
      }),
    );
    expect(verdict.kind).toBe('skip');
    if (verdict.kind !== 'skip') return;
    expect(verdict.why).toContain('not exactly the three defaults');
  });

  it('skips a company missing one of the default roles', () => {
    const verdict = judgeCompany({
      ...company(),
      roles: [
        { key: 'owner', mappingCount: 0 },
        { key: 'store_manager', mappingCount: 0 },
      ],
    });
    expect(verdict.kind).toBe('skip');
  });

  it('skips a company with no roles at all', () => {
    const verdict = judgeCompany(company({ roles: [] }));
    expect(verdict.kind).toBe('skip');
    if (verdict.kind !== 'skip') return;
    expect(verdict.why).toContain('none');
  });

  it('never proposes the internal administrator role for a shop', () => {
    const verdict = judgeCompany(company());
    if (verdict.kind !== 'eligible') throw new Error('expected eligible');
    expect(Object.keys(verdict.willAdd).sort()).toEqual([
      'owner',
      'store_employee',
      'store_manager',
    ]);
  });
});

describe('the repair command itself', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'scripts', 'staging-repair-role-permissions.ts'),
    'utf8',
  );

  it('is dry-run by default and needs an explicit flag to write', () => {
    expect(source).toMatch(/const APPLY = process\.argv\.includes\('--apply'\)/);
    // The dry-run path returns before any write.
    expect(source).toMatch(/if \(!APPLY\)/);
  });

  it('refuses anywhere but the dedicated staging database', () => {
    expect(source).toMatch(/loadEnv\(\{ path: '\.env\.staging', override: true \}\)/);
    expect(source).toMatch(/appEnv !== 'staging'/);
    expect(source).toMatch(/FORBIDDEN = \[\/\^phonestore\$\/i/);
    expect(source).toMatch(/REQUIRED_SHAPE/);
  });

  it('backs up and RESTORE-PROVES before writing', () => {
    expect(source).toMatch(/const dump = backup\(database\);/);
    expect(source).toMatch(/restoreProve\(database, dump\);/);
    /*
     * The order is the point: both must precede the first WRITE. Anchored on
     * the write itself rather than on a loop header — `for (const c of
     * eligible)` also opens the dry-run report, which legitimately runs first.
     */
    expect(source.indexOf('restoreProve(database, dump)')).toBeLessThan(
      source.indexOf('provisionDefaultRoles(tx, c.companyId)'),
    );
    expect(source.indexOf('const dump = backup(database)')).toBeLessThan(
      source.indexOf('provisionDefaultRoles(tx, c.companyId)'),
    );
  });

  it('re-checks eligibility inside the write transaction', () => {
    expect(source).toMatch(/\$transaction\(async \(tx\) => \{[\s\S]*survey\(tx\)/);
    expect(source).toMatch(/no longer eligible/);
  });

  it('writes no permission matrix of its own', () => {
    // It must go through the shared provisioner, not rebuild the matrix.
    expect(source).toMatch(/provisionDefaultRoles\(tx, c\.companyId\)/);
    expect(source).not.toMatch(/rolePermission\.(create|createMany|upsert)\b/);
    expect(source).not.toMatch(/INSERT INTO/i);
  });

  it('records a system maintenance actor, never a fabricated person', () => {
    expect(source).toMatch(/adminId: null/);
    expect(source).toMatch(/actor: 'system:role-permission-repair'/);
    expect(source).toMatch(/action: 'maintenance\.role_permissions_repaired'/);
  });

  it('is not a schema migration', () => {
    expect(source).not.toMatch(/ALTER TABLE|CREATE TABLE|prisma migrate/i);
  });
});

describe('a repeat run reads clearly', () => {
  it('says a fully repaired company is already canonical, not "needs review"', () => {
    /*
     * After a successful repair the same company is skipped — but for a
     * different reason than a customised one, and the operator must be able to
     * tell those apart at a glance. Four lines saying "manual review" about
     * work that succeeded is how a good result gets mistaken for a bad one.
     */
    const verdict = judgeCompany(
      company({
        roles: [
          { key: 'owner', mappingCount: ROLE_PERMISSIONS.owner.length },
          { key: 'store_manager', mappingCount: ROLE_PERMISSIONS.store_manager.length },
          { key: 'store_employee', mappingCount: ROLE_PERMISSIONS.store_employee.length },
        ],
      }),
    );
    expect(verdict.kind).toBe('skip');
    if (verdict.kind !== 'skip') return;
    expect(verdict.why).toContain('already provisioned with the canonical matrix');
    expect(verdict.why).not.toContain('manual review');
  });

  it('still flags a customised company for review even when every role has some', () => {
    const verdict = judgeCompany(
      company({
        roles: [
          { key: 'owner', mappingCount: ROLE_PERMISSIONS.owner.length },
          { key: 'store_manager', mappingCount: 5 }, // deliberately narrowed
          { key: 'store_employee', mappingCount: ROLE_PERMISSIONS.store_employee.length },
        ],
      }),
    );
    expect(verdict.kind).toBe('skip');
    if (verdict.kind !== 'skip') return;
    expect(verdict.why).toContain('manual review');
  });
});
