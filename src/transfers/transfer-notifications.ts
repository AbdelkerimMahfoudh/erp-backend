import { Injectable } from '@nestjs/common';
import { Prisma, StockTransfer } from '@prisma/client';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * Who gets told what, when a transfer moves.
 *
 * H1.2 shipped a correct workflow that nobody could see: a request waited for
 * an approval nobody was told about. This is the part that makes it usable.
 *
 * Three rules shape everything here.
 *
 * **Recipients come from permissions, never from role names.** "Who can approve
 * this?" is answered by asking which users hold `transfer.approve` in the source
 * branch — the same question the guard asks. A role-name list would drift the
 * moment a permission moved.
 *
 * **Rows are written inside the caller's transaction.** A notification for a
 * transition that rolled back is a lie, and a transition with no notification is
 * the H1.2 gap all over again. Both commit together or neither does.
 *
 * **The message carries no money.** Branch names, the transfer reference, an
 * item count, who acted and any reason — nothing else. A notification is read
 * outside the request that authorized it, so it must never become a way around
 * cost gating.
 */

/** The transaction client, typed loosely enough to accept the tenant client. */
type Tx = {
  notification: { create(args: { data: Prisma.NotificationUncheckedCreateInput }): Promise<unknown> };
  userBranch: { findMany(args: unknown): Promise<{ userId: Buffer }[]> };
  branch: { findMany(args: unknown): Promise<{ id: Buffer; name: string }[]> };
  user: { findFirst(args: unknown): Promise<{ name: string } | null> };
};

/** Every transfer event that notifies somebody. */
export type TransferEvent =
  | 'requested'
  | 'created_approved'
  | 'approved'
  | 'rejected'
  | 'shipped'
  | 'received'
  | 'cancelled';

export interface TransferNotificationContext {
  transfer: Pick<
    StockTransfer,
    'id' | 'companyId' | 'fromBranchId' | 'toBranchId' | 'transferNo' | 'requestedById'
  >;
  event: TransferEvent;
  /** Who performed the action. Excluded from their own notification. */
  actorId: Buffer | null;
  units: number;
  reason?: string | null;
}

/**
 * English fallback copy, and the shape the app localises from.
 *
 * `title`/`body` are what a client that does not recognise the type will show;
 * `payload` is what the app actually renders, in the reader's language. Keeping
 * both means adding a language never needs a data migration.
 */
const COPY: Record<TransferEvent, (p: Payload) => { title: string; body: string }> = {
  requested: (p) => ({
    title: `Transfer ${p.transferNo} needs approval`,
    body: `${p.actor} asked to send ${p.units} item(s) from ${p.fromBranch} to ${p.toBranch}.`,
  }),
  created_approved: (p) => ({
    title: `Transfer ${p.transferNo} is coming to ${p.toBranch}`,
    body: `${p.actor} approved sending ${p.units} item(s) from ${p.fromBranch}.`,
  }),
  approved: (p) => ({
    title: `Transfer ${p.transferNo} approved`,
    body: `${p.actor} approved sending ${p.units} item(s) from ${p.fromBranch} to ${p.toBranch}.`,
  }),
  rejected: (p) => ({
    title: `Transfer ${p.transferNo} refused`,
    body: `${p.actor} refused sending ${p.units} item(s) from ${p.fromBranch} to ${p.toBranch}. Reason: ${p.reason ?? '—'}`,
  }),
  shipped: (p) => ({
    title: `Transfer ${p.transferNo} is on the way to ${p.toBranch}`,
    body: `${p.actor} sent ${p.units} item(s) from ${p.fromBranch}.`,
  }),
  received: (p) => ({
    title: `Transfer ${p.transferNo} arrived at ${p.toBranch}`,
    body: `${p.actor} received ${p.units} item(s) from ${p.fromBranch}.`,
  }),
  cancelled: (p) => ({
    title: `Transfer ${p.transferNo} cancelled`,
    body: `${p.actor} cancelled sending ${p.units} item(s) from ${p.fromBranch} to ${p.toBranch}. Reason: ${p.reason ?? '—'}`,
  }),
};

interface Payload {
  transferNo: string;
  fromBranch: string;
  toBranch: string;
  units: number;
  actor: string;
  reason: string | null;
}

@Injectable()
export class TransferNotifier {
  /**
   * Notify everyone this transition concerns, inside the caller's transaction.
   *
   * Returns the number of people told, which is what the tests assert on.
   */
  async notifyTx(tx: Tx, ctx: TransferNotificationContext): Promise<number> {
    const { transfer, event } = ctx;

    const recipients = await this.recipientsFor(tx, ctx);
    if (recipients.length === 0) return 0;

    const [branches, actor] = await Promise.all([
      tx.branch.findMany({
        where: { id: { in: [transfer.fromBranchId, transfer.toBranchId] } },
        select: { id: true, name: true },
      }),
      ctx.actorId
        ? tx.user.findFirst({ where: { id: ctx.actorId }, select: { name: true } })
        : Promise.resolve(null),
    ]);
    const nameOf = (id: Buffer) =>
      branches.find((b) => b.id.equals(id))?.name ?? 'another branch';

    const payload: Payload = {
      transferNo: transfer.transferNo ?? '',
      fromBranch: nameOf(transfer.fromBranchId),
      toBranch: nameOf(transfer.toBranchId),
      units: ctx.units,
      actor: actor?.name ?? 'Someone',
      reason: ctx.reason?.trim() ? ctx.reason.trim() : null,
    };
    const { title, body } = COPY[event](payload);

    /**
     * The action always lands on THIS transfer, never on a list. A notification
     * that opens a list is a notification the reader has to search through.
     */
    const actionLink = `/transfers/${binToUuid(transfer.id)}`;
    const dedupeKey = `transfer:${transfer.id.toString('hex')}:${event}`;

    let sent = 0;
    for (const userId of recipients) {
      try {
        await tx.notification.create({
          data: {
            id: newUuidV7Bin(),
            companyId: transfer.companyId,
            // The branch the event is ABOUT, for filtering and reporting later.
            branchId: event === 'received' || event === 'shipped' ? transfer.toBranchId : transfer.fromBranchId,
            targetUserId: userId,
            type: `transfer.${event}`,
            title,
            body,
            actionLink,
            dedupeKey,
            payload: { event, ...payload } as unknown as Prisma.InputJsonValue,
          },
        });
        sent += 1;
      } catch (e) {
        /**
         * The unique index rejected a duplicate: this exact person has already
         * been told about this exact event. That is success, not failure — a
         * retried request must not produce a second copy, and it must certainly
         * not roll back the transition that had already happened.
         */
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    return sent;
  }

  /**
   * Who this event concerns, deduplicated, with the actor removed.
   *
   * A person qualifying twice — a requester who is also an approver, an Owner
   * assigned to both branches — is one person and gets one notification.
   */
  private async recipientsFor(tx: Tx, ctx: TransferNotificationContext): Promise<Buffer[]> {
    const { transfer, event } = ctx;
    const out = new Map<string, Buffer>();

    const add = (ids: Buffer[]) => {
      for (const id of ids) out.set(id.toString('hex'), id);
    };
    const requester = transfer.requestedById ? [transfer.requestedById] : [];

    switch (event) {
      case 'requested':
        // The people who must actually do something next.
        add(await this.holdersOf(tx, transfer.companyId, transfer.fromBranchId, 'transfer.approve'));
        break;

      case 'created_approved':
        // Nobody needs to approve it, so the news is for the receiving end.
        add(await this.holdersOf(tx, transfer.companyId, transfer.toBranchId, 'transfer.receive'));
        break;

      case 'approved':
        // The requester learns the answer; the source can now ship; the
        // destination can expect it.
        add(requester);
        add(await this.holdersOf(tx, transfer.companyId, transfer.fromBranchId, 'transfer.ship'));
        add(await this.holdersOf(tx, transfer.companyId, transfer.toBranchId, 'transfer.receive'));
        break;

      case 'rejected':
        // Only the person who asked. Broadcasting a refusal helps nobody.
        add(requester);
        break;

      case 'shipped':
        add(await this.holdersOf(tx, transfer.companyId, transfer.toBranchId, 'transfer.receive'));
        break;

      case 'received':
        // Closing the loop for whoever asked and whoever let it go.
        add(requester);
        add(await this.holdersOf(tx, transfer.companyId, transfer.fromBranchId, 'transfer.approve'));
        break;

      case 'cancelled':
        // Everyone who was already involved: the requester, the approvers who
        // may have agreed to it, and the destination that may be expecting it.
        add(requester);
        add(await this.holdersOf(tx, transfer.companyId, transfer.fromBranchId, 'transfer.approve'));
        add(await this.holdersOf(tx, transfer.companyId, transfer.toBranchId, 'transfer.receive'));
        break;
    }

    // Nobody is told about their own action. It is already on their screen.
    if (ctx.actorId) out.delete(ctx.actorId.toString('hex'));
    return [...out.values()];
  }

  /**
   * Active users who hold `permission` in `branchId`, via their role there.
   *
   * Transfer permissions are not delegatable (`DELEGATABLE_PERMISSIONS` is
   * `price.edit` alone), so a role lookup is the complete answer. If a transfer
   * permission ever becomes delegatable, per-branch grants must be unioned in
   * here too — otherwise a delegated approver would silently never be told.
   */
  private async holdersOf(
    tx: Tx,
    companyId: Buffer,
    branchId: Buffer,
    permission: string,
  ): Promise<Buffer[]> {
    const assignments = await tx.userBranch.findMany({
      where: {
        companyId,
        branchId,
        user: { isActive: true, deletedAt: null },
        // `rolePermissions` is the relation's real name on Role — the join
        // table, not the permissions themselves.
        role: { rolePermissions: { some: { permission: { key: permission } } } },
      },
      select: { userId: true },
    });
    return assignments.map((a) => a.userId);
  }
}
