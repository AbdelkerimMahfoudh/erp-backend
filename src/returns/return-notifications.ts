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

export type ReturnEvent = 'requested' | 'custody_received' | 'under_review' | 'approved' | 'rejected' | 'refund_reported' | 'refund_corrected' | 'refund_confirmed';

export interface ReturnNotificationContext {
  event: ReturnEvent;
  request: { id: Buffer; companyId: Buffer; branchId: Buffer; requestedById: Buffer | null };
  invoiceNo: string;
  actorId: Buffer | null;
  /** Shown verbatim on a rejection. Never contains money or defect detail. */
  reason?: string;
}

const COPY: Record<
  ReturnEvent,
  (p: { invoiceNo: string; actor: string; reason?: string }) => { title: string; body: string }
> = {
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
  /**
   * The wording is the point. "Refund due" and "not yet paid" appear together
   * so nobody reads an approval as money already handed over — and no amount
   * appears at all, because a notification is read outside the request that
   * authorised it and must never route around cost gating.
   */
  approved: (p) => ({
    title: `Return approved — refund due`,
    body: `The return for invoice ${p.invoiceNo} was approved. The refund is due and has NOT yet been paid. The phone is held and is not for sale.`,
  }),
  /**
   * No amount in any refund notification body. A notification is read outside
   * the request that authorised it, so it must never carry a figure that cost
   * gating would otherwise withhold.
   *
   * The reported wording says "NOT confirmed yet" out loud, because a manager
   * glancing at a list must not read a report as a settlement.
   */
  refund_reported: (p) => ({
    title: `Refund reported — needs confirmation`,
    body: `${p.actor} reported handing back the refund for invoice ${p.invoiceNo}. It is NOT confirmed yet.`,
  }),
  refund_corrected: (p) => ({
    title: `Refund report corrected`,
    body: `${p.actor} corrected the refund details for invoice ${p.invoiceNo} before confirming.`,
  }),
  refund_confirmed: (p) => ({
    title: `Refund confirmed as paid`,
    body: `${p.actor} confirmed the refund for invoice ${p.invoiceNo} was returned to the customer.`,
  }),
  rejected: (p) => ({
    title: `Return rejected`,
    body: `The return for invoice ${p.invoiceNo} was refused${p.reason ? `: ${p.reason}` : '.'}`,
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

    const copy = COPY[ctx.event]({
      invoiceNo: ctx.invoiceNo,
      actor: actor?.name ?? 'Someone',
      reason: ctx.reason,
    });

    for (const targetUserId of recipients) {
      /**
       * `dedupeKey` is the existing deduplication mechanism (H1.3): a UNIQUE
       * index makes a duplicate an INSERT the database rejects, rather than one
       * the application tries to avoid. An application-level pre-check is true
       * when it is read and false when it is acted on; this is not.
       *
       * The key is the natural identity of the event — this return, this
       * transition, this recipient — so a retried request delivers the same
       * notification once.
       */
      const dedupeKey = `return:${ctx.request.id.toString('hex')}:${ctx.event}:${targetUserId.toString('hex').slice(0, 12)}`;
      try {
        await tx.notification.create({
          data: {
            id: newUuidV7Bin(),
            companyId: ctx.request.companyId,
            branchId: ctx.request.branchId,
            targetUserId,
            type: `return.${ctx.event}`,
            title: copy.title,
            body: copy.body,
            // Where to go when tapped. The mobile route lands in CP5; the link
            // is stable regardless.
            actionLink: `/returns/${binToUuid(ctx.request.id)}`,
            dedupeKey,
            /**
             * The FIELDS, so the app can compose the sentence in the reader's
             * language while `title`/`body` stay the fallback. Carries an
             * invoice number and nothing financial.
             */
            payload: { returnId: binToUuid(ctx.request.id), invoiceNo: ctx.invoiceNo },
            isRead: false,
          },
        });
      } catch (e) {
        // The duplicate the unique index just refused. That is the mechanism
        // working, not a failure — and it must not roll back the transition it
        // was reporting.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      }
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
      case 'rejected':
        // Only the person who raised it. Broadcasting a refusal helps nobody.
        add(ctx.request.requestedById ? [ctx.request.requestedById] : []);
        break;
      case 'refund_reported':
        // The people who can actually confirm it.
        add(await this.holdersOf(tx, ctx.request.companyId, ctx.request.branchId, 'refund.confirm'));
        break;
      case 'refund_corrected':
        // Only the reporter: their report was changed before being confirmed.
        add(ctx.request.requestedById ? [ctx.request.requestedById] : []);
        break;
      case 'refund_confirmed':
        add(ctx.request.requestedById ? [ctx.request.requestedById] : []);
        add(await this.holdersOf(tx, ctx.request.companyId, ctx.request.branchId, 'refund.confirm'));
        break;
      case 'approved':
        // The requester learns the answer, and whoever can settle the refund
        // needs to know one is now owed.
        add(ctx.request.requestedById ? [ctx.request.requestedById] : []);
        add(await this.holdersOf(tx, ctx.request.companyId, ctx.request.branchId, 'return.approve'));
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
