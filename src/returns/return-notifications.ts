import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * Who is told when a return moves.
 *
 * The same three rules the transfer notifier established, for the same reasons:
 *
 * **Recipients come from permissions, never role names.** "Who reviews this?"
 * is answered by asking who holds `return.review` at that branch — the same
 * question the guard asks. A role-name list drifts the moment a permission does.
 *
 * **Rows are written inside the caller's transaction.** A notification for a
 * request that rolled back is a lie; a request nobody is told about is the gap
 * that made the H1.2 transfer workflow unusable.
 *
 * **The message carries no money and no defect detail.** An invoice number, a
 * product name and who acted — nothing else. A notification is read outside the
 * request that authorized it, so it must never become a route around cost
 * gating, and a customer's complaint is not gossip for every device in the shop.
 */

type Tx = {
  notification: { create(args: { data: Prisma.NotificationUncheckedCreateInput }): Promise<unknown> };
  userBranch: { findMany(args: unknown): Promise<{ userId: Buffer }[]> };
  user: { findFirst(args: unknown): Promise<{ name: string } | null> };
};

export type ReturnEvent = 'requested' | 'custody_received' | 'under_review';

export interface ReturnNotificationContext {
  event: ReturnEvent;
  request: { id: Buffer; companyId: Buffer; branchId: Buffer; requestedById: Buffer | null };
  invoiceNo: string;
  actorId: Buffer | null;
}

const COPY: Record<ReturnEvent, (p: { invoiceNo: string; actor: string }) => { title: string; body: string }> = {
  requested: (p) => ({
    title: `Return request awaiting review`,
    body: `${p.actor} raised a return against invoice ${p.invoiceNo}.`,
  }),
  custody_received: (p) => ({
    title: `Phone received for return`,
    body: `The phone for invoice ${p.invoiceNo} is now held by the store.`,
  }),
  under_review: (p) => ({
    title: `Your return is being reviewed`,
    body: `${p.actor} started investigating the return for invoice ${p.invoiceNo}.`,
  }),
};

@Injectable()
export class ReturnNotifier {
  async emit(tx: Tx, ctx: ReturnNotificationContext): Promise<number> {
    const recipients = await this.recipientsFor(tx, ctx);
    if (recipients.length === 0) return 0;

    const actor = ctx.actorId
      ? await tx.user.findFirst({ where: { id: ctx.actorId }, select: { name: true } })
      : null;

    const copy = COPY[ctx.event]({ invoiceNo: ctx.invoiceNo, actor: actor?.name ?? 'Someone' });

    for (const targetUserId of recipients) {
      await tx.notification.create({
        data: {
          id: newUuidV7Bin(),
          companyId: ctx.request.companyId,
          branchId: ctx.request.branchId,
          targetUserId,
          type: `return.${ctx.event}`,
          title: copy.title,
          body: copy.body,
          isRead: false,
          // Where to go when tapped. The mobile detail route is built in CP5;
          // the link is stable regardless.
          data: { returnId: binToUuid(ctx.request.id), invoiceNo: ctx.invoiceNo },
        } as Prisma.NotificationUncheckedCreateInput,
      });
    }
    return recipients.length;
  }

  /**
   * Deduplicated by user id, so somebody who is both the requester and a
   * reviewer is told once. The Map is keyed on the hex of the binary id —
   * Buffers are compared by reference, and a Set of them would silently keep
   * duplicates.
   */
  private async recipientsFor(tx: Tx, ctx: ReturnNotificationContext): Promise<Buffer[]> {
    const out = new Map<string, Buffer>();
    const add = (ids: Buffer[]) => {
      for (const id of ids) {
        // Nobody is notified about their own action.
        if (ctx.actorId && id.equals(ctx.actorId)) continue;
        out.set(id.toString('hex'), id);
      }
    };

    switch (ctx.event) {
      case 'requested':
      case 'custody_received':
        // The people who must do something next.
        add(await this.holdersOf(tx, ctx.request.companyId, ctx.request.branchId, 'return.review'));
        break;
      case 'under_review':
        // Only the person who raised it. Broadcasting progress helps nobody.
        add(ctx.request.requestedById ? [ctx.request.requestedById] : []);
        break;
    }
    return [...out.values()];
  }

  /** Everyone holding a permission at a branch, through their role. */
  private async holdersOf(
    tx: Tx,
    companyId: Buffer,
    branchId: Buffer,
    permission: string,
  ): Promise<Buffer[]> {
    const rows = await tx.userBranch.findMany({
      where: {
        companyId,
        branchId,
        role: { rolePermissions: { some: { permission: { key: permission } } } },
        user: { isActive: true },
      },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }
}
