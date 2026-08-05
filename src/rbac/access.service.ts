import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { binToUuid } from '../common/utils/uuid.util';
import { isCompanyPermission, isDelegatable, DELEGATION_ELIGIBLE_ROLE } from './permission-scope';

/**
 * Resolves a user's effective permissions from `user_branches → role →
 * role_permissions`. Uses the tenant-scoped client, so the lookup is confined to
 * the caller's company automatically.
 *
 * - With a `branchId`: permissions for the user's role at that branch; throws
 *   403 if the user is not assigned to it.
 * - Without a `branchId`: the union across all the user's branches, **filtered to
 *   company-wide permissions only**. Branch-scoped authority is never granted
 *   without a branch context, so a permission that belongs to one branch — a
 *   role permission there, or a per-branch delegated grant — cannot apply
 *   company-wide. This is the branch-safety boundary Stage 2 delegation relies on.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  async getEffectivePermissions(userId: Buffer, branchId?: Buffer): Promise<Set<string>> {
    const assignments = await this.db.userBranch.findMany({
      where: branchId ? { userId, branchId } : { userId },
      select: { id: true, roleId: true, role: { select: { key: true } } },
    });

    if (branchId && assignments.length === 0) {
      throw new ForbiddenException('No access to the requested branch');
    }

    const roleIds = assignments.map((a) => a.roleId);
    if (roleIds.length === 0) {
      return new Set<string>();
    }

    const rolePermissions = await this.db.rolePermission.findMany({
      where: { roleId: { in: roleIds } },
      select: { permission: { select: { key: true } } },
    });
    const keys = rolePermissions.map((rp) => rp.permission.key);

    // No branch context: only company-wide permissions survive the union, so
    // branch-scoped authority never leaks across branches (fail-closed).
    if (!branchId) {
      return new Set(keys.filter(isCompanyPermission));
    }

    // Branch-scoped resolution: the role's permissions at this branch PLUS any
    // per-branch delegated grants. A grant is honoured only on a
    // delegation-eligible (store_manager) assignment and only for a delegatable
    // permission — so downgrading the manager neutralizes it, and a stale or
    // rogue grant of anything else can never take effect.
    const effective = new Set(keys);
    const eligible = assignments
      .filter((a) => a.role.key === DELEGATION_ELIGIBLE_ROLE)
      .map((a) => a.id);
    if (eligible.length > 0) {
      const grants = await this.db.userBranchPermission.findMany({
        where: { userBranchId: { in: eligible } },
        select: { permission: { select: { key: true } } },
      });
      for (const g of grants) {
        if (isDelegatable(g.permission.key)) effective.add(g.permission.key);
      }
    }
    return effective;
  }

  /** Branches the user is assigned to (for the app's branch picker / X-Branch-Id). */
  async getUserBranches(userId: Buffer): Promise<{ id: string; name: string; type: string; role: string }[]> {
    const assignments = await this.db.userBranch.findMany({
      where: { userId },
      select: {
        branch: { select: { id: true, name: true, type: true } },
        role: { select: { key: true } },
      },
      orderBy: { branch: { name: 'asc' } },
    });
    return assignments.map((a) => ({
      id: binToUuid(a.branch.id),
      name: a.branch.name,
      type: a.branch.type,
      role: a.role.key,
    }));
  }
}
