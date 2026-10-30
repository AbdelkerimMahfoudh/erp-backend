import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { EntitlementService } from '../entitlement/entitlement.service';
import { SEAT_LIMIT_REACHED } from '../entitlement/entitlement-rules';
import { pruneGrantsForRole } from '../rbac/delegation-lifecycle';
import type { ChangeRoleDto } from './dto/change-role.dto';

type Assignment = { id: Buffer; branchId: Buffer; role: string };

/** What the person's stores and roles will be: the rows to change, add and leave. Pure, so it is tested on its own. */
export function planRoleChange(
  current: readonly Assignment[],
  role: 'store_manager' | 'store_employee',
  branchIds: readonly Buffer[],
): { update: Assignment[]; create: Buffer[]; remove: Assignment[] } {
  const wanted = new Set(branchIds.map((b) => b.toString('hex')));
  const at = new Map(current.map((a) => [a.branchId.toString('hex'), a]));
  const update: Assignment[] = [];
  const create: Buffer[] = [];
  const remove: Assignment[] = [];
  for (const id of branchIds) {
    const held = at.get(id.toString('hex'));
    if (!held) create.push(id);
    else if (held.role !== role) update.push(held);
  }
  // Demotion: a store managed and not kept is left. Promotion leaves every other store as it was.
  if (role === 'store_employee') {
    for (const a of current) if (a.role === 'store_manager' && !wanted.has(a.branchId.toString('hex'))) remove.push(a);
  }
  return { update, create, remove };
}

/**
 * Employee ↔ Manager, without deleting and recreating the account (D225).
 *
 * Authority is read from `user_branches → role → role_permissions` on every request (AccessService), and the access
 * token carries no role — so the change is in force on the very next request of every session the person has: no
 * session keeps the old role, and nothing needs to be revoked. Delegated grants a role cannot hold are pruned in the
 * same transaction (`pruneGrantsForRole`). Approvals are never assigned to one Manager — the decision is the
 * permission's, checked when it is made — so a demoted Manager's pending requests stay in the queue for whoever may
 * still decide them, and the demoted person can no longer decide any.
 *
 * Seats stay what they are: a store the person is newly assigned to needs a free seat there.
 */
@Injectable()
export class RoleChangeService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly entitlement: EntitlementService,
  ) {}

  async change(idStr: string, dto: ChangeRoleDto) {
    if (!isUuid(idStr)) throw new NotFoundException('User not found');
    const userId = uuidToBin(idStr);
    const actorId = this.tenant.requireUserId();
    const companyId = this.tenant.companyId();
    if (actorId.equals(userId)) {
      throw new ForbiddenException({ code: 'role_change_self', message: 'You cannot change your own role.' });
    }
    const branchIds = [...new Set(dto.branchIds.map((b) => b.toLowerCase()))].map(uuidToBin);

    const outcome = await this.db.$transaction(async (tx) => {
      // One change at a time per person: a second request waits here, then reads the role the first one set.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const person = await tx.user.findFirst({
        where: { id: userId, companyId, deletedAt: null },
        select: { id: true, name: true, isActive: true, userBranches: { select: { id: true, branchId: true, role: { select: { key: true } } } } },
      });
      if (!person) throw new NotFoundException('User not found');
      const current = person.userBranches.map((ub) => ({ id: ub.id, branchId: ub.branchId, role: ub.role.key as string }));
      // The Owner is not changed here, nor through any role a person also holds as Owner somewhere.
      if (current.some((a) => a.role === 'owner')) {
        throw new ForbiddenException({ code: 'owner_role_fixed', message: 'The Owner’s role is not changed here.' });
      }
      const stores = await tx.branch.findMany({ where: { companyId, id: { in: branchIds }, isActive: true }, select: { id: true } });
      if (stores.length !== branchIds.length) throw new BadRequestException({ code: 'store_unknown', message: 'Choose stores of this business.' });

      const plan = planRoleChange(current, dto.role, branchIds);
      if (plan.update.length + plan.create.length + plan.remove.length === 0) {
        throw new BadRequestException({ code: 'role_unchanged', message: 'This person already has that role in those stores.' });
      }
      if (plan.create.length > 0) {
        const seats = await this.entitlement.maySeat(companyId, plan.create);
        if (!seats.allowed) {
          throw new ConflictException({ code: SEAT_LIMIT_REACHED, message: 'A store you chose has no free staff place.', full: seats.full });
        }
      }

      const roles = await tx.role.findMany({ where: { companyId, key: { in: ['store_manager', 'store_employee'] } }, select: { id: true, key: true } });
      const roleId = roles.find((r) => r.key === dto.role)?.id;
      if (!roleId) throw new ConflictException({ code: 'role_missing', message: 'This business has no such role.' });

      let grantsRemoved = 0;
      for (const a of plan.update) {
        await tx.userBranch.update({ where: { id: a.id }, data: { roleId } });
        grantsRemoved += await pruneGrantsForRole(tx, a.id, dto.role);
      }
      for (const branchId of plan.create) {
        await tx.userBranch.create({ data: { id: newUuidV7Bin(), companyId, userId, branchId, roleId } });
      }
      for (const a of plan.remove) {
        grantsRemoved += (await tx.userBranchPermission.deleteMany({ where: { userBranchId: a.id } })).count;
        await tx.userBranch.delete({ where: { id: a.id } });
      }
      const after = await tx.userBranch.findMany({ where: { userId }, select: { branchId: true, role: { select: { key: true } } } });
      if (after.length === 0) throw new BadRequestException({ code: 'store_required', message: 'Keep at least one store.' });

      const view = (rows: { branchId: Buffer; role: string }[]) =>
        rows.map((r) => ({ branchId: binToUuid(r.branchId), role: r.role })).sort((x, y) => x.branchId.localeCompare(y.branchId));
      const before = view(current);
      const now = view(after.map((r) => ({ branchId: r.branchId, role: r.role.key as string })));
      await this.audit.recordTx(tx, {
        entityType: 'User',
        entityId: userId,
        action: 'update',
        before: { assignments: before },
        after: { assignments: now, grantsRemoved },
        reason: dto.role === 'store_manager' ? 'Promoted to Manager' : 'Made an Employee',
      });
      // The person is told, in their own history and (by preference) as a push: structured, rendered in their language.
      await tx.notification.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          branchId: null,
          targetUserId: userId,
          type: 'staff.role_changed',
          actorUserId: actorId,
          title: dto.role === 'store_manager' ? 'You are now a Manager' : 'You are now an Employee',
          // No dedupe key needed: a retried change finds the role already set and is refused before this.
          payload: { role: dto.role, branchIds: now.filter((a) => a.role === dto.role).map((a) => a.branchId), actorId: binToUuid(actorId) },
          isRead: false,
        },
      });
      return { assignments: now, grantsRemoved };
    });

    return { userId: idStr, role: dto.role, ...outcome };
  }
}
