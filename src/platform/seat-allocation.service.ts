import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SeatAllocationKind, type SeatAllocationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { AuditService } from '../common/audit/audit.service';
import { BillingService, periodRunning, type BillingDb } from '../billing/billing.service';
import { SubscriptionRenewal, lockSubscription } from '../billing/renewal';
import { activityFee, chooseReplacementSlot, replacementDue, type ActivityPrices } from '../billing/pricing-rules';
import { CLOCK, type Clock } from '../entitlement/clock';
import { ACTIVITIES, type Activity } from '../entitlement/activity';
import { decideActivityChange } from './activity-decision';
import { newUuidV7Bin, binToUuid, uuidToBin } from '../common/utils/uuid.util';
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
 * A store that takes the place of one archived during the running paid period
 * (D158, docs/73 §11.1) is priced against what that period already paid for the
 * location: nothing when it costs the same or less — it opens at once — and
 * only the difference when it costs more. Each replacement is written down once
 * in `branch_replacements`, and every request that can take or price a slot is
 * decided behind the subscription row's lock.
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
  /**
   * A store request that takes the place of a store archived in the running paid period (D158): that store, and
   * what the period already paid for its location — the credit the request was priced against.
   */
  replaces: { branchId: string; name: string; credit: number } | null;
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
  replaces: { select: { id: true, name: true } },
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

/** One activity a store could be asked to take, as the server would answer the request now. */
export type ActivityOption =
  | { activity: Activity; outcome: 'now' | 'renewal' | 'keep' | 'requested'; dueNow: number; monthlyAfter: number }
  | { activity: Activity; outcome: 'refused'; code: 'activity_request_pending'; blockedBy: Activity; dueNow: 0; monthlyAfter: null };

export interface ActivityOptionsView {
  /** A paid month is running: an upgrade's difference is due now. */
  running: boolean;
  stores: { branchId: string; name: string; activity: Activity; activityNext: Activity | null; options: ActivityOption[] }[];
  /**
   * A new store of each activity: its monthly fee, what asking for it now would put awaiting payment (`dueNow` —
   * zero when it takes an archived store's place at no charge, D158), and the archived store it would replace.
   */
  newStore: { activity: Activity; monthly: number; dueNow: number; replaces: { branchId: string; name: string; credit: number } | null }[];
}

const CHANGED = () =>
  new ConflictException({
    code: 'seat_request_changed',
    message: 'Somebody else changed this request. Refresh and try again.',
  });

/** A store request priced against a slot that is gone (D158): confirming it would charge a stale figure. */
const NO_LONGER_APPLIES = () =>
  new ConflictException({
    code: 'replacement_no_longer_applies',
    message:
      'This store was priced as the replacement of a store archived in the running period, and that no longer holds: the period renewed, the archived store is active again, or another store already took its place. Nothing was charged. Refuse or withdraw this request; asked again, it is priced afresh.',
  });

/** An activity upgrade priced against a replacement's credit (D158) whose period has ended: the credit belonged to it alone. */
const CREDIT_NO_LONGER_APPLIES = () =>
  new ConflictException({
    code: 'replacement_no_longer_applies',
    message:
      'This change was priced against what the running period had already paid for the store this one replaced, and that period has ended. Nothing was charged. Refuse or withdraw this request; asked again, it is priced afresh.',
  });

/** The audit writer's client: a tenant transaction, which the base transaction is at run time. */
type AuditClient = Parameters<AuditService['recordTx']>[0];

/** A store request's reserved slot, still standing at its confirmation (D158). */
interface ReservedSlot {
  periodId: Buffer;
  /** The period's own prices: the replacement's fee is written down at them. */
  prices: ActivityPrices;
  archived: { id: Buffer; name: string; activity: Activity };
}

/** What the platform audit says about a replacement confirmed with its payment (D158 B5). */
interface ReplacementRecord {
  archivedBranchId: string;
  archivedStore: string;
  archivedActivity: Activity;
  slotFee: number;
  replacementFee: number;
  chargedDifference: number;
  decision: 'difference_charged';
}

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
    /** The tenant's own audit trail: a replacement decided on the Owner's request is written there (D158 B5). */
    private readonly tenantAudit: AuditService,
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
      replaces: row.replaces
        ? { branchId: binToUuid(row.replaces.id), name: row.replaces.name, credit: row.replacementCredit ?? 0 }
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
   * One more store, priced for the activity it will have (D154) — and, when it
   * takes the place of a store archived during the running paid period, priced
   * against what that period already paid for the location (D158, docs/73
   * §11.1):
   *
   *  - **no slot** — nothing was archived this period, or the old store still
   *    runs: a second store, its full monthly fee, awaiting payment (B4);
   *  - **a slot that covers the fee** — the same activity or a cheaper one:
   *    nothing to pay, so the store opens at once (`granted`) and the
   *    replacement is written down for good (B2);
   *  - **a slot that does not** — a dearer activity: exactly the difference,
   *    awaiting payment, the slot reserved by the request; the store opens at
   *    the payment's confirmation, like any store (B3).
   *
   * The store a payment is still awaited for is created only when that payment
   * is confirmed — asking creates nothing a shop could sell from. The activity
   * is recorded on the request (`activityTo`) so the store opens as what was
   * asked for. Every request is decided behind the subscription row's lock, the
   * one the renewal and the confirmations take: the same name again answers
   * with the request awaiting payment, and a slot taken or reserved by one
   * request is invisible to the next (B6).
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
    const actor = input.requestedBy.slice(0, 160);
    // A renewal that fell due at the end of a prepaid period comes first: the slots and the prices are then the
    // period's that really runs.
    await this.renewal.rollIfDue(companyId);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, companyId);
      const clash = await tx.branch.findFirst({
        where: { companyId, name },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException({
          code: 'store_name_in_use',
          message: 'A store with that name already exists.',
        });
      }
      const pendingSame = await tx.seatAllocation.findFirst({
        where: {
          companyId,
          kind: 'store',
          label: name,
          status: 'pending_payment',
        },
        select: { id: true },
      });
      if (pendingSame) return { rowId: pendingSame.id, created: false };

      // The running period's own prices when a paid month runs, so the request and the period's assessment agree.
      const { pricing } = await this.billing.chargeablePricing(companyId, tx);
      const fee = activityFee(activity, pricing);
      const found = await this.billing.replacementSlots(companyId, tx);
      const slot = found ? chooseReplacementSlot(found.slots, fee) : null;
      const id = newUuidV7Bin();

      if (!found || !slot) {
        await tx.seatAllocation.create({
          data: {
            id,
            companyId,
            subscriptionId: sub.id,
            kind: 'store',
            status: 'pending_payment',
            label: name,
            activityTo: activity,
            monthlyAmount: fee,
            requestedBy: actor,
          },
        });
        await tx.subscriptionEvent.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            subscriptionId: sub.id,
            kind: 'store_requested',
            note: `Additional store "${name}" (${activity}): ${fee} MRU per month, awaiting payment.`.slice(0, 255),
            branchesAfter: sub.subscribedBranchCount,
            actor: actor.slice(0, 120),
          },
        });
        return { rowId: id, created: true };
      }

      const due = replacementDue(fee, slot.value);
      // The slot this request takes, written on it: a later request cannot take it, and the confirmation re-checks it.
      const reserved = {
        replacesBranchId: uuidToBin(slot.branchId),
        replacementCredit: slot.value,
        replacementPeriodId: found.period.id,
      };

      if (due > 0) {
        await tx.seatAllocation.create({
          data: {
            id,
            companyId,
            subscriptionId: sub.id,
            kind: 'store',
            status: 'pending_payment',
            label: name,
            activityTo: activity,
            monthlyAmount: due,
            requestedBy: actor,
            ...reserved,
          },
        });
        await tx.subscriptionEvent.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            subscriptionId: sub.id,
            kind: 'store_requested',
            note: `Store "${name}" (${activity}) replacing "${slot.name}", archived this period: ${due} MRU for this period (the difference; ${slot.value} MRU already paid for that location), awaiting payment.`.slice(0, 255),
            branchesAfter: sub.subscribedBranchCount,
            actor: actor.slice(0, 120),
          },
        });
        return { rowId: id, created: true };
      }

      // Nothing to pay: a confirmation of nothing would only delay the shop. The store opens now, as a paid one does,
      // and the replacement is written down once, for good, in this same transaction.
      const now = this.clock.now();
      await tx.seatAllocation.create({
        data: {
          id,
          companyId,
          subscriptionId: sub.id,
          kind: 'store',
          status: 'granted',
          label: name,
          activityTo: activity,
          monthlyAmount: 0,
          requestedBy: actor,
          confirmedBy: actor,
          confirmedAt: now,
          reason: `Replaces "${slot.name}", archived this period: nothing to pay.`.slice(0, 500),
          ...reserved,
        },
      });
      await tx.subscriptionEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          subscriptionId: sub.id,
          kind: 'store_requested',
          note: `Store "${name}" (${activity}) replacing "${slot.name}", archived this period: 0 MRU — the ${slot.value} MRU already paid for that location covers its ${fee}.`.slice(0, 255),
          branchesAfter: sub.subscribedBranchCount,
          actor: actor.slice(0, 120),
        },
      });
      const branchId = await this.openStoreTx(tx, {
        companyId,
        subscriptionId: sub.id,
        name,
        activity,
        actor,
        note: `Store "${name}" (${activity}) opened at once as the replacement of "${slot.name}"; nothing to pay.`,
      });
      const replacementId = newUuidV7Bin();
      await this.recordReplacementTx(tx, {
        id: replacementId,
        companyId,
        billingPeriodId: found.period.id,
        archivedBranchId: reserved.replacesBranchId,
        replacementBranchId: branchId,
        seatAllocationId: id,
        archivedActivity: slot.activity,
        replacementActivity: activity,
        slotFee: slot.value,
        replacementFee: fee,
        chargedDifference: 0,
        decision: 'no_additional_charge',
        paymentId: null,
        decidedBy: actor,
        decidedAt: now,
      });
      await tx.seatAllocation.updateMany({ where: { id }, data: { branchId } });
      // Adds nothing for the new store — its credit covers it — but writes its fee into the period's map in the same
      // transaction, so the period, the store and the decision commit together.
      await this.billing.assessNow(companyId, tx);
      await this.tenantAudit.recordTx(tx as unknown as AuditClient, {
        entityType: 'BranchReplacement',
        entityId: replacementId,
        action: 'create',
        branchId,
        after: {
          requestId: binToUuid(id),
          billingPeriodId: binToUuid(found.period.id),
          archivedBranchId: slot.branchId,
          archivedStore: slot.name,
          archivedActivity: slot.activity,
          replacementBranchId: binToUuid(branchId),
          replacementStore: name,
          replacementActivity: activity,
          slotFee: slot.value,
          replacementFee: fee,
          chargedDifference: 0,
          decision: 'no_additional_charge',
        },
      });
      return { rowId: id, created: true };
    });

    return { allocation: this.view(await this.load(outcome.rowId)), created: outcome.created };
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
   *  - **higher, at a branch that replaced an archived store this period** —
   *    priced against the credit its slot carried (D158): the difference the
   *    credit does not cover, or, when it covers it all, nothing — applied at
   *    once, `granted` with `effective: now`, never a request for 0 to confirm.
   *
   * One open request per branch, serialised on the subscription row and then
   * the branch row — the subscription first, as every request and confirmation
   * that prices the period takes it — so two devices asking at once get one
   * request. The same target again answers with the request that exists; a
   * different one is refused until the first is withdrawn. A warehouse stays
   * `electronics` (D154 c) and cannot be asked.
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
      await lockSubscription(tx, companyId);
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
      const { pricing, running } = await this.billing.chargeablePricing(companyId, tx);
      const credit = (await this.billing.replacementCredits(companyId, tx))[binToUuid(branch.id)] ?? 0;
      // Read under the lock: a suspension committed since the read above must not let a credit apply the change at once.
      const locked = await tx.subscription.findFirst({ where: { companyId }, select: { status: true } });
      const decision = decideActivityChange({
        from: branch.activity,
        to: input.activity,
        unpaidTo: unpaid?.activityTo ?? null,
        scheduledTo: scheduled?.activityTo ?? null,
        pricing,
        running,
        activated: locked?.status === 'activated',
        credit,
      });

      switch (decision.kind) {
        case 'keep':
          // Keeping the activity the branch has: the change waiting for the renewal is withdrawn, free.
          await this.closeTx(tx, scheduled as Row, 'released', `Withdrawn by a later request to keep ${input.activity}.`, actor);
          return { rowId: (scheduled as Row).id, created: false };
        case 'unchanged':
          throw new BadRequestException({
            code: 'activity_unchanged',
            message: unpaid
              ? `${branch.name} is already ${input.activity}. A change to ${unpaid.activityTo} is awaiting payment; withdraw that request to keep ${input.activity}.`
              : `${branch.name} is already ${input.activity}.`,
          });
        case 'requested':
          return { rowId: (decision.status === 'pending_payment' ? (unpaid as Row) : (scheduled as Row)).id, created: false };
        case 'blocked':
          // An unpaid upgrade is a price already on the table; a scheduled change survives only an upgrade paid now.
          throw new ConflictException({
            code: 'activity_request_pending',
            message: `${branch.name} already has a request to become ${decision.by}. Withdraw it first.`,
          });
      }
      const change = decision.change;

      if (decision.kind === 'charge_now') {
        if (scheduled) await this.closeTx(tx, scheduled, 'released', 'Cancelled by a later upgrade request.', actor);
        // A difference left after a replacement's credit is this period's figure alone (D158): the period is written
        // down with it, and the confirmation refuses the figure once that period has ended.
        const pricedIn = credit > 0 ? await this.billing.latestPeriod(companyId, tx) : null;
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
            ...(pricedIn ? { replacementCredit: credit, replacementPeriodId: pricedIn.id } : {}),
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

      if (decision.kind === 'apply_now') {
        // The credit of the store this branch replaced covers the dearer fee (D158): in force now, nothing to pay. The
        // period's assessment records the branch's new fee in this transaction and charges nothing for it.
        if (scheduled) await this.closeTx(tx, scheduled, 'released', 'Cancelled by a later upgrade.', actor);
        const now = this.clock.now();
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
            activityEffective: 'now',
            monthlyAmount: 0,
            requestedBy: actor,
            // Decided and applied at once, so it is never mistaken for a change still waiting for the renewal.
            confirmedBy: actor,
            confirmedAt: now,
            reason: `Covered by the ${credit} MRU this period already paid for the store this one replaced.`,
          },
        });
        await tx.branch.update({
          where: { id: branch.id },
          data: { activity: change.to, activityNext: null, activityChangedAt: now },
        });
        await tx.subscriptionEvent.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            subscriptionId: sub.id,
            kind: 'activity_changed',
            note: `Activity change at ${branch.name}: ${change.from} → ${change.to} now; nothing to pay — this period already paid ${credit} MRU for this location (the store it replaced).`.slice(0, 255),
            branchesAfter: sub.subscribedBranchCount,
            actor: actor.slice(0, 120),
          },
        });
        await this.billing.assessNow(companyId, tx);
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

  /**
   * What asking for each other activity would do at each store right now, and what a new store would be charged
   * (D154; D158 for a store that would replace an archived one): the request's own decision and prices, written
   * nowhere — so the Owner's page explains a change with the server's figures, never its own arithmetic. `dueNow` is
   * what a request would put awaiting payment (zero for a change applied at once); `monthlyAfter` what the store
   * pays per month once the next paid period opens, at the plan in force then.
   */
  async activityOptions(companyId: Buffer): Promise<ActivityOptionsView> {
    const sub = await this.subscriptionOf(companyId);
    await this.renewal.rollIfDue(companyId);
    const [branches, open, { pricing, running }, renewalPricing, credits, found] = await Promise.all([
      this.prisma.branch.findMany({
        where: { companyId, isActive: true, deletedAt: null, type: { not: 'warehouse' } },
        select: { id: true, name: true, activity: true, activityNext: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.seatAllocation.findMany({
        where: { companyId, kind: 'activity', status: { in: ['pending_payment', 'granted'] } },
        include: INCLUDE,
        orderBy: { requestedAt: 'desc' },
      }),
      this.billing.chargeablePricing(companyId),
      this.billing.renewalPricing(companyId),
      this.billing.replacementCredits(companyId),
      this.billing.replacementSlots(companyId),
    ]);
    const stores = branches.map((branch) => {
      const here = open.filter((r) => r.branchId?.equals(branch.id));
      const scheduled = here.find((r) => isScheduledActivityChange(r));
      const unpaid = here.find((r) => r.status === 'pending_payment');
      const options = ACTIVITIES.map((to): ActivityOption | null => {
        const decision = decideActivityChange({
          from: branch.activity,
          to,
          unpaidTo: unpaid?.activityTo ?? null,
          scheduledTo: scheduled?.activityTo ?? null,
          pricing,
          running,
          activated: sub.status === 'activated',
          credit: credits[binToUuid(branch.id)] ?? 0,
        });
        const after = activityFee(to, renewalPricing);
        switch (decision.kind) {
          case 'unchanged':
            return null;
          case 'keep':
            return { activity: to, outcome: 'keep', dueNow: 0, monthlyAfter: after };
          case 'requested':
            return { activity: to, outcome: 'requested', dueNow: decision.status === 'pending_payment' ? (unpaid?.monthlyAmount ?? 0) : 0, monthlyAfter: after };
          case 'blocked':
            return { activity: to, outcome: 'refused', code: 'activity_request_pending', blockedBy: decision.by, dueNow: 0, monthlyAfter: null };
          case 'charge_now':
            return { activity: to, outcome: 'now', dueNow: decision.change.amountNow, monthlyAfter: after };
          case 'apply_now':
            return { activity: to, outcome: 'now', dueNow: 0, monthlyAfter: after };
          case 'at_renewal':
            return { activity: to, outcome: 'renewal', dueNow: 0, monthlyAfter: after };
        }
      }).filter((o): o is ActivityOption => o !== null);
      return { branchId: binToUuid(branch.id), name: branch.name, activity: branch.activity, activityNext: branch.activityNext, options };
    });
    return {
      running,
      stores,
      // What requestStore asks for a new store of each activity: its fee at the chargeable prices, less the slot of an
      // archived store it would take — chosen exactly as the request chooses it.
      newStore: ACTIVITIES.map((activity) => {
        const monthly = activityFee(activity, pricing);
        const slot = found ? chooseReplacementSlot(found.slots, monthly) : null;
        return {
          activity,
          monthly,
          dueNow: slot ? replacementDue(monthly, slot.value) : monthly,
          replaces: slot ? { branchId: slot.branchId, name: slot.name, credit: slot.value } : null,
        };
      }),
    };
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
   * paid for, the company's subscribed store count rises by one, every Owner
   * is assigned to it so the shop can use it at once, and the request names the
   * store it opened. A store priced as the replacement of an archived one
   * (D158) is confirmed only while its slot still stands — re-read under the
   * subscription lock — and the replacement is written down with the payment;
   * a slot that is gone is refused (`replacement_no_longer_applies`) before
   * anything is written, never charged on a stale figure. For an activity
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
      // One confirmation at a time per company, behind the lock the renewal and the requests take: a reserved slot
      // is re-read, and the period assessed, against what the previous one committed.
      await lockSubscription(tx, before.companyId);

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

      // Judged only for the confirmation that won the guard. A slot that is gone throws, and the throw rolls the
      // payment and the status back with it: nothing is charged on a stale figure.
      const slot = before.kind === 'store' && before.replacesBranchId ? await this.reservedSlotTx(tx, before) : null;
      if (before.kind === 'activity' && before.replacementPeriodId) await this.creditPeriodTx(tx, before);

      let storeName: string | null = null;
      let replacement: ReplacementRecord | null = null;
      if (before.kind === 'store') {
        storeName = before.label ?? 'New store';
        // What was paid for. A request made before activities existed has none and opens as electronics.
        const activity = before.activityTo ?? 'electronics';
        const branchId = await this.openStoreTx(tx, {
          companyId: before.companyId,
          subscriptionId: sub.id,
          name: storeName,
          activity,
          actor: ctx.admin.email,
          note: `Store "${storeName}" (${activity}) opened after payment ${reference}.`,
        });
        if (slot) {
          replacement = {
            archivedBranchId: binToUuid(slot.archived.id),
            archivedStore: slot.archived.name,
            archivedActivity: slot.archived.activity,
            slotFee: before.replacementCredit ?? 0,
            replacementFee: activityFee(activity, slot.prices),
            chargedDifference: before.monthlyAmount,
            decision: 'difference_charged',
          };
          await this.recordReplacementTx(tx, {
            id: newUuidV7Bin(),
            companyId: before.companyId,
            billingPeriodId: slot.periodId,
            archivedBranchId: slot.archived.id,
            replacementBranchId: branchId,
            seatAllocationId: before.id,
            archivedActivity: slot.archived.activity,
            replacementActivity: activity,
            slotFee: replacement.slotFee,
            replacementFee: replacement.replacementFee,
            chargedDifference: replacement.chargedDifference,
            decision: replacement.decision,
            paymentId: payment.id,
            decidedBy: ctx.admin.email.slice(0, 160),
            decidedAt: now,
          });
        }
        // The request names the store it opened, for good — the link a matching label never was.
        await tx.seatAllocation.updateMany({ where: { id: before.id }, data: { branchId } });
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

      return { payment, storeName, replacement };
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
        // The archived store this one replaced, the slot it took and what the replacement cost (D158 B5).
        ...(result.replacement ? { replacement: result.replacement } : {}),
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

  /**
   * Open a store: the branch with its activity, every Owner assigned to it so the shop can use it at once, the
   * subscribed store count raised by one, and the timeline told why. One path for a store paid for and for one that
   * took an archived store's place at no charge (D158), so the two can never open differently.
   */
  private async openStoreTx(
    tx: BillingDb,
    input: { companyId: Buffer; subscriptionId: Buffer; name: string; activity: Activity; actor: string; note: string },
  ): Promise<Buffer> {
    let branch: { id: Buffer };
    try {
      branch = await tx.branch.create({
        data: {
          id: newUuidV7Bin(),
          companyId: input.companyId,
          name: input.name,
          type: 'store',
          activity: input.activity,
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
        companyId: input.companyId,
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
          companyId: input.companyId,
          userId: o.userId,
          branchId: branch.id,
          roleId: o.roleId,
        },
      });
    }
    const counted = await tx.subscription.update({
      where: { id: input.subscriptionId },
      data: {
        subscribedBranchCount: { increment: 1 },
        version: { increment: 1 },
      },
      select: { subscribedBranchCount: true },
    });
    await tx.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: input.companyId,
        subscriptionId: input.subscriptionId,
        kind: 'branches_changed',
        note: input.note.slice(0, 255),
        branchesAfter: counted.subscribedBranchCount,
        actor: input.actor.slice(0, 120),
      },
    });
    return branch.id;
  }

  /**
   * The slot a store request reserved, re-read at its confirmation under the subscription lock (D158): the period it
   * was priced in must still be the latest one and still running, the archived store still archived, and its place
   * still free. Otherwise the difference it was priced at is a stale figure, and nothing is charged on it.
   */
  private async reservedSlotTx(tx: BillingDb, before: Row): Promise<ReservedSlot> {
    const period = await this.billing.latestPeriod(before.companyId, tx);
    if (
      !period ||
      !before.replacementPeriodId ||
      !period.id.equals(before.replacementPeriodId) ||
      !periodRunning(period, this.clock.now())
    ) {
      throw NO_LONGER_APPLIES();
    }
    const archived = before.replacesBranchId
      ? await tx.branch.findFirst({
          where: { id: before.replacesBranchId, companyId: before.companyId },
          select: { id: true, name: true, activity: true, isActive: true, deletedAt: true },
        })
      : null;
    if (!archived || (archived.isActive && archived.deletedAt === null)) throw NO_LONGER_APPLIES();
    const taken = await tx.branchReplacement.findFirst({
      where: { billingPeriodId: period.id, archivedBranchId: archived.id },
      select: { id: true },
    });
    if (taken) throw NO_LONGER_APPLIES();
    return { periodId: period.id, prices: period, archived: { id: archived.id, name: archived.name, activity: archived.activity } };
  }

  /**
   * The period an activity upgrade was priced in against a replacement's credit, re-read at its confirmation under the
   * subscription lock (D158): it must still be the latest period and still running. The credit was that period's
   * alone — the next one bills the branch at its own fee with no credit — so after a roll the difference is a stale
   * figure: collecting it would leave the new period assessed the full difference while only part was paid.
   */
  private async creditPeriodTx(tx: BillingDb, before: Row): Promise<void> {
    const period = await this.billing.latestPeriod(before.companyId, tx);
    if (
      !period ||
      !before.replacementPeriodId ||
      !period.id.equals(before.replacementPeriodId) ||
      !periodRunning(period, this.clock.now())
    ) {
      throw CREDIT_NO_LONGER_APPLIES();
    }
  }

  /**
   * Write a replacement down, once (D158 B5, B6). A slot — the period and the archived branch — and a replacement
   * branch are each unique in `branch_replacements`, so a second replacement of one slot fails here, inside the
   * transaction that opened its store, and takes the store and any payment with it.
   */
  private async recordReplacementTx(tx: BillingDb, data: Prisma.BranchReplacementUncheckedCreateInput): Promise<void> {
    try {
      await tx.branchReplacement.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw NO_LONGER_APPLIES();
      throw e;
    }
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
