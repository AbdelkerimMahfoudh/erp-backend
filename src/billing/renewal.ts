import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { Clock } from '../entitlement/clock';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { periodRunning, type BillingDb, type BillingService } from './billing.service';

/**
 * The renewal (D154 a, refined 2026-10-09 after review): the moment the next
 * paid period begins — the later of the current period's end and the action
 * that pays for the next one.
 *
 * Two ways in, one routine:
 *
 *  - **now** — the Super Admin approves a business, grants it access, or
 *    extends or re-dates one whose period has already ended: the next period
 *    begins at this instant;
 *  - **when due** — the Super Admin extended a period that was still running
 *    (the Owner paid early). Nothing changes then; the roll is due at the old
 *    period's end, and the first time the company is evaluated after that
 *    instant it is applied, once. "Due" needs no scheduler and no column: the
 *    latest billing period has ended and the subscription's end lies beyond it.
 *
 * A roll applies every downgrade scheduled for it (`branches.activity_next`),
 * keeps what the ended period was assessed at, opens the next period at the
 * new size and prices, and says so in the timeline — all in one transaction
 * that locks the subscription row, so two requests arriving together roll once.
 */

export interface AppliedActivityChange {
  branchId: string;
  name: string;
  from: string;
  to: string;
}

export interface RenewalOutcome {
  /** The instant the new period begins. */
  at: string;
  /** Whether an earlier period existed (and, rolled now, was closed at `at`). */
  closedPeriod: boolean;
  activityChanges: AppliedActivityChange[];
}

/** Is a roll due: the latest period ended and the subscription runs beyond it? Pure, for the spec. */
export function rollDue(
  sub: { status: string; currentPeriodEnd: Date | null } | null,
  period: { periodEnd: Date | null } | null,
  now: Date,
): boolean {
  if (!sub || sub.status !== 'activated' || !period || !period.periodEnd || !sub.currentPeriodEnd) return false;
  return !periodRunning(period, now) && sub.currentPeriodEnd.getTime() > period.periodEnd.getTime();
}

export class SubscriptionRenewal {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly clock: Clock,
  ) {}

  /** Roll now: the next period begins at this instant. For the Super Admin's approval, grant, or a lapsed shop's renewal. */
  async rollNow(companyId: Buffer, subscriptionId: Buffer, periodEnd: Date | null, actor: string): Promise<RenewalOutcome> {
    const at = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, companyId);
      const activityChanges = await applyScheduledActivityChanges(tx, companyId, subscriptionId, at, actor);
      const closedPeriod = await this.billing.closeCurrentPeriod(companyId, at, tx);
      await this.billing.openPeriod(companyId, subscriptionId, periodEnd, { db: tx, startsAt: at });
      await tx.subscriptionEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          subscriptionId,
          kind: 'renewed',
          note: closedPeriod
            ? 'Renewed: the billing period closed and a new one opened at today\'s size and prices.'
            : 'First billing period opened at today\'s size and prices.',
          periodEndAfter: periodEnd,
          actor: actor.slice(0, 120),
        },
      });
      return { at: at.toISOString(), closedPeriod, activityChanges };
    });
  }

  /**
   * The roll due at the end of a prepaid period, applied once — or null when
   * nothing is due. Race-safe: the condition is re-read under the lock.
   */
  async rollIfDue(companyId: Buffer): Promise<RenewalOutcome | null> {
    const now = this.clock.now();
    // A cheap read first: the common case is "nothing due" and must not take a lock.
    const [sub, period] = await Promise.all([
      this.prisma.subscription.findFirst({ where: { companyId }, select: { id: true, status: true, currentPeriodEnd: true } }),
      this.billing.latestPeriod(companyId),
    ]);
    if (!rollDue(sub, period, now)) return null;

    return this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, companyId);
      const lockedSub = await tx.subscription.findFirst({ where: { companyId }, select: { id: true, status: true, currentPeriodEnd: true } });
      const lockedPeriod = await this.billing.latestPeriod(companyId, tx);
      if (!lockedSub || !lockedPeriod || !rollDue(lockedSub, lockedPeriod, now)) return null;
      // The new period begins where the prepaid one ended, not when somebody happened to look.
      const at = lockedPeriod.periodEnd as Date;
      const activityChanges = await applyScheduledActivityChanges(tx, companyId, lockedSub.id, at, 'system');
      await this.billing.openPeriod(companyId, lockedSub.id, lockedSub.currentPeriodEnd, { db: tx, startsAt: at });
      await tx.subscriptionEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          subscriptionId: lockedSub.id,
          kind: 'renewed',
          note: 'Renewed at the end of the prepaid period: the next billing period opened at its size and prices.',
          periodEndAfter: lockedSub.currentPeriodEnd,
          actor: 'system',
        },
      });
      return { at: at.toISOString(), closedPeriod: true, activityChanges };
    });
  }
}

/**
 * One renewal at a time per company: every roll takes the subscription row first. So do the store requests, the
 * activity requests and the payment confirmations (D158), so anything that prices the running period is decided
 * one at a time, against what the previous one committed — and always in the same order, subscription first.
 */
export async function lockSubscription(tx: BillingDb, companyId: Buffer): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM subscriptions WHERE company_id = ${companyId} FOR UPDATE`);
}

/**
 * Every downgrade waiting for this renewal, applied branch by branch: the
 * branch takes `activity_next`; the request that scheduled it is marked
 * applied (it stays `granted` — it cost nothing and it happened — with the
 * renewal's actor and instant on it); one `activity_changed` event per branch.
 */
async function applyScheduledActivityChanges(
  tx: BillingDb,
  companyId: Buffer,
  subscriptionId: Buffer,
  at: Date,
  actor: string,
): Promise<AppliedActivityChange[]> {
  const due = await tx.branch.findMany({
    where: { companyId, activityNext: { not: null } },
    select: { id: true, name: true, activity: true, activityNext: true },
    orderBy: { createdAt: 'asc' },
  });
  const applied: AppliedActivityChange[] = [];
  for (const b of due) {
    if (!b.activityNext) continue;
    await tx.branch.update({
      where: { id: b.id },
      data: { activity: b.activityNext, activityNext: null, activityChangedAt: at },
    });
    await tx.seatAllocation.updateMany({
      where: { companyId, kind: 'activity', branchId: b.id, status: 'granted', activityTo: b.activityNext, confirmedAt: null },
      data: { confirmedBy: actor.slice(0, 160), confirmedAt: at, reason: 'Applied at the renewal.', version: { increment: 1 } },
    });
    await tx.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId,
        kind: 'activity_changed',
        note: `Store "${b.name}": ${b.activity} → ${b.activityNext} at the renewal.`.slice(0, 255),
        actor: actor.slice(0, 120),
      },
    });
    applied.push({ branchId: binToUuid(b.id), name: b.name, from: b.activity, to: b.activityNext });
  }
  return applied;
}
