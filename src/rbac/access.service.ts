import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * Resolves a user's effective permissions from `user_branches → role →
 * role_permissions`. Uses the tenant-scoped client, so the lookup is confined to
 * the caller's company automatically.
 *
 * - With a `branchId`: permissions for the user's role at that branch; throws
 *   403 if the user is not assigned to it.
 * - Without a `branchId`: the union of the user's permissions across all their
 *   branches (used for company-level checks).
 */
@Injectable()
export class AccessService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrisma) {}

  async getEffectivePermissions(userId: Buffer, branchId?: Buffer): Promise<Set<string>> {
    const assignments = await this.db.userBranch.findMany({
      where: branchId ? { userId, branchId } : { userId },
      select: { roleId: true },
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

    return new Set(rolePermissions.map((rp) => rp.permission.key));
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
