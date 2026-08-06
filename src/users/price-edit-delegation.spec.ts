import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserManagementService } from './user-management.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * Branch-scoped price-edit delegation (F1 Stage 2).
 *
 * What makes this safe is not the endpoint — it is that the authority attaches
 * to ONE `UserBranch` assignment. These tests hold that line: who may receive
 * it, who never may, what a repeat does, and that nothing else rides along.
 *
 * The double enforces the composite primary key and the tenant filter for real,
 * so a service that forgot to scope a lookup, or that could write a second row
 * for the same assignment, fails here rather than in production.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const OWNER_ID = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const PRICE_EDIT = 'price.edit';
const PRICE_EDIT_ID = uuidToBin('018f0000-0000-7000-8000-00000000e001');

const BRANCH_A = newUuidV7Bin();
const BRANCH_B = newUuidV7Bin();

interface Assignment {
  id: Buffer;
  branch: { id: Buffer; name: string };
  role: { key: string };
  permissions: { permission: { key: string } }[];
}

interface Row {
  id: Buffer;
  companyId: Buffer;
  isActive: boolean;
  deletedAt: Date | null;
  userBranches: Assignment[];
}

function at(branch: Buffer, name: string, role: string): Assignment {
  return { id: newUuidV7Bin(), branch: { id: branch, name }, role: { key: role }, permissions: [] };
}

function person(over: Partial<Row> = {}): Row {
  return {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    isActive: true,
    deletedAt: null,
    userBranches: [at(BRANCH_A, 'Main Store', 'store_manager')],
    ...over,
  };
}

function makeService(opts: { rows?: Row[]; permissionExists?: boolean } = {}) {
  const rows = opts.rows ?? [];
  const audits: Record<string, unknown>[] = [];
  const written: Record<string, unknown>[] = [];

  /** The tenant extension injects companyId into every where clause. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = (where: Record<string, any> = {}): Record<string, any> => ({
    companyId: COMPANY,
    ...where,
  });
  const allAssignments = () => rows.flatMap((r) => r.userBranches);

  const view = (r: Row) => ({
    id: r.id,
    name: 'Person',
    login: 'person',
    phone: null,
    email: null,
    phoneVerifiedAt: null,
    emailVerifiedAt: null,
    isActive: r.isActive,
    lastLoginAt: null,
    userBranches: r.userBranches.map((b) => ({
      id: b.id,
      branch: { ...b.branch },
      role: { ...b.role },
      permissions: b.permissions.map((p) => ({ permission: { ...p.permission } })),
    })),
  });

  const db: any = {
    user: {
      findFirst: jest.fn(async ({ where }: any) => {
        const w = scoped(where);
        const hit = rows.find(
          (r) =>
            r.companyId.equals(w.companyId as Buffer) &&
            (w.id === undefined || r.id.equals(w.id as Buffer)) &&
            (w.deletedAt === undefined || r.deletedAt === null),
        );
        return hit ? view(hit) : null;
      }),
    },
    userBranch: {
      findFirst: jest.fn(async ({ where }: any) => {
        const w = scoped(where);
        for (const r of rows) {
          if (!r.companyId.equals(w.companyId as Buffer)) continue;
          if (w.userId !== undefined && !r.id.equals(w.userId as Buffer)) continue;
          const ub = r.userBranches.find((b) => b.branch.id.equals(w.branchId as Buffer));
          if (ub) {
            return {
              id: ub.id,
              role: { ...ub.role },
              branch: { name: ub.branch.name },
              user: { isActive: r.isActive, deletedAt: r.deletedAt },
            };
          }
        }
        return null;
      }),
    },
    userBranchPermission: {
      create: jest.fn(async ({ data }: any) => {
        const target = allAssignments().find((b) => b.id.equals(data.userBranchId));
        if (!target) throw new Error('no such assignment');
        // The composite primary key, enforced.
        if (target.permissions.some((p) => p.permission.key === PRICE_EDIT)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        target.permissions.push({ permission: { key: PRICE_EDIT } });
        written.push({ ...data });
        return data;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const target = allAssignments().find((b) => b.id.equals(where.userBranchId));
        if (!target) return { count: 0 };
        const before = target.permissions.length;
        target.permissions = target.permissions.filter((p) => p.permission.key !== PRICE_EDIT);
        return { count: before - target.permissions.length };
      }),
    },
    /** Global reference data — deliberately not tenant-scoped, like the model. */
    permission: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.key === PRICE_EDIT && opts.permissionExists !== false ? { id: PRICE_EDIT_ID } : null,
      ),
    },
  };

  const service = new UserManagementService(
    db as never,
    {
      companyId: () => COMPANY,
      branchId: () => undefined,
      userId: () => OWNER_ID,
      requireUserId: () => OWNER_ID,
    } as never,
    { record: jest.fn(async (p: Record<string, unknown>) => void audits.push(p)) } as never,
  );

  return { service, rows, audits, written };
}

const id = (r: Row) => binToUuid(r.id);

describe('who may receive a price-edit delegation', () => {
  it('a Store Manager, in the branch they manage', async () => {
    const m = person();
    const { service } = makeService({ rows: [m] });

    const v = await service.grantPriceEdit(id(m), binToUuid(BRANCH_A));

    const a = v.branches.find((b) => b.branchId === binToUuid(BRANCH_A))!;
    expect(a.grantedPermissions).toEqual([PRICE_EDIT]);
    expect(a.canDelegate).toBe(true);
  });

  it('a Store Employee may not — refused, not silently ignored', async () => {
    const e = person({ userBranches: [at(BRANCH_A, 'Main Store', 'store_employee')] });
    const { service } = makeService({ rows: [e] });

    await expect(service.grantPriceEdit(id(e), binToUuid(BRANCH_A))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('the Platform Administrator may not, through this store API', async () => {
    const a = person({ userBranches: [at(BRANCH_A, 'Main Store', 'administrator')] });
    const { service } = makeService({ rows: [a] });

    await expect(service.grantPriceEdit(id(a), binToUuid(BRANCH_A))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('a deactivated manager may not', async () => {
    const m = person({ isActive: false });
    const { service } = makeService({ rows: [m] });

    await expect(service.grantPriceEdit(id(m), binToUuid(BRANCH_A))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('a soft-deleted manager may not', async () => {
    const m = person({ deletedAt: new Date() });
    const { service } = makeService({ rows: [m] });

    await expect(service.grantPriceEdit(id(m), binToUuid(BRANCH_A))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('the delegation cannot cross a boundary', () => {
  it('a branch the user is not assigned to is not found', async () => {
    const m = person();
    const { service } = makeService({ rows: [m] });

    await expect(service.grantPriceEdit(id(m), binToUuid(BRANCH_B))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a forged branch id fails closed', async () => {
    const m = person();
    const { service } = makeService({ rows: [m] });

    await expect(service.grantPriceEdit(id(m), 'not-a-uuid')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("another company's user is not found, not edited", async () => {
    const foreign = person({ companyId: OTHER_COMPANY });
    const { service, written } = makeService({ rows: [foreign] });

    await expect(service.grantPriceEdit(id(foreign), binToUuid(BRANCH_A))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(written).toHaveLength(0);
  });

  it('a grant in branch A does not appear in branch B', async () => {
    const m = person({
      userBranches: [
        at(BRANCH_A, 'Main Store', 'store_manager'),
        at(BRANCH_B, 'Warehouse', 'store_manager'),
      ],
    });
    const { service } = makeService({ rows: [m] });

    const v = await service.grantPriceEdit(id(m), binToUuid(BRANCH_A));

    expect(v.branches.find((b) => b.branchId === binToUuid(BRANCH_A))!.grantedPermissions).toEqual([
      PRICE_EDIT,
    ]);
    expect(v.branches.find((b) => b.branchId === binToUuid(BRANCH_B))!.grantedPermissions).toEqual(
      [],
    );
  });
});

describe('grant and revoke are idempotent', () => {
  it('granting twice writes one row', async () => {
    const m = person();
    const { service, written } = makeService({ rows: [m] });

    await service.grantPriceEdit(id(m), binToUuid(BRANCH_A));
    const v = await service.grantPriceEdit(id(m), binToUuid(BRANCH_A));

    expect(written).toHaveLength(1);
    expect(v.branches[0].grantedPermissions).toEqual([PRICE_EDIT]);
  });

  it('revoking removes it', async () => {
    const m = person();
    const { service } = makeService({ rows: [m] });
    await service.grantPriceEdit(id(m), binToUuid(BRANCH_A));

    const v = await service.revokePriceEdit(id(m), binToUuid(BRANCH_A));

    expect(v.branches[0].grantedPermissions).toEqual([]);
  });

  it('revoking something never granted is safe and audits nothing', async () => {
    const m = person();
    const { service, audits } = makeService({ rows: [m] });

    const v = await service.revokePriceEdit(id(m), binToUuid(BRANCH_A));

    expect(v.branches[0].grantedPermissions).toEqual([]);
    // An audit log full of no-ops is an audit log nobody reads.
    expect(audits.filter((a) => a.entityType === 'UserBranchPermission')).toHaveLength(0);
  });

  it('an Owner can still revoke after the manager was downgraded', async () => {
    // Resolution already ignores the row once the role changes, but the Owner
    // must still be able to clear it.
    const m = person();
    const { service } = makeService({ rows: [m] });
    await service.grantPriceEdit(id(m), binToUuid(BRANCH_A));
    m.userBranches[0].role.key = 'store_employee';

    const v = await service.revokePriceEdit(id(m), binToUuid(BRANCH_A));

    expect(v.branches[0].grantedPermissions).toEqual([]);
  });
});

describe('audit and exposure', () => {
  it('records a grant with target, branch and permission', async () => {
    const m = person();
    const { service, audits } = makeService({ rows: [m] });

    await service.grantPriceEdit(id(m), binToUuid(BRANCH_A));

    const e = audits.find((a) => a.entityType === 'UserBranchPermission') as any;
    expect(e.action).toBe('create');
    expect(e.after).toMatchObject({
      targetUserId: id(m),
      branchId: binToUuid(BRANCH_A),
      permission: PRICE_EDIT,
    });
  });

  it('records a revoke', async () => {
    const m = person();
    const { service, audits } = makeService({ rows: [m] });
    await service.grantPriceEdit(id(m), binToUuid(BRANCH_A));

    await service.revokePriceEdit(id(m), binToUuid(BRANCH_A));

    const e = audits.filter((a) => a.entityType === 'UserBranchPermission').pop() as any;
    expect(e.action).toBe('delete');
    expect(e.before).toMatchObject({ permission: PRICE_EDIT });
  });

  it('never puts a hash, token or secret in audit metadata', async () => {
    const m = person();
    const { service, audits } = makeService({ rows: [m] });

    await service.grantPriceEdit(id(m), binToUuid(BRANCH_A));

    const serialized = JSON.stringify(audits);
    for (const forbidden of ['argon2', 'passwordHash', 'pinHash', 'refreshTokenHash', 'token']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('exposes the allow-list, so the UI never needs a permission picker', async () => {
    const m = person();
    const { service } = makeService({ rows: [m] });

    const v = await service.getOne(id(m));

    expect(v.delegatablePermissions).toEqual([PRICE_EDIT]);
    expect(v.delegatablePermissions).not.toContain('discount.override');
  });

  it('marks only manager assignments as delegation-capable', async () => {
    const m = person({
      userBranches: [
        at(BRANCH_A, 'Main Store', 'store_manager'),
        at(BRANCH_B, 'Warehouse', 'store_employee'),
      ],
    });
    const { service } = makeService({ rows: [m] });

    const v = await service.getOne(id(m));

    expect(v.branches.map((b) => b.canDelegate)).toEqual([true, false]);
  });

  it('shows only delegatable grants, whatever a row happens to say', async () => {
    // Defence in depth: a stale or hand-inserted row for a non-delegatable
    // permission must never read as though an Owner had granted it.
    const m = person();
    m.userBranches[0].permissions.push({ permission: { key: 'discount.override' } });
    const { service } = makeService({ rows: [m] });

    const v = await service.getOne(id(m));

    expect(v.branches[0].grantedPermissions).toEqual([]);
  });

  it('says so plainly when the database is behind the code', async () => {
    // 0022 guarantees the catalogue row; a miss means pending migrations.
    const m = person();
    const { service } = makeService({ rows: [m], permissionExists: false });

    await expect(service.grantPriceEdit(id(m), binToUuid(BRANCH_A))).rejects.toThrow(
      /apply pending migrations/,
    );
  });
});
