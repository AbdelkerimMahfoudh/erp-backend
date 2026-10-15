import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SubscriptionStatus, type TrialEligibilityClosedReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin, uuidToBin, binToUuid, isUuid } from '../common/utils/uuid.util';
import { PlatformAuditService } from './platform-audit.service';
import { BillingService, periodRunning } from '../billing/billing.service';
import { SubscriptionRenewal, lockSubscription, type RenewalOutcome } from '../billing/renewal';
import { CLOCK, type Clock } from '../entitlement/clock';
import { runningTrialEnd } from './trial/trial-rules';
import { TrialEndRoll } from './trial/trial-end-roll';
import type { PlatformAdminIdentity } from './platform-admin.service';

/**
 * The subscription lifecycle, driven by a platform administrator.
 *
 * **This does not compute money.** There is no plan price and no per-seat
 * charge anywhere on the server — Milestone K's canonical decision is that
 * there is one functional plan and entitlement is about *access*, not
 * invoicing. So nothing here totals anything, and no screen may either. A
 * recorded payment carries the amount a human typed, and that is the only
 * figure in the system.
 *
 * Two things are kept scrupulously apart:
 *
 *  - an **administrative grant** — we gave this shop access, for a reason, for
 *    a period. No money changed hands and the record says so.
 *  - a **payment** — a named person says they saw this money arrive.
 *
 * Collapsing them would let a test activation look, months later, exactly like
 * a shop that paid. That is the failure this whole design is arranged around.
 *
 * **A renewal is defined here** (D154 a, 2026-10-08): an approval, an
 * extension or a correction that moves the period end FORWARD applies every
 * downgrade scheduled for it, closes the current billing period and opens the
 * next at the shop's new size — see {@link SubscriptionLifecycleService.renew}.
 *
 * **The free trial's fence** (0095): every decision that makes a business
 * paid, granted, refused or cancelled closes its trial eligibility under the
 * subscription lock, and paid access given while the trial runs starts when
 * it ends — see {@link SubscriptionLifecycleService.fenced}. Suspension and
 * reinstatement close nothing. No action here writes a claim.
 */

export type LifecycleAction =
  | 'activate_grant'
  | 'approve'
  | 'reject'
  | 'set_period'
  | 'extend'
  | 'suspend'
  | 'reinstate'
  | 'cancel'
  | 'payment_recorded'
  | 'payment_confirmed';

/** The longest period one approval or correction may set. Sixty months, as `extend` allows. */
const MAX_PERIOD_MONTHS = 60;

/** Calendar months from an instant — the same arithmetic `extend` uses. */
function monthsFrom(from: Date, months: number): Date {
  const end = new Date(from);
  end.setMonth(end.getMonth() + months);
  return end;
}

/**
 * A note that keeps the fact the server adds, and the administrator's reason as far as it still fits: the column
 * holds 255 characters, and the fact is the part a reader must not lose.
 */
function noteWith(reason: string | undefined, fact: string | null): string | null {
  if (!fact) return reason?.slice(0, 255) ?? null;
  const lead = reason?.trim().slice(0, Math.max(0, 255 - fact.length - 1)) ?? '';
  return lead ? `${lead} ${fact}` : fact;
}

/** A period that would end inside the free trial it waits for: refused, with the end it must pass. */
function endsBeforeTrial(trialEndsAt: Date): BadRequestException {
  return new BadRequestException({
    code: 'period_ends_before_trial_end',
    message: `The end date must be after the free trial ends on ${trialEndsAt.toISOString()}.`,
  });
}

interface ActorContext {
  admin: PlatformAdminIdentity;
  ip?: string | null;
}

/** What the trial fence found under the lock: its instant, and the end of a free trial still running then. */
interface TrialFence {
  now: Date;
  trialEndsAt: Date | null;
}

@Injectable()
export class SubscriptionLifecycleService {
  /** The one renewal routine, shared with the lazy roll the entitlement check applies (billing/renewal.ts). */
  private readonly renewal: SubscriptionRenewal;
  /**
   * What a free trial's end owes the business (D176): run after every decision that gives it a period or lets it
   * act again, so what was paid for during the trial is put in force as soon as a paid period is (never waiting).
   */
  private readonly trialEnd: TrialEndRoll;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly billing: BillingService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.renewal = new SubscriptionRenewal(prisma, billing, clock);
    this.trialEnd = new TrialEndRoll(prisma, clock);
  }

  /**
   * Whether the latest billing period is a paid month still running (D154,
   * reviewed 2026-10-09). While it runs, extending or re-dating the
   * subscription moves its end and nothing else: the renewal is due at the
   * period's end, so a downgrade never takes away an activity the shop has
   * paid for before its month is over.
   */
  private async periodStillRunning(companyId: Buffer): Promise<boolean> {
    return periodRunning(await this.billing.latestPeriod(companyId), this.clock.now());
  }

  private companyIdOf(companyId: string): Buffer {
    if (!isUuid(companyId)) throw new BadRequestException('Unknown business');
    return uuidToBin(companyId);
  }

  private async loadOrThrow(id: Buffer) {
    const sub = await this.prisma.subscription.findFirst({
      where: { companyId: id },
      include: { company: { select: { name: true, publicStoreId: true } } },
    });
    if (!sub) throw new NotFoundException('Unknown business');
    return sub;
  }

  /** The shape written into the audit trail. Never anything secret. */
  private snapshot(sub: {
    status: SubscriptionStatus;
    currentPeriodEnd: Date | null;
    isComplimentary: boolean;
    complimentaryUntil: Date | null;
    subscribedBranchCount: number;
    additionalSeats: number;
    version: number;
  }) {
    return {
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      isComplimentary: sub.isComplimentary,
      complimentaryUntil: sub.complimentaryUntil?.toISOString() ?? null,
      subscribedBranchCount: sub.subscribedBranchCount,
      additionalSeats: sub.additionalSeats,
      version: sub.version,
    };
  }

  /**
   * Apply one transition, exactly once.
   *
   * Optimistic concurrency on `version`: two administrators activating the same
   * pending business at the same moment produce one winner and one
   * `ConflictException`, and the loser is told to refresh rather than silently
   * applying the transition twice. The alternative — last write wins — would
   * double an extension without anybody noticing.
   *
   * `expectedVersion` is optional so an idempotent retry from the same
   * administrator can be recognised by its outcome instead: if the subscription
   * already looks exactly as this call would leave it, the call is a no-op that
   * returns the winning state. That is what makes a network retry safe.
   */
  private async transition<T extends Record<string, unknown>>(
    companyId: Buffer,
    expectedVersion: number | undefined,
    data: T,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const where: Prisma.SubscriptionWhereUniqueInput & { version?: number } = {
      companyId,
    } as never;

    try {
      return await db.subscription.update({
        where:
          expectedVersion === undefined
            ? ({ companyId } as never)
            : ({ companyId, version: expectedVersion } as never),
        data: { ...data, version: { increment: 1 } } as never,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new ConflictException({
          code: 'subscription_changed',
          message: 'Somebody else changed this subscription. Refresh and try again.',
        });
      }
      throw e;
    }
    void where;
  }

  /**
   * The free trial's fence (0095), and the decision it guards, in one transaction under the subscription lock.
   *
   * The fence closes the trial eligibility — NULL → value, once, with the decision's reason — and reads the claim:
   * a trial still running is when paid access starts, never sooner (the owner's decision of 2026-10-13: the trial is
   * not shortened and nothing paid runs beside it). Closing under the lock serialises with a claim, which re-checks
   * the eligibility under the same lock: once fenced, no trial can start, and one that started first is the one
   * read here.
   *
   * `decide` runs in the same transaction — the trial-dependent checks, then the version-guarded transition — so a
   * refusal (a stale `expectedVersion`, a period that would end inside the trial) leaves the eligibility untouched.
   */
  private async fenced<R>(
    companyId: Buffer,
    reason: TrialEligibilityClosedReason,
    decide: (tx: Prisma.TransactionClient, fence: TrialFence) => Promise<R>,
  ): Promise<R> {
    return this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, companyId);
      const now = this.clock.now();
      await tx.trialEligibility.updateMany({
        where: { companyId, closedAt: null },
        data: { closedAt: now, closedReason: reason },
      });
      const claim = await tx.trialClaim.findUnique({ where: { companyId }, select: { endsAt: true } });
      return decide(tx, { now, trialEndsAt: runningTrialEnd(claim, now) });
    });
  }

  /**
   * Activate a pending (or lapsed) business as an **administrative grant**.
   *
   * This is the manual testing path, and it is recorded honestly: no payment
   * row is created, `isComplimentary` is set, and the reason and duration are
   * written into both the subscription-event trail and the platform audit log.
   * Nothing anywhere claims a provider confirmed anything, because none did.
   */
  async activateByGrant(
    companyId: string,
    input: { days: number; reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 3650) {
      throw new BadRequestException('Give a duration between 1 and 3650 days.');
    }
    if (!input.reason?.trim()) {
      throw new BadRequestException('A grant needs a reason — it is the whole record.');
    }

    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    /*
     * Fenced (0095): a grant closes the trial eligibility, and a grant given
     * while the trial runs starts when it ends — its days are counted from
     * there, never spent inside the trial.
     */
    const granted = await this.fenced(id, 'granted', async (tx, { now, trialEndsAt }) => {
      const from = trialEndsAt ?? now;
      const until = new Date(from.getTime() + input.days * 24 * 60 * 60 * 1000);

      /*
       * Idempotent retry.
       *
       * If this business is already granted, already activated, and the grant
       * runs to about the same moment, the call has already happened — almost
       * certainly a retry after a dropped response. Return the winning state
       * rather than stacking a second grant on top. Judged on the row read
       * under the lock (D176 §9): two grants at once see each other.
       */
      const locked = await tx.subscription.findFirst({
        where: { companyId: id },
        select: { status: true, isComplimentary: true, complimentaryUntil: true },
      });
      const alreadyDone =
        locked?.status === 'activated' &&
        locked.isComplimentary &&
        locked.complimentaryUntil !== null &&
        Math.abs(locked.complimentaryUntil.getTime() - until.getTime()) < 60_000;
      if (alreadyDone) return null;

      const after = await this.transition(
        id,
        input.expectedVersion,
        {
          status: 'activated' as SubscriptionStatus,
          isComplimentary: true,
          complimentaryReason: input.reason.slice(0, 255),
          complimentaryUntil: until,
        },
        tx,
      );
      return { after, from, trialEndsAt };
    });

    if (!granted) {
      return { subscription: before, applied: false };
    }
    const { after, from, trialEndsAt } = granted;

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        // The kind says what it was. Nobody reading this later can mistake a
        // grant for money that arrived.
        kind: 'administrative_grant',
        note: input.reason.slice(0, 255),
        periodEndAfter: after.currentPeriodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.activate_grant',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason,
      before: this.snapshot(before),
      after: {
        ...this.snapshot(after),
        grantDays: input.days,
        grantFrom: from.toISOString(),
        trialEndsAt: trialEndsAt?.toISOString() ?? null,
        paymentRecorded: false,
      },
      ip: ctx.ip ?? null,
    });

    /*
     * A grant is a renewal (D154, reviewed 2026-10-09): the period running now
     * closes at this instant, the downgrades scheduled for it apply, and the
     * grant's period opens at today's size and prices — never a second period
     * overlapping the first. Done here rather than at registration: a pending
     * business has never been billed, and a period snapshot for one would be a
     * billing history it does not have. During a free trial, "this instant" is
     * the trial's end (0095).
     */
    await this.renewal.rollNow(id, before.id, after.complimentaryUntil, ctx.admin.email, from);
    // What was paid for during an ended trial joins the grant's period now (D176); during the trial, nothing is due.
    await this.trialEnd.applyIfDue(id);

    return { subscription: after, applied: true };
  }

  /**
   * Approve a pending registration: it becomes a running subscription with a
   * paid period that ends on a date the administrator chose.
   *
   * Distinct from a grant on purpose. A grant is "we gave this shop access,
   * for a reason, for a while" and sets the complimentary fields; an approval
   * is "this shop is a customer from today", sets the paid period, and opens
   * the billing period that freezes today's prices. Months later the two must
   * still read differently.
   *
   * A refused registration may be approved after all — the decision was
   * recorded, and so is its reversal. A suspended or cancelled business is
   * not pending and is refused here; reinstatement is its own audited act.
   *
   * Approved while the free trial runs (0095), paid access starts when the
   * trial ends: the months are counted from there, an exact end date must lie
   * beyond it, and the first billing period opens there.
   */
  async approve(
    companyId: string,
    input: { months?: number; periodEnd?: Date; reason?: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    const hasMonths = input.months !== undefined;
    const hasEnd = input.periodEnd !== undefined;
    if (hasMonths === hasEnd) {
      throw new BadRequestException('Say how long: a number of months, or an end date — one of the two.');
    }
    if (hasMonths && (!Number.isInteger(input.months) || input.months! < 1 || input.months! > MAX_PERIOD_MONTHS)) {
      throw new BadRequestException(`Approve for between 1 and ${MAX_PERIOD_MONTHS} months.`);
    }
    if (hasEnd && (Number.isNaN(input.periodEnd!.getTime()) || input.periodEnd!.getTime() <= this.clock.now().getTime())) {
      throw new BadRequestException('The end date must be in the future.');
    }

    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    // A retry after a dropped response: already approved, nothing to redo.
    if (before.status === 'activated') return { subscription: before, applied: false };
    if (before.status !== 'pending_activation' && before.status !== 'rejected') {
      throw new BadRequestException(
        'Only a pending or refused registration can be approved. Reinstate a suspended business instead.',
      );
    }

    const approved = await this.fenced(id, 'approved', async (tx, { now, trialEndsAt }) => {
      // Decided again under the lock (D176 §9): two approvals at once — neither naming a version — make one
      // transition, one first period and one assessment; the second answers as the retry it is.
      const locked = await tx.subscription.findFirst({ where: { companyId: id }, select: { status: true } });
      if (locked?.status === 'activated') return null;
      if (locked?.status !== 'pending_activation' && locked?.status !== 'rejected') {
        throw new BadRequestException(
          'Only a pending or refused registration can be approved. Reinstate a suspended business instead.',
        );
      }
      if (hasEnd && trialEndsAt && input.periodEnd!.getTime() <= trialEndsAt.getTime()) throw endsBeforeTrial(trialEndsAt);
      const paidFrom = trialEndsAt ?? now;
      const end = hasEnd ? new Date(input.periodEnd!) : monthsFrom(paidFrom, input.months!);
      const after = await this.transition(
        id,
        input.expectedVersion,
        { status: 'activated' as SubscriptionStatus, currentPeriodEnd: end },
        tx,
      );
      return { after, now, paidFrom, trialEndsAt, end };
    });
    if (!approved) return { subscription: before, applied: false };
    const { after, now, paidFrom, trialEndsAt, end } = approved;

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'approved',
        // When it starts is data — the period's start, the trial's end — never an instant in the note (C7).
        note: noteWith(input.reason, trialEndsAt ? 'Paid access starts when the free trial ends.' : null),
        periodEndAfter: end,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    // The first billing period, at today's prices — see `activateByGrant`.
    // Through the renewal routine, so a refused-then-approved shop that
    // scheduled a downgrade meanwhile starts at the size it asked for. It
    // opens where paid access starts: now, or at the free trial's end.
    const renewal = await this.renewal.rollNow(id, before.id, end, ctx.admin.email, paidFrom);

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.approve',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason ?? null,
      before: this.snapshot(before),
      after: {
        ...this.snapshot(after),
        ...(hasMonths ? { months: input.months } : {}),
        approvedAt: now.toISOString(),
        paidFrom: paidFrom.toISOString(),
        trialEndsAt: trialEndsAt?.toISOString() ?? null,
        paymentRecorded: false,
        renewal,
      },
      ip: ctx.ip ?? null,
    });
    // What was paid for during an ended trial joins the first period now (D176); during the trial, nothing is due.
    await this.trialEnd.applyIfDue(id);

    return { subscription: after, applied: true };
  }

  /**
   * Refuse a pending registration, with a reason.
   *
   * Its own status rather than `cancelled`: a shop that was told "no" was
   * never a customer, and the record must not read as one that ended. Nothing
   * is deleted — the company, its Owner and the attempt all stay, and the
   * refusal can be reversed by approving.
   */
  async reject(
    companyId: string,
    input: { reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (!input.reason?.trim()) throw new BadRequestException('A refusal needs a reason.');

    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    if (before.status === 'rejected') return { subscription: before, applied: false };
    if (before.status !== 'pending_activation') {
      throw new BadRequestException(
        'Only a pending registration can be refused. Suspend or cancel a running business instead.',
      );
    }

    // Fenced (0095): a refused business can never start the free trial — approving it later does not reopen it.
    const after = await this.fenced(id, 'refused', (tx) =>
      this.transition(id, input.expectedVersion, { status: 'rejected' as SubscriptionStatus }, tx),
    );

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'rejected',
        note: input.reason.slice(0, 255),
        periodEndAfter: after.currentPeriodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.reject',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason,
      before: this.snapshot(before),
      after: this.snapshot(after),
      ip: ctx.ip ?? null,
    });

    return { subscription: after, applied: true };
  }

  /**
   * Set the period end directly — a correction, recorded as one.
   *
   * `extend` adds whole months and says "extended". This says exactly what
   * date was set and why, which is what a mistyped approval or a negotiated
   * settlement needs. Shortening a period takes money-worth of access away
   * from a shop, so it needs a reason; lengthening does not.
   *
   * Grace is not set here and cannot be: it is always the seventy-two hours
   * after this date, derived and never stored, so a corrected period carries
   * its grace with it.
   *
   * While a free trial still runs (0095) — a business suspended during it and
   * reinstated keeps its clock — the end must lie beyond the trial's, and a
   * new period starts at the trial's end.
   */
  async setPeriodEnd(
    companyId: string,
    input: { periodEnd: Date; reason?: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (Number.isNaN(input.periodEnd.getTime())) throw new BadRequestException('Give a real date.');
    if (input.periodEnd.getTime() > monthsFrom(this.clock.now(), MAX_PERIOD_MONTHS).getTime()) {
      throw new BadRequestException(`A period may run at most ${MAX_PERIOD_MONTHS} months from today.`);
    }

    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    if (before.status !== 'activated') {
      throw new BadRequestException(
        'Only a running business has a period to correct. Approve or reinstate it first.',
      );
    }

    const current = before.currentPeriodEnd?.getTime() ?? null;
    if (current !== null && current === input.periodEnd.getTime()) {
      return { subscription: before, applied: false };
    }
    const shortened = current !== null && input.periodEnd.getTime() < current;
    if (shortened && !input.reason?.trim()) {
      throw new BadRequestException('Shortening a period needs a reason.');
    }

    // Fenced like every decision that makes a business paid; a no-op once its approval closed the eligibility.
    const { after, now, trialEndsAt } = await this.fenced(id, 'paid_period', async (tx, { now, trialEndsAt }) => {
      if (trialEndsAt && input.periodEnd.getTime() <= trialEndsAt.getTime()) throw endsBeforeTrial(trialEndsAt);
      const after = await this.transition(id, input.expectedVersion, { currentPeriodEnd: input.periodEnd }, tx);
      return { after, now, trialEndsAt };
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'period_corrected',
        note: input.reason?.slice(0, 255) ?? null,
        periodEndAfter: input.periodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    /*
     * A correction re-dates the period it corrects (D154, reviewed 2026-10-09):
     * while a paid month runs, its billing period ends where the subscription
     * now ends, and nothing renews — fixing a typo must not open a one-day
     * period or apply a downgrade early. A business whose period had already
     * ended and is given a new end in the future starts a new period now.
     */
    const running = await this.periodStillRunning(id);
    let renewal: RenewalOutcome | null = null;
    if (running) {
      await this.billing.redateRunningPeriod(id, input.periodEnd);
    } else if (!shortened && input.periodEnd.getTime() > now.getTime()) {
      renewal = await this.renewal.rollNow(id, before.id, input.periodEnd, ctx.admin.email, trialEndsAt ?? now);
    }

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.set_period',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason ?? null,
      before: this.snapshot(before),
      after: { ...this.snapshot(after), direction: shortened ? 'shortened' : 'lengthened', redated: running, renewal },
      ip: ctx.ip ?? null,
    });
    // A new period may now be in force for what was paid for during an ended trial (D176).
    await this.trialEnd.applyIfDue(id);

    return { subscription: after, applied: true };
  }

  /**
   * Extend a paid period. Never touches the grant fields.
   *
   * A renewal (D154 a) begins when the next paid period does: at once for a
   * business whose period has ended, at the old end for one still running —
   * the Owner who pays November on the 20th of October keeps October's
   * activities until the 31st, and the roll is applied then (billing/renewal.ts).
   * During a free trial (0095), "at once" is the trial's end.
   */
  async extend(
    companyId: string,
    input: { months: number; reason?: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (!Number.isInteger(input.months) || input.months < 1 || input.months > 60) {
      throw new BadRequestException('Extend by between 1 and 60 months.');
    }

    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    // Fenced (0095): an extension makes the business paid, so no trial can start after it.
    const { after, end, accessFrom, trialEndsAt } = await this.fenced(id, 'paid_period', async (tx, { now, trialEndsAt }) => {
      const accessFrom = trialEndsAt ?? now;
      // From the later of the current end and the moment access may start, so
      // extending a lapsed subscription does not silently backdate the new
      // period into the past — nor start one inside a running free trial.
      const from =
        before.currentPeriodEnd && before.currentPeriodEnd.getTime() > accessFrom.getTime()
          ? before.currentPeriodEnd
          : accessFrom;
      const end = monthsFrom(from, input.months);
      const after = await this.transition(
        id,
        input.expectedVersion,
        { status: 'activated' as SubscriptionStatus, currentPeriodEnd: end },
        tx,
      );
      return { after, end, accessFrom, trialEndsAt };
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'extended',
        note: input.reason?.slice(0, 255) ?? null,
        periodEndAfter: end,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    const renewal = (await this.periodStillRunning(id))
      ? null
      : await this.renewal.rollNow(id, before.id, end, ctx.admin.email, accessFrom);

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.extend',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason ?? null,
      before: this.snapshot(before),
      after: {
        ...this.snapshot(after),
        months: input.months,
        renewal,
        renewalDueAt: renewal ? null : before.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: trialEndsAt?.toISOString() ?? null,
      },
      ip: ctx.ip ?? null,
    });
    // A new period may now be in force for what was paid for during an ended trial (D176).
    await this.trialEnd.applyIfDue(id);

    return { subscription: after, applied: true };
  }

  /** Stop a business, with a reason. High impact — the controller steps up first. */
  async suspend(
    companyId: string,
    input: { reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (!input.reason?.trim()) {
      throw new BadRequestException('A suspension needs a reason.');
    }
    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    if (before.status === 'suspended') {
      return { subscription: before, applied: false };
    }

    const after = await this.transition(id, input.expectedVersion, {
      status: 'suspended' as SubscriptionStatus,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'suspended',
        note: input.reason.slice(0, 255),
        periodEndAfter: after.currentPeriodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.suspend',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason,
      before: this.snapshot(before),
      after: this.snapshot(after),
      ip: ctx.ip ?? null,
    });

    return { subscription: after, applied: true };
  }

  /**
   * Undo a suspension. The dates decide again from here — and so does a free
   * trial's own end (0095): a business suspended during its trial resumes the
   * same trial, never a longer one. Nothing about the trial is touched.
   */
  async reinstate(
    companyId: string,
    input: { reason?: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);

    if (before.status !== 'suspended') {
      return { subscription: before, applied: false };
    }

    const after = await this.transition(id, input.expectedVersion, {
      status: 'activated' as SubscriptionStatus,
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'reinstated',
        note: input.reason?.slice(0, 255) ?? null,
        periodEndAfter: after.currentPeriodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.reinstate',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason ?? null,
      before: this.snapshot(before),
      after: this.snapshot(after),
      ip: ctx.ip ?? null,
    });
    // Anything still due from an ended trial is brought up to date (D176); what was due while suspended already ran.
    await this.trialEnd.applyIfDue(id);

    return { subscription: after, applied: true };
  }

  /** End it. Nothing is deleted — the history is the point. */
  async cancel(
    companyId: string,
    input: { reason: string; expectedVersion?: number },
    ctx: ActorContext,
  ) {
    if (!input.reason?.trim()) throw new BadRequestException('A cancellation needs a reason.');

    const id = this.companyIdOf(companyId);
    const before = await this.loadOrThrow(id);
    if (before.status === 'cancelled') return { subscription: before, applied: false };

    // Fenced (0095): a cancelled business can never start the free trial.
    const after = await this.fenced(id, 'cancelled', (tx) =>
      this.transition(id, input.expectedVersion, { status: 'cancelled' as SubscriptionStatus }, tx),
    );

    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: before.id,
        kind: 'cancelled',
        note: input.reason.slice(0, 255),
        periodEndAfter: after.currentPeriodEnd,
        branchesAfter: after.subscribedBranchCount,
        seatsAfter: after.additionalSeats,
        actor: ctx.admin.email,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: 'subscription.cancel',
      targetType: 'Company',
      targetId: id,
      targetLabel: before.company.name,
      reason: input.reason,
      before: this.snapshot(before),
      after: this.snapshot(after),
      ip: ctx.ip ?? null,
    });

    return { subscription: after, applied: true };
  }

  /**
   * Record money that actually arrived.
   *
   * Separate from activation on purpose: recording a payment does not extend
   * anything by itself. An administrator records what they saw, then extends
   * the period as a distinct, separately audited act. Bundling them would mean
   * a mistyped amount silently moved an expiry date.
   *
   * **No provider is contacted.** `confirmedBy` means "this named person says
   * the money is real".
   */
  async recordPayment(
    companyId: string,
    input: {
      amount: string;
      paidAt: Date;
      channel?: 'manual' | 'bank_transfer' | 'mobile_money';
      reference?: string;
      note?: string;
      confirm?: boolean;
    },
    ctx: ActorContext,
  ) {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter the amount that was actually paid.');
    }

    const id = this.companyIdOf(companyId);
    const sub = await this.loadOrThrow(id);

    const payment = await this.prisma.subscriptionPayment.create({
      data: {
        id: newUuidV7Bin(),
        companyId: id,
        subscriptionId: sub.id,
        amount: new Prisma.Decimal(input.amount),
        currency: 'MRU',
        paidAt: input.paidAt,
        channel: input.channel ?? 'manual',
        reference: input.reference?.slice(0, 120) ?? null,
        note: input.note?.slice(0, 500) ?? null,
        recordedBy: ctx.admin.email,
        confirmedBy: input.confirm ? ctx.admin.email : null,
        confirmedAt: input.confirm ? this.clock.now() : null,
      },
    });

    await this.audit.record({
      admin: ctx.admin,
      action: input.confirm ? 'payment.record_and_confirm' : 'payment.record',
      targetType: 'Company',
      targetId: id,
      targetLabel: sub.company.name,
      reason: input.note ?? null,
      after: {
        paymentId: binToUuid(payment.id),
        amount: input.amount,
        currency: 'MRU',
        channel: payment.channel,
        reference: payment.reference,
        // Said explicitly, so nobody reading the log later infers otherwise.
        providerVerified: false,
      },
      ip: ctx.ip ?? null,
    });

    return payment;
  }

  /** The complete, ordered story of one subscription. */
  async timeline(companyId: string) {
    const id = this.companyIdOf(companyId);
    await this.loadOrThrow(id);

    const [events, payments] = await Promise.all([
      this.prisma.subscriptionEvent.findMany({
        where: { companyId: id },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.subscriptionPayment.findMany({
        where: { companyId: id },
        orderBy: { paidAt: 'desc' },
        take: 200,
      }),
    ]);

    return {
      events: events.map((e) => ({
        id: binToUuid(e.id),
        kind: e.kind,
        note: e.note,
        actor: e.actor,
        periodEndAfter: e.periodEndAfter?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
      /** Kept in its own list, so a grant can never be read as money. */
      payments: payments.map((p) => ({
        id: binToUuid(p.id),
        amount: p.amount.toString(),
        currency: p.currency,
        channel: p.channel,
        reference: p.reference,
        note: p.note,
        paidAt: p.paidAt.toISOString(),
        recordedBy: p.recordedBy,
        confirmedBy: p.confirmedBy,
        confirmedAt: p.confirmedAt?.toISOString() ?? null,
        providerVerified: false,
      })),
    };
  }
}
