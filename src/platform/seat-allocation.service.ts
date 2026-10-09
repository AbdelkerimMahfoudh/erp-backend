import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SeatAllocationKind, type SeatAllocationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { BillingService, type BillingDb } from '../billing/billing.service';
import { SubscriptionRenewal } from '../billing/renewal';
import { activityChange, activityFee } from '../billing/pricing-rules';
import { CLOCK, type Clock } from '../entitlement/clock';
import type { Activity } from '../entitlement/activity';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';
import type { PlatformAdminIdentity } from './platform-admin.service';

/**
 * Seats beyond a store's included one, additional stores, and a branch's
 * activity (docs/21, 2026-10-05; docs/68; D154, docs/73).
 *
 * The flow this file exists to keep honest:
 *
 *   Owner asks → the server prices it → it waits as `pending_payment` →
 *   an administrator confirms a REAL payment, with a reference → it is `paid`
 *   → the person it was asked for is activated once their contacts are proven.
 *
 * Nothing is granted by asking. Nothing is granted by a client-side amount.
 * Two confirmations of the same request produce one payment and one refusal,
 * because the transition is guarded by the row's `version` and the payment is
 * written in the same transaction as the status — if the status does not
 * move, the payment does not exist.
 *
 * An activity change is the same kind of row (D154). An **upgrade** — a change
 * priced higher — waits for payment of exactly the difference and applies the
 * new activity when that payment is confirmed. A **downgrade** costs nothing,
 * so it is recorded at once as `granted` with `effective: renewal`, written on
 * the branch as `activity_next`, and applied by the next renewal; nothing is
 * refunded this period.
 *
 * **No provider is integrated.** Every payment row carries `providerVerified:
 * false`, and every confirmation is a named administrator saying they saw the
 * money arrive, against a reference anybody can later check.
 */

export interface SeatAllocationView {
  id: string;
  kind: SeatAllocationKind;
  status: SeatAllocationStatus;
  store: { id: string; name: string } | null;
  person: { id: string; name: string } | null;
  /** The requested store's name, for a store request. */
  label: string | null;
  /** The store the request is about — the same as `store`, named the way the website reads it (D154). */
  branchId: string | null;
  branchName: string | null;
  /** An activity change (kind `activity`): what the branch does now and what was asked for. A store request carries the new store's activity in `activityTo`. */
  activityFrom: Activity | null;
  activityTo: Activity | null;
  /** `now` for an upgrade (applied at payment confirmation), `renewal` for a downgrade (applied by the next renewal). */
  activityEffective: 'now' | 'renewal' | null;
  monthlyAmount: number;
  currency: string;
  requestedBy: string;
  requestedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  reason: string | null;
  payment: {
    id: string;
    amount: string;
    reference: string | null;
    paidAt: string;
    channel: string;
  } | null;
  version: number;
  /** Always false: no payment provider is integrated. Said on every row. */
  providerVerified: false;
}

export interface SeatRequestQueueItem extends SeatAllocationView {
  business: { id: string; name: string; publicStoreId: string };
}

interface ActorContext {
  admin: PlatformAdminIdentity;
  ip?: string | null;
}

/** A reference shorter than this is a typo, not a reference. */
export const PAYMENT_REFERENCE_MIN_LENGTH = 3;

const INCLUDE = {
  branch: { select: { id: true, name: true } },
  user: { select: { id: true, name: true } },
  payment: {
    select: {
      id: true,
      amount: true,
      reference: true,
      paidAt: true,
      channel: true,
    },
  },
} satisfies Prisma.SeatAllocationInclude;

type Row = Prisma.SeatAllocationGetPayload<{ include: typeof INCLUDE }>;

const CHANGED = () =>
  new ConflictException({
    code: 'seat_request_changed',
    message: 'Somebody else changed this request. Refresh and try again.',
  });

/** A scheduled downgrade still waiting for the renewal: granted, and not yet applied. */
const isScheduledActivityChange = (row: Pick<Row, 'kind' | 'status' | 'confirmedAt'>): boolean =>
  row.kind === 'activity' && row.status === 'granted' && row.confirmedAt === null;

/** How a request names itself in an event. */
function requestLabel(row: Pick<Row, 'kind' | 'label' | 'branch' | 'activityFrom' | 'activityTo'>): string {
  if (row.kind === 'store') return `Store request "${row.label ?? ''}"`;
  if (row.kind === 'activity') {
    return `Activity change at ${row.branch?.name ?? 'a store'} (${row.activityFrom ?? '?'} → ${row.activityTo ?? '?'})`;
  }
  return `Seat at ${row.branch?.name ?? 'a store'}`;
}

/** The audit action of a decision on a request, named after what the request is. */
const actionOf = (kind: SeatAllocationKind, verb: 'refuse' | 'release'): string =>
  `${kind === 'store' ? 'store' : kind === 'activity' ? 'activity' : 'seat'}.${verb}`;

@Injectable()
export class SeatAllocationService {
  /** The renewal due at the end of a prepaid period (billing/renewal.ts), applied before a request is priced. */
  private readonly renewal: SubscriptionRenewal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly billing: BillingService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.renewal = new SubscriptionRenewal(prisma, billing, clock);
  }

  view(row: Row): SeatAllocationView {
    return {
      id: binToUuid(row.id),
      kind: row.kind,
      status: row.status,
      store: row.branch ? { id: binToUuid(row.branch.id), name: row.branch.name } : null,
      person: row.user ? { id: binToUuid(row.user.id), name: row.user.name } : null,
      label: row.label,
      branchId: row.branch ? binToUuid(row.branch.id) : null,
      branchName: row.branch?.name ?? null,
      activityFrom: row.activityFrom ?? null,
      activityTo: row.activityTo ?? null,
      activityEffective: row.activityEffective ?? null,
      monthlyAmount: row.monthlyAmount,
      currency: row.currency,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt.toISOString(),
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      closedBy: row.closedBy,
      reason: row.reason,
      payment: row.payment
        ? {
            id: binToUuid(row.payment.id),
            amount: row.payment.amount.toString(),
            reference: row.payment.reference,
            paidAt: row.payment.paidAt.toISOString(),
            channel: row.payment.channel,
          }
        : null,
      version: row.version,
      providerVerified: false,
    };
  }

  private async subscriptionOf(companyId: Buffer) {
    const sub = await this.prisma.subscription.findFirst({
      where: { companyId },
      include: { company: { select: { name: true, publicStoreId: true } } },
    });
    if (!sub) throw new NotFoundException('Unknown business');
    return sub;
  }

  /** Seats the company holds: paid or granted. */
  private async heldSeats(companyId: Buffer): Promise<number> {
    return this.prisma.seatAllocation.count({
      where: { companyId, kind: 'seat', status: { in: ['paid', 'granted'] } },
    });
  }

  private async load(allocationId: Buffer): Promise<Row> {
    const row = await this.prisma.seatAllocation.findUnique({
      where: { id: allocationId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException('Unknown request');
    return row;
  }

  // ── asking ───────────────────────────────────────────────────────────────

  /**
   * One more seat at a store, priced by today's plan and waiting for payment.
   *
   * Idempotent per person: asking twice for the same person at the same store
   * returns the request that already exists, so a retried tap or a second
   * Owner cannot queue two charges for one seat.
   */
  async requestSeat(
    companyId: Buffer,
    input: {
      branchId: Buffer;
      userId?: Buffer | null;
      requestedBy: string;
      note?: string | null;
    },
  ): Promise<{ allocation: SeatAllocationView; created: boolean }> {
    const sub = await this.subscriptionOf(companyId);
    const branch = await this.prisma.branch.findFirst({
      where: { id: input.branchId, companyId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!branch) throw new NotFoundException('Unknown store');

    if (input.userId) {
      const existing = await this.prisma.seatAllocation.findFirst({
        where: {
          companyId,
          kind: 'seat',
          branchId: branch.id,
          userId: input.userId,
          status: { in: ['pending_payment', 'paid', 'granted'] },
        },
        include: INCLUDE,
      });
      if (existing) return { allocation: this.view(existing), created: false };
    }

    const plan = await this.billing.planAt(this.clock.now());
    const row = await this.prisma.seatAllocation.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: sub.id,
        branchId: branch.id,
        userId: input.userId ?? null,
        kind: 'seat',
        status: 'pending_payment',
        monthlyAmount: plan.current.extraStaffMonthly,
        requestedBy: input.requestedBy.slice(0, 160),
        reason: input.note?.slice(0, 500) ?? null,
      },
      include: INCLUDE,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: sub.id,
        kind: 'seat_requested',
        note: `Additional seat at ${branch.name}${row.user ? ` for ${row.user.name}` : ''}: ${row.monthlyAmount} MRU per month, awaiting payment.`.slice(
          0,
          255,
        ),
        branchesAfter: sub.subscribedBranchCount,
        seatsAfter: await this.heldSeats(companyId),
        actor: input.requestedBy.slice(0, 120),
      },
    });

    return { allocation: this.view(row), created: true };
  }

  /**
   * One more store, priced by today's plan for the activity it will have, and
   * waiting for payment.
   *
   * The store itself is created only when the payment is confirmed — asking
   * creates nothing a shop could sell from. The activity is recorded on the
   * request (`activityTo`) so the store opens as what was paid for.
   */
  async requestStore(
    companyId: Buffer,
    input: { name: string; activity?: Activity | null; requestedBy: string },
  ): Promise<{ allocation: SeatAllocationView; created: boolean }> {
    const sub = await this.subscriptionOf(companyId);
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('Name the store.');
    if (name.length > 160) throw new BadRequestException('A store name is at most 160 characters.');
    const activity: Activity = input.activity ?? 'electronics';

    const clash = await this.prisma.branch.findFirst({
      where: { companyId, name },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        code: 'store_name_in_use',
        message: 'A store with that name already exists.',
      });
    }
    const pendingSame = await this.prisma.seatAllocation.findFirst({
      where: {
        companyId,
        kind: 'store',
        label: name,
        status: 'pending_payment',
      },
      include: INCLUDE,
    });
    if (pendingSame) return { allocation: this.view(pendingSame), created: false };

    // The running period's own prices when a paid month runs, so the request and the period's assessment agree.
    const { pricing } = await this.billing.chargeablePricing(companyId);
    const row = await this.prisma.seatAllocation.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: sub.id,
        kind: 'store',
        status: 'pending_payment',
        label: name,
        activityTo: activity,
        monthlyAmount: activityFee(activity, pricing),
        requestedBy: input.requestedBy.slice(0, 160),
      },
      include: INCLUDE,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: sub.id,
        kind: 'store_requested',
        note: `Additional store "${name}" (${activity}): ${row.monthlyAmount} MRU per month, awaiting payment.`.slice(0, 255),
        branchesAfter: sub.subscribedBranchCount,
        actor: input.requestedBy.slice(0, 120),
      },
    });

    return { allocation: this.view(row), created: true };
  }

  /**
   * Another activity for a branch (D154, docs/73 §3; reviewed 2026-10-09).
   *
   * Priced as the difference between what the branch pays and what it would
   * pay, at the running period's own prices:
   *
   *  - **higher, while a paid month runs** — an upgrade: a `pending_payment`
   *    request for exactly the difference, applied to the branch when the
   *    payment is confirmed and charged to this period at once. It cancels a
   *    change still waiting for the renewal: the Owner changed their mind.
   *  - **higher, with no paid month running** (pending, lapsed, in grace,
   *    suspended) — there is no month to charge a difference against, so it is
   *    scheduled like a downgrade and the next period is priced in full.
   *  - **lower** — a downgrade: nothing to pay, `granted` at once, written on
   *    the branch as `activity_next`, applied by the next renewal; nothing is
   *    refunded this period.
   *  - **the activity the branch already has, while a change is scheduled** —
   *    the Owner keeps it: the scheduled change is withdrawn, nothing charged.
   *
   * One open request per branch, serialised on the branch row, so two devices
   * asking at once get one request. The same target again answers with the
   * request that exists; a different one is refused until the first is
   * withdrawn. A warehouse stays `electronics` (D154 c) and cannot be asked.
   */
  async requestActivityChange(
    companyId: Buffer,
    input: { branchId: Buffer; activity: Activity; requestedBy: string },
  ): Promise<{ allocation: SeatAllocationView; created: boolean }> {
    const sub = await this.subscriptionOf(companyId);
    // A renewal that fell due at the end of a prepaid period comes first: the branch and the period are then today's.
    await this.renewal.rollIfDue(companyId);
    const actor = input.requestedBy.slice(0, 160);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM branches WHERE id = ${input.branchId} AND company_id = ${companyId} FOR UPDATE`);
      const branch = await tx.branch.findFirst({
        where: { id: input.branchId, companyId, isActive: true, deletedAt: null },
        select: { id: true, name: true, type: true, activity: true, activityNext: true },
      });
      if (!branch) throw new NotFoundException('Unknown store');
      if (branch.type === 'warehouse') {
        throw new BadRequestException({
          code: 'activity_not_for_warehouse',
          message: 'A warehouse holds stock for the electronics stores; it cannot be a money services agent.',
        });
      }

      const open = await tx.seatAllocation.findMany({
        where: { companyId, kind: 'activity', branchId: branch.id, status: { in: ['pending_payment', 'granted'] } },
        include: INCLUDE,
        orderBy: { requestedAt: 'desc' },
      });
      const scheduled = open.find((r) => isScheduledActivityChange(r));
      const unpaid = open.find((r) => r.status === 'pending_payment');

      if (branch.activity === input.activity) {
        // Keeping the activity the branch has: a change waiting for the renewal is withdrawn, free.
        if (scheduled) {
          await this.closeTx(tx, scheduled, 'released', `Withdrawn by a later request to keep ${input.activity}.`, actor);
          return { rowId: scheduled.id, created: false };
        }
        throw new BadRequestException({
          code: 'activity_unchanged',
          message: unpaid
            ? `${branch.name} is already ${input.activity}. A change to ${unpaid.activityTo} is awaiting payment; withdraw that request to keep ${input.activity}.`
            : `${branch.name} is already ${input.activity}.`,
        });
      }

      const same = [unpaid, scheduled].find((r) => r?.activityTo === input.activity);
      if (same) return { rowId: same.id, created: false };

      const { pricing, running } = await this.billing.chargeablePricing(companyId, tx);
      const change = activityChange(branch.activity, input.activity, pricing);
      const payNow = change.kind === 'upgrade' && running && sub.status === 'activated';

      // An unpaid upgrade is a price already on the table; a scheduled change survives only an upgrade paid now.
      const blocking = unpaid ?? (payNow ? undefined : scheduled);
      if (blocking) {
        throw new ConflictException({
          code: 'activity_request_pending',
          message: `${branch.name} already has a request to become ${blocking.activityTo}. Withdraw it first.`,
        });
      }

      if (payNow) {
        if (scheduled) await this.closeTx(tx, scheduled, 'released', 'Cancelled by a later upgrade request.', actor);
        const id = newUuidV7Bin();
        await tx.seatAllocation.create({
          data: {
            id,
            companyId,
            subscriptionId: sub.id,
            branchId: branch.id,
            kind: 'activity',
            status: 'pending_payment',
            activityFrom: change.from,
            activityTo: change.to,
            activityEffective: 'now',
            monthlyAmount: change.amountNow,
            requestedBy: actor,
          },
        });
        await tx.subscriptionEvent.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            subscriptionId: sub.id,
            kind: 'activity_requested',
            note: `Activity change at ${branch.name}: ${change.from} → ${change.to}, ${change.amountNow} MRU for this period (the difference), awaiting payment.`.slice(0, 255),
            branchesAfter: sub.subscribedBranchCount,
            actor: actor.slice(0, 120),
          },
        });
        return { rowId: id, created: true };
      }

      // Scheduled for the renewal: a downgrade, or an upgrade with no paid month to charge a difference against.
      const id = newUuidV7Bin();
      await tx.seatAllocation.create({
        data: {
          id,
          companyId,
          subscriptionId: sub.id,
          branchId: branch.id,
          kind: 'activity',
          status: 'granted',
          activityFrom: change.from,
          activityTo: change.to,
          activityEffective: 'renewal',
          monthlyAmount: 0,
          requestedBy: actor,
        },
      });
      await tx.branch.update({ where: { id: branch.id }, data: { activityNext: change.to } });
      await tx.subscriptionEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          subscriptionId: sub.id,
          kind: 'activity_scheduled',
          note: (change.kind === 'upgrade'
            ? `Activity change at ${branch.name}: ${change.from} → ${change.to} when the next paid period begins, priced in full then; no paid month is running to charge a difference against.`
            : `Activity change at ${branch.name}: ${change.from} → ${change.to} at the next renewal; nothing to pay, nothing refunded this period.`
          ).slice(0, 255),
          branchesAfter: sub.subscribedBranchCount,
          actor: actor.slice(0, 120),
        },
      });
      return { rowId: id, created: true };
    });

    return { allocation: this.view(await this.load(outcome.rowId)), created: outcome.created };
  }

  // ── deciding ─────────────────────────────────────────────────────────────

  /**
   * An administrator says the money for this request arrived.
   *
   * A reference is required: a confirmation nobody can check against a bank
   * statement or a receipt is not evidence. The payment row and the status
   * change commit together; the `version` guard makes a second confirmation —
   * a retry, or a colleague a second later — a refusal, never a second payment.
   * A request already paid answers `applied: false` with what it has, so a
   * dropped response can be retried safely.
   *
   * For a store request, the store is created here with the activity that was
   * paid for, the company's subscribed store count rises by one, and every
   * Owner is assigned to it so the shop can use it at once. For an activity
   * upgrade, the branch takes its new activity here, and the period is
   * assessed for the difference. A seat request grants nothing by itself: the
   * caller then asks the activation service whether the person may now be
   * activated.
   */
  async confirmPayment(
    allocationId: Buffer,
    input: {
      amount: string;
      paidAt: Date;
      channel?: 'manual' | 'bank_transfer' | 'mobile_money';
      reference: string;
      note?: string;
      expectedVersion?: number;
    },
    ctx: ActorContext,
  ): Promise<{
    allocation: SeatAllocationView;
    applied: boolean;
    paymentId: string | null;
  }> {
    const reference = (input.reference ?? '').trim();
    if (reference.length < PAYMENT_REFERENCE_MIN_LENGTH) {
      throw new BadRequestException({
        code: 'reference_required',
        message: 'Enter the payment reference — the transfer id or receipt number — before confirming.',
      });
    }
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter the amount that was actually paid.');
    }
    if (Number.isNaN(input.paidAt.getTime()) || input.paidAt.getTime() > this.clock.now().getTime() + 5 * 60_000) {
      throw new BadRequestException('The payment date cannot be in the future.');
    }

    const before = await this.load(allocationId);
    // A stale version is a colleague's decision the caller has not seen: told to refresh,
    // whatever the state. Without a version, a retry that finds the work done is a no-op.
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) throw CHANGED();
    if (before.status === 'paid') {
      return {
        allocation: this.view(before),
        applied: false,
        paymentId: before.payment ? binToUuid(before.payment.id) : null,
      };
    }
    if (before.status !== 'pending_payment') {
      throw new BadRequestException(
        `This request was ${before.status}; only a request awaiting payment can be confirmed.`,
      );
    }

    const sub = await this.subscriptionOf(before.companyId);
    const now = this.clock.now();

    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.subscriptionPayment.create({
        data: {
          id: newUuidV7Bin(),
          companyId: before.companyId,
          subscriptionId: sub.id,
          amount: new Prisma.Decimal(input.amount),
          currency: 'MRU',
          paidAt: input.paidAt,
          channel: input.channel ?? 'manual',
          reference: reference.slice(0, 120),
          note: input.note?.slice(0, 500) ?? null,
          recordedBy: ctx.admin.email,
          confirmedBy: ctx.admin.email,
          confirmedAt: now,
        },
      });

      // The guard. If the row moved under us, this writes nothing — and the
      // thrown conflict rolls the payment back with it.
      const moved = await tx.seatAllocation.updateMany({
        where: {
          id: allocationId,
          status: 'pending_payment',
          version: before.version,
        },
        data: {
          status: 'paid',
          paymentId: payment.id,
          confirmedBy: ctx.admin.email,
          confirmedAt: now,
          version: { increment: 1 },
        },
      });
      if (moved.count !== 1) throw CHANGED();

      let storeName: string | null = null;
      if (before.kind === 'store') {
        storeName = before.label ?? 'New store';
        let branch: { id: Buffer };
        try {
          branch = await tx.branch.create({
            data: {
              id: newUuidV7Bin(),
              companyId: before.companyId,
              name: storeName,
              type: 'store',
              // What was paid for. A request made before activities existed has none and opens as electronics.
              activity: before.activityTo ?? 'electronics',
            },
            select: { id: true },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictException({
              code: 'store_name_in_use',
              message: 'A store with that name already exists.',
            });
          }
          throw e;
        }
        // Every Owner works at every store: assign them so the shop can use it at once.
        const owners = await tx.userBranch.findMany({
          where: {
            companyId: before.companyId,
            role: { key: 'owner' },
            user: { deletedAt: null },
          },
          distinct: ['userId'],
          select: { userId: true, roleId: true },
        });
        for (const o of owners) {
          await tx.userBranch.create({
            data: {
              id: newUuidV7Bin(),
              companyId: before.companyId,
              userId: o.userId,
              branchId: branch.id,
              roleId: o.roleId,
            },
          });
        }
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            subscribedBranchCount: { increment: 1 },
            version: { increment: 1 },
          },
        });
        await tx.subscriptionEvent.create({
          data: {
            id: newUuidV7Bin(),
            companyId: before.companyId,
            subscriptionId: sub.id,
            kind: 'branches_changed',
            note: `Store "${storeName}" (${before.activityTo ?? 'electronics'}) opened after payment ${reference}.`.slice(0, 255),
            branchesAfter: sub.subscribedBranchCount + 1,
            actor: ctx.admin.email,
          },
        });
      }

      if (before.kind === 'activity') {
        if (!before.branchId || !before.activityTo) throw new BadRequestException('This activity request names no store.');
        // The upgrade takes effect now. A downgrade waiting for the renewal on
        // the same branch cannot exist beside an upgrade (one open request per
        // branch), but the column is cleared regardless: what was paid for wins.
        const changed = await tx.branch.updateMany({
          where: { id: before.branchId, companyId: before.companyId },
          data: { activity: before.activityTo, activityNext: null, activityChangedAt: now },
        });
        if (changed.count !== 1) throw new NotFoundException('Unknown store');
        // Whatever else was open for this branch is superseded by what was paid for: no stale "scheduled" row survives.
        await tx.seatAllocation.updateMany({
          where: {
            companyId: before.companyId,
            kind: 'activity',
            branchId: before.branchId,
            id: { not: before.id },
            status: { in: ['pending_payment', 'granted'] },
            confirmedAt: null,
          },
          data: { status: 'released', closedAt: now, closedBy: ctx.admin.email.slice(0, 160), reason: 'Superseded by the paid upgrade.', version: { increment: 1 } },
        });
        await tx.subscriptionEvent.create({
          data: {
            id: newUuidV7Bin(),
            companyId: before.companyId,
            subscriptionId: sub.id,
            kind: 'activity_changed',
            note: `Store "${before.branch?.name ?? ''}": ${before.activityFrom ?? '?'} → ${before.activityTo} after payment ${reference}.`.slice(0, 255),
            branchesAfter: sub.subscribedBranchCount,
            actor: ctx.admin.email,
          },
        });
      }

      await tx.subscriptionEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId: before.companyId,
          subscriptionId: sub.id,
          kind: 'seat_paid',
          note: `${before.kind === 'store' ? 'Store' : requestLabel(before)}: payment confirmed, reference ${reference}.`.slice(0, 255),
          branchesAfter: sub.subscribedBranchCount + (before.kind === 'store' ? 1 : 0),
          actor: ctx.admin.email,
        },
      });

      // A seat, a store or an activity upgrade added mid-period costs the whole month, now — in this transaction, so the
      // payment, the change and the assessment commit together. A period that already ended is never raised.
      await this.billing.assessNow(before.companyId, tx);

      return { payment, storeName };
    });

    const action =
      before.kind === 'store'
        ? 'store.payment_confirm'
        : before.kind === 'activity'
          ? 'activity.payment_confirm'
          : 'seat.payment_confirm';
    await this.audit.record({
      admin: ctx.admin,
      action,
      targetType: 'Company',
      targetId: before.companyId,
      targetLabel: sub.company.name,
      reason: input.note ?? null,
      before: {
        requestId: binToUuid(allocationId),
        status: 'pending_payment',
        version: before.version,
        ...(before.kind === 'activity' ? { activity: before.activityFrom } : {}),
      },
      after: {
        requestId: binToUuid(allocationId),
        status: 'paid',
        paymentId: binToUuid(result.payment.id),
        amount: input.amount,
        currency: 'MRU',
        channel: result.payment.channel,
        reference,
        ...(result.storeName ? { storeOpened: result.storeName, activity: before.activityTo ?? 'electronics' } : {}),
        ...(before.branch ? { store: before.branch.name } : {}),
        ...(before.user ? { person: before.user.name } : {}),
        ...(before.kind === 'activity' ? { activity: before.activityTo } : {}),
        // Said explicitly, so nobody reading the log later infers otherwise.
        providerVerified: false,
      },
      ip: ctx.ip ?? null,
    });

    const after = await this.load(allocationId);
    return {
      allocation: this.view(after),
      applied: true,
      paymentId: binToUuid(result.payment.id),
    };
  }

  /** Refuse a request awaiting payment, with a reason. Nothing was ever granted by it — a branch keeps the activity it has. */
  async refuse(
    allocationId: Buffer,
    input: { reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ): Promise<{ allocation: SeatAllocationView; applied: boolean }> {
    if (!input.reason?.trim()) throw new BadRequestException('Say why this request is refused.');
    const before = await this.load(allocationId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) throw CHANGED();
    if (before.status === 'refused') return { allocation: this.view(before), applied: false };
    if (before.status !== 'pending_payment') {
      throw new BadRequestException(
        `This request was ${before.status}; only a request awaiting payment can be refused.`,
      );
    }
    return this.close(before, 'refused', input.reason, ctx.admin.email, {
      admin: ctx.admin,
      action: actionOf(before.kind, 'refuse'),
      ip: ctx.ip ?? null,
    });
  }

  /**
   * Give a held seat back. Nothing is refunded this period, and nobody is
   * deactivated: a store left with more people than seats is reported, and the
   * Owner decides who stays.
   *
   * For an activity change, only a downgrade still waiting for the renewal can
   * be released — the branch simply keeps what it has. A change already in
   * force is not undone here; the business asks for another activity instead.
   */
  async release(
    allocationId: Buffer,
    input: { reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ): Promise<{ allocation: SeatAllocationView; applied: boolean }> {
    if (!input.reason?.trim()) throw new BadRequestException('Say why this seat is released.');
    const before = await this.load(allocationId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) throw CHANGED();
    if (before.status === 'released') return { allocation: this.view(before), applied: false };
    if (before.status !== 'paid' && before.status !== 'granted') {
      throw new BadRequestException(`This request was ${before.status}; only a held seat can be released.`);
    }
    if (before.kind === 'store') {
      throw new BadRequestException('A store is not released here: archive the store in the shop instead.');
    }
    if (before.kind === 'activity' && !isScheduledActivityChange(before)) {
      throw new BadRequestException(
        'An activity change already in force is not released here: the business requests another activity instead.',
      );
    }
    return this.close(before, 'released', input.reason, ctx.admin.email, {
      admin: ctx.admin,
      action: actionOf(before.kind, 'release'),
      ip: ctx.ip ?? null,
    });
  }

  /**
   * The Owner withdraws a request nobody has paid yet — or a downgrade still
   * waiting for the renewal, which costs nothing to take back. Only their own
   * company's.
   */
  async withdraw(
    companyId: Buffer,
    allocationId: Buffer,
    actor: string,
  ): Promise<{ allocation: SeatAllocationView; applied: boolean }> {
    const before = await this.load(allocationId);
    if (!before.companyId.equals(companyId)) throw new NotFoundException('Unknown request');
    if (before.status === 'released') return { allocation: this.view(before), applied: false };
    if (isScheduledActivityChange(before)) {
      return this.close(before, 'released', 'Withdrawn by the business before the renewal.', actor, null);
    }
    if (before.status !== 'pending_payment') {
      throw new BadRequestException(
        'Only a request still awaiting payment, or an activity change scheduled for the renewal, can be withdrawn.',
      );
    }
    return this.close(before, 'released', 'Withdrawn by the business before payment.', actor, null);
  }

  /** Close a request inside the caller's transaction: the status move, the cleared `activity_next`, the event. */
  private async closeTx(tx: BillingDb, before: Row, status: 'refused' | 'released', reason: string, closedBy: string): Promise<void> {
    const now = this.clock.now();
    const moved = await tx.seatAllocation.updateMany({
      where: { id: before.id, status: before.status, version: before.version },
      data: { status, closedAt: now, closedBy: closedBy.slice(0, 160), reason: reason.slice(0, 500), version: { increment: 1 } },
    });
    if (moved.count !== 1) throw CHANGED();
    if (isScheduledActivityChange(before) && before.branchId && before.activityTo) {
      await tx.branch.updateMany({
        where: { id: before.branchId, companyId: before.companyId, activityNext: before.activityTo },
        data: { activityNext: null },
      });
    }
    await tx.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: before.companyId,
        subscriptionId: before.subscriptionId,
        kind: 'seat_closed',
        note: `${requestLabel(before)} ${status}: ${reason}`.slice(0, 255),
        actor: closedBy.slice(0, 120),
      },
    });
  }

  private async close(
    before: Row,
    status: 'refused' | 'released',
    reason: string,
    closedBy: string,
    audit: {
      admin: PlatformAdminIdentity;
      action: string;
      ip: string | null;
    } | null,
  ): Promise<{ allocation: SeatAllocationView; applied: boolean }> {
    const now = this.clock.now();
    const moved = await this.prisma.seatAllocation.updateMany({
      where: { id: before.id, status: before.status, version: before.version },
      data: {
        status,
        closedAt: now,
        closedBy: closedBy.slice(0, 160),
        reason: reason.slice(0, 500),
        version: { increment: 1 },
      },
    });
    if (moved.count !== 1) throw CHANGED();

    // A downgrade taken back before the renewal: the branch keeps its activity,
    // and the renewal has nothing to apply.
    if (isScheduledActivityChange(before) && before.branchId && before.activityTo) {
      await this.prisma.branch.updateMany({
        where: { id: before.branchId, companyId: before.companyId, activityNext: before.activityTo },
        data: { activityNext: null },
      });
    }

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: before.companyId,
        subscriptionId: before.subscriptionId,
        kind: 'seat_closed',
        note: `${requestLabel(before)} ${status}: ${reason}`.slice(0, 255),
        seatsAfter: await this.heldSeats(before.companyId),
        actor: closedBy.slice(0, 120),
      },
    });

    if (audit) {
      const company = await this.prisma.company.findUnique({
        where: { id: before.companyId },
        select: { name: true },
      });
      await this.audit.record({
        admin: audit.admin,
        action: audit.action,
        targetType: 'Company',
        targetId: before.companyId,
        targetLabel: company?.name ?? null,
        reason,
        before: {
          requestId: binToUuid(before.id),
          status: before.status,
          version: before.version,
          ...(before.kind === 'activity' ? { activityFrom: before.activityFrom, activityTo: before.activityTo } : {}),
        },
        after: { requestId: binToUuid(before.id), status },
        ip: audit.ip,
      });
    }

    const after = await this.load(before.id);
    return { allocation: this.view(after), applied: true };
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async listForCompany(companyId: Buffer): Promise<SeatAllocationView[]> {
    const rows = await this.prisma.seatAllocation.findMany({
      where: { companyId },
      include: INCLUDE,
      orderBy: { requestedAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.view(r));
  }

  /** The platform's queue: what is waiting for a decision, oldest first. */
  async queue(status: SeatAllocationStatus = 'pending_payment'): Promise<SeatRequestQueueItem[]> {
    const rows = await this.prisma.seatAllocation.findMany({
      where: { status },
      include: {
        ...INCLUDE,
        company: { select: { id: true, name: true, publicStoreId: true } },
      },
      orderBy: { requestedAt: status === 'pending_payment' ? 'asc' : 'desc' },
      take: 200,
    });
    return rows.map((r) => ({
      ...this.view(r),
      business: {
        id: binToUuid(r.company.id),
        name: r.company.name,
        publicStoreId: r.company.publicStoreId,
      },
    }));
  }
}
