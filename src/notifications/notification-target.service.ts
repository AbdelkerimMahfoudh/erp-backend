import { Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../rbac/access.service';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { visibleToCompany } from '../consignment/consignment-scope';
import { NotificationsService } from './notifications.service';
import { REQUIRES, targetOf, type NotificationTarget } from './notification-target';

/** What opening a notification finds, decided now. */
export type OpenResult =
  | { status: 'ok'; target: NotificationTarget; branchId: string | null }
  | { status: 'unavailable' }
  | { status: 'unauthorized' }
  | { status: 'no_destination' };

/**
 * Opening a notification (D225) — from the centre, from a push tapped in the foreground, the background or at a cold
 * start: the same question, answered by the server at that moment.
 *
 *  1. Is it still the person's to see? Not theirs (or no longer: moved out of the store) reads as unavailable, so an
 *     id from someone else's push says nothing about what it names.
 *  2. Does it lead anywhere? A link that is not a typed destination leads to the centre only.
 *  3. Does the record still exist, for this business?
 *  4. Does the person hold, today, the permission the screen requires, in the record's own store?
 */
@Injectable()
export class NotificationTargetService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  async open(userId: Buffer, companyId: Buffer, notificationId: Buffer): Promise<OpenResult> {
    const n = await this.notifications.visibleOne(userId, notificationId);
    if (!n) return { status: 'unavailable' };
    const target = targetOf(n.actionLink);
    if (!target) return { status: 'no_destination' };

    const found = await this.locate(target, companyId, userId);
    if (!found) return { status: 'unavailable' };
    // The record's own store when it has one, else the store the event was about.
    const branches = found.branches.length > 0 ? found.branches : n.branchId ? [n.branchId] : [];
    // The person's own record (their role change, their appointment) is theirs to open; anything else needs the key.
    const required = REQUIRES[target.kind];
    if (!found.own && (required === null || !(await this.holdsAny(userId, required, branches)))) return { status: 'unauthorized' };
    const assigned = await this.assignedAmong(userId, branches);
    return { status: 'ok', target, branchId: assigned ? binToUuid(assigned) : null };
  }

  /** The record, if it still exists for this business, and the stores it belongs to. */
  private async locate(target: NotificationTarget, companyId: Buffer, userId: Buffer): Promise<{ branches: Buffer[]; own: boolean } | null> {
    const id = target.id ? uuidToBin(target.id) : null;
    const one = (row: { branchId: Buffer | null } | null) => (row ? { branches: row.branchId ? [row.branchId] : [], own: false } : null);
    switch (target.kind) {
      case 'sale':
        return one(await this.db.sale.findFirst({ where: { id: id! }, select: { branchId: true } }));
      case 'return':
        return one(await this.db.returnRequest.findFirst({ where: { id: id! }, select: { branchId: true } }));
      case 'approval':
        return one(await this.db.discountApproval.findFirst({ where: { id: id! }, select: { branchId: true } }));
      case 'discrepancy':
        return one(await this.db.closingDiscrepancy.findFirst({ where: { id: id! }, select: { branchId: true } }));
      case 'expense':
        return one(await this.db.expense.findFirst({ where: { id: id! }, select: { branchId: true } }));
      case 'transfer': {
        const t = await this.db.stockTransfer.findFirst({ where: { id: id! }, select: { fromBranchId: true, toBranchId: true } });
        return t ? { branches: [t.fromBranchId, t.toBranchId], own: false } : null;
      }
      // A loan or a consignment is between two businesses; either side may open it.
      case 'loan': {
        const l = await this.prisma.loan.findFirst({ where: { id: id!, OR: [{ companyId }, { counterpartyCompanyId: companyId }] }, select: { branchId: true, companyId: true } });
        return l ? { branches: l.companyId.equals(companyId) && l.branchId ? [l.branchId] : [], own: false } : null;
      }
      case 'consignment': {
        const c = await this.prisma.consignment.findFirst({ where: { id: id!, ...visibleToCompany(companyId) }, select: { id: true } });
        return c ? { branches: [], own: false } : null;
      }
      case 'product': {
        const p = await this.db.product.findFirst({ where: { id: id!, deletedAt: null }, select: { id: true } });
        return p ? { branches: [], own: false } : null;
      }
      case 'staff': {
        const u = await this.db.user.findFirst({ where: { id: id!, deletedAt: null }, select: { id: true } });
        return u ? { branches: [], own: u.id.equals(userId) } : null;
      }
      case 'acting_owner':
        // Addressed to the Owner and the delegate only: the notification being theirs is the check.
        return { branches: [], own: true };
      case 'closing_day':
      case 'stock':
      case 'analytics':
        return { branches: [], own: false };
    }
  }

  /** Any of the keys (or, for `[]`, membership), in any of the stores — or, with no store, in any of theirs. */
  private async holdsAny(userId: Buffer, keys: readonly string[], branches: Buffer[]): Promise<boolean> {
    const where = branches.length > 0 ? branches : (await this.db.userBranch.findMany({ where: { userId }, select: { branchId: true } })).map((a) => a.branchId);
    for (const branchId of where) {
      let held: Set<string>;
      try {
        held = await this.access.getEffectivePermissions(userId, branchId);
      } catch {
        continue; // Not assigned to that store.
      }
      if (keys.length === 0 || keys.some((k) => held.has(k))) return true;
    }
    return false;
  }

  /** The first of the record's stores the person works in, so the app opens it in that store. */
  private async assignedAmong(userId: Buffer, branches: Buffer[]): Promise<Buffer | null> {
    if (branches.length === 0) return null;
    const row = await this.db.userBranch.findFirst({ where: { userId, branchId: { in: branches } }, select: { branchId: true } });
    return row?.branchId ?? null;
  }
}
