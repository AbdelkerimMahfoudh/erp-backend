import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Clock } from '../../entitlement/clock';
import { BillingService, periodInForce, type BillingDb } from '../../billing/billing.service';
import { lockSubscriptionNowait } from '../../billing/renewal';
import { isLockBusy } from '../../common/db/deadlock-retry';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import { redact } from '../platform-audit.service';
import { openStoreTx } from '../store-opening';
import { activateIfReadyTx, scheduledCoverage, type ActivationDb } from '../staff-activation-rules';
import { TRIAL_DURATION_DAYS } from './trial-rules';

/**
 * What happens when a free trial ends (0095; D176): the record that it did, and what was paid for during it put in
 * force.
 *
 * The end itself needs neither: the state is computed from the stored instants, so access changes at `ends_at`
 * exactly. Two things are written down after it, each in its own transaction:
 *
 *  - **Tx A, the expiry record** — the claim marked, a `trial_expired` event and a platform audit, once
 *    (`expiry_recorded_at IS NULL` guards it).
 *  - **Tx B, the activation** — every request paid for during the trial (`scheduled`) whose start has come, put in
 *    force once a paid period is in force in an open company: the store opened, the seat counted, that period raised
 *    by exactly that request, the people it was for activated. A failure here never undoes or re-queues Tx A.
 *
 * Both take the subscription row with `FOR UPDATE NOWAIT` (R1-F2): when another writer holds it, the attempt returns
 * at once as `busy` and a later evaluation, an administrator's action or the sweeper finishes the work — a request
 * never waits on it, and never fails because of it. Both read their instant after the lock.
 *
 * Constructed by hand, as `SubscriptionRenewal` is: the entitlement check (global module), the seat requests, the
 * staff activation, the lifecycle and the sweeper each hold one. The in-process guards of the lazy path
 * ({@link TrialEndRoll.onEvaluation}) belong to the instance; the row guards and the lock make any two instances safe.
 */

/** The claim as its end needs it: which row, when it ends, and whether its end was written down. */
export interface TrialClaimRow {
  id: Buffer;
  endsAt: Date;
  expiryRecordedAt: Date | null;
}

export type TrialEndOutcome = 'busy' | 'nothing_due' | 'done' | 'failed';

/** Explicit bounds for both transactions: a connection within 2 s, the whole work within 10 s. */
const TX_OPTIONS = { maxWait: 2_000, timeout: 10_000 } as const;
/** After `busy`: somebody holds the row and is about to finish; look again a second later. */
const BUSY_BACKOFF_MS = 1_000;
/** After an error: 1 s, doubling, at most a minute — never a request held up by a failing record. */
const ERROR_BACKOFF_BASE_MS = 1_000;
const ERROR_BACKOFF_CAP_MS = 60_000;
/** The lazy path asks "is anything due?" at most once a minute per company. */
const DUE_CHECK_TTL_MS = 60_000;

/** Why a paid store could not open, said once on the request. */
const nameTaken = (name: string): string =>
  `A store named "${name}" already exists, so this store paid for during the free trial cannot open under that name. The Super Admin must settle it.`.slice(
    0,
    500,
  );

/** The instants of a request in force: never earlier than the period it joined. */
const later = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);

/**
 * Tx A's body (moved unchanged from the entitlement service): mark the claim, append the `trial_expired` event and the
 * platform audit — all three or none, in the caller's transaction, which holds the subscription row. True when this
 * call marked it.
 *
 * The audit row goes through the transaction with `redact()` rather than `PlatformAuditService`: that service writes
 * outside any transaction, and the platform module imports the global entitlement module — importing it back would
 * be a cycle.
 */
export async function recordTrialExpiryTx(
  tx: BillingDb,
  companyId: Buffer,
  subscriptionId: Buffer,
  label: string,
  claimId: Buffer,
  claimEndsAt: Date,
  now: Date,
): Promise<boolean> {
  const endsAt = claimEndsAt.toISOString();
  const marked = await tx.trialClaim.updateMany({
    where: { id: claimId, expiryRecordedAt: null },
    data: { expiryRecordedAt: now },
  });
  if (marked.count !== 1) return false;
  await tx.subscriptionEvent.create({
    data: {
      id: newUuidV7Bin(),
      companyId,
      subscriptionId,
      kind: 'trial_expired',
      note: `The ${TRIAL_DURATION_DAYS}-day free trial ended at ${endsAt}. Nothing was charged.`,
      actor: 'system',
      createdAt: now,
    },
  });
  await tx.platformAuditEvent.create({
    data: {
      id: newUuidV7Bin(),
      adminId: null,
      actor: 'system',
      action: 'trial.expired',
      targetType: 'Company',
      targetId: companyId,
      targetLabel: label.slice(0, 200),
      afterJson: redact({ endsAt }) as Prisma.InputJsonValue,
      createdAt: now,
    },
  });
  return true;
}

/** What Tx B did. */
export interface AddOnActivation {
  /** The requests put in force, in order. */
  activated: string[];
  /** Stores that could not open under their name, flagged now (each is flagged once). */
  blocked: string[];
}

/**
 * Tx B's body: put in force every scheduled request whose start has come (D176 §6). The caller holds the subscription
 * row and read `now` after taking it.
 *
 * Nothing happens unless the company is open (`closed_at` NULL) and a paid period is in force at `now` — whatever its
 * status: a suspended or cancelled business still has the period it paid for, which starts on time (PQ3). Then, row
 * by row, in the order the requests start (then were asked, then by id):
 *
 *  - a store whose name is taken now is skipped, and flagged once — never thrown;
 *  - the guarded move `scheduled → paid` (company, status, version, start) must change exactly one row, or the row
 *    is left to whoever moved it;
 *  - its start becomes the instant it took effect: the trial's end, or the start of the period it joined if that is
 *    later (paid access approved after the trial ended);
 *  - a store opens exactly as every store does (`openStoreTx`) and the request names it; a seat is said on the
 *    timeline;
 *  - the period is assessed for the company as it now is — raised by exactly this request, at its own copied
 *    prices; a re-run adds nothing (the assessment keeps a high-water mark per branch and per component);
 *  - one platform audit row says what was paid, what was quoted and what the period was raised by.
 *
 * Then the people: each activated seat's own person, and at each store that gained a seat nobody holds, the pending
 * people it was bought for, first invited first. Activation only — nobody's request is created here.
 */
export async function activateDueAddOnsTx(
  tx: BillingDb,
  billing: BillingService,
  companyId: Buffer,
  now: Date,
  actor: string,
): Promise<AddOnActivation> {
  const done: AddOnActivation = { activated: [], blocked: [] };
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { name: true, closedAt: true } });
  if (!company || company.closedAt !== null) return done;
  const period = await billing.latestPeriod(companyId, tx);
  if (!period || !periodInForce(period, now)) return done;
  const sub = await tx.subscription.findFirst({ where: { companyId }, select: { id: true } });
  if (!sub) return done;

  const due = await tx.seatAllocation.findMany({
    where: { companyId, status: 'scheduled', effectiveAt: { lte: now } },
    include: {
      branch: { select: { id: true, name: true } },
      user: { select: { id: true, name: true, activatedAt: true, deletedAt: true } },
      payment: { select: { id: true, amount: true, reference: true } },
    },
    orderBy: [{ effectiveAt: 'asc' }, { requestedAt: 'asc' }, { id: 'asc' }],
  });
  if (due.length === 0) return done;

  const db = tx as unknown as ActivationDb;
  // A seat nobody pending holds is capacity for the people waiting at its store: who they are is read before the
  // seat is counted, in the order they were invited.
  const waiting = new Map<string, Buffer[]>();
  for (const row of due) {
    const unreserved = row.kind === 'seat' && row.branchId && (!row.user || row.user.activatedAt !== null || row.user.deletedAt !== null);
    if (!unreserved || !row.branchId) continue;
    const key = binToUuid(row.branchId);
    if (!waiting.has(key)) waiting.set(key, (await scheduledCoverage(db, companyId, row.branchId)).candidates);
  }

  const owners: Buffer[] = [];
  const gained = new Set<string>();
  for (const row of due) {
    const requestId = binToUuid(row.id);
    const reference = row.payment?.reference ?? 'no reference';
    const name = row.label ?? 'New store';
    if (row.kind === 'store') {
      const clash = await tx.branch.findFirst({ where: { companyId, name }, select: { id: true } });
      if (clash) {
        if (row.reason !== nameTaken(name)) {
          await tx.seatAllocation.updateMany({ where: { id: row.id, status: 'scheduled' }, data: { reason: nameTaken(name) } });
          await tx.platformAuditEvent.create({
            data: {
              id: newUuidV7Bin(),
              adminId: null,
              actor: actor.slice(0, 160),
              action: 'store.activation_blocked',
              targetType: 'Company',
              targetId: companyId,
              targetLabel: company.name.slice(0, 200),
              afterJson: redact({ requestId, store: name, paymentId: row.paymentId ? binToUuid(row.paymentId) : null }) as Prisma.InputJsonValue,
              createdAt: now,
            },
          });
          done.blocked.push(requestId);
        }
        continue;
      }
    }

    const effectiveAt = later(row.effectiveAt as Date, period.periodStart);
    const moved = await tx.seatAllocation.updateMany({
      where: { id: row.id, companyId, status: 'scheduled', version: row.version, effectiveAt: { lte: now } },
      data: { status: 'paid', effectiveAt, version: { increment: 1 } },
    });
    if (moved.count !== 1) continue;

    const before = await tx.billingPeriod.findUnique({ where: { id: period.id }, select: { assessedTotal: true } });
    if (row.kind === 'store') {
      const activity = row.activityTo ?? 'electronics';
      const branchId = await openStoreTx(tx, {
        companyId,
        subscriptionId: sub.id,
        name,
        activity,
        actor,
        note: `Store "${name}" (${activity}) opened with its first paid period: paid for during the free trial, payment ${reference}.`,
      });
      await tx.seatAllocation.updateMany({ where: { id: row.id, branchId: null }, data: { branchId } });
    } else {
      const held = await tx.seatAllocation.count({ where: { companyId, kind: 'seat', status: { in: ['paid', 'granted'] } } });
      const counted = await tx.subscription.findFirst({ where: { companyId }, select: { subscribedBranchCount: true } });
      await tx.subscriptionEvent.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          subscriptionId: sub.id,
          kind: 'seats_changed',
          note: `Seat at ${row.branch?.name ?? 'a store'}${row.user ? ` for ${row.user.name}` : ''} in force with its first paid period: paid for during the free trial, payment ${reference}.`.slice(
            0,
            255,
          ),
          branchesAfter: counted?.subscribedBranchCount ?? null,
          seatsAfter: held,
          actor: actor.slice(0, 120),
          createdAt: now,
        },
      });
      if (row.user && row.user.activatedAt === null && row.user.deletedAt === null) owners.push(row.user.id);
      else if (row.branchId) gained.add(binToUuid(row.branchId));
    }
    await billing.assessNow(companyId, tx, now);
    const after = await tx.billingPeriod.findUnique({ where: { id: period.id }, select: { assessedTotal: true } });

    await tx.platformAuditEvent.create({
      data: {
        id: newUuidV7Bin(),
        adminId: null,
        actor: actor.slice(0, 160),
        action: row.kind === 'store' ? 'store.activate' : 'seat.activate',
        targetType: 'Company',
        targetId: companyId,
        targetLabel: company.name.slice(0, 200),
        afterJson: redact({
          requestId,
          paymentId: row.paymentId ? binToUuid(row.paymentId) : null,
          periodId: binToUuid(period.id),
          effectiveAt: effectiveAt.toISOString(),
          // What the request was quoted at, what was paid, and what the period actually rose by (PQ5): a difference is
          // seen here, never turned into money.
          monthlyAmount: row.monthlyAmount,
          paid: row.payment?.amount.toString() ?? null,
          raisedBy: (after?.assessedTotal ?? 0) - (before?.assessedTotal ?? 0),
        }) as Prisma.InputJsonValue,
        createdAt: now,
      },
    });
    done.activated.push(requestId);
  }

  for (const userId of owners) await activateIfReadyTx(db, userId, now, actor);
  for (const store of gained) {
    for (const userId of waiting.get(store) ?? []) await activateIfReadyTx(db, userId, now, actor);
  }
  return done;
}

/** One attempt at one of the two transactions. */
type Attempt<T> = { kind: 'ok'; value: T } | { kind: 'busy' } | { kind: 'failed'; error: Error };

/** What one run did, for the caller and the lazy path's bookkeeping. */
interface RunResult {
  outcome: TrialEndOutcome;
  /** The expiry is written down — before this run, or by it. */
  expiryRecorded: boolean;
  /** Requests put in force by this run. */
  activated: number;
  /** "Is anything due?" was asked, so "nothing remains" can be known. */
  dueChecked: boolean;
}

/** The facts a run needs: the subscription, the business's name and its claim. */
interface TrialEndFacts {
  subscriptionId: Buffer;
  label: string;
  claim: TrialClaimRow;
}

export class TrialEndRoll {
  private readonly logger = new Logger(TrialEndRoll.name);
  private readonly billing: BillingService;
  /** company → the lazy attempt running now; concurrent evaluations skip it rather than wait. */
  private readonly inFlight = new Map<string, Promise<RunResult>>();
  /** company → no lazy attempt before this instant (back-off after busy or an error). */
  private readonly retryAt = new Map<string, number>();
  /** company → errors in a row, for the doubling back-off. */
  private readonly failures = new Map<string, number>();
  /** company → when the lazy path last asked whether anything was due. */
  private readonly dueCheckedAt = new Map<string, number>();
  /** Companies whose trial ended, whose expiry is recorded and that have nothing scheduled left: nothing more to do. */
  private readonly settled = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {
    this.billing = new BillingService(prisma, clock);
  }

  /**
   * Record the expiry and put in force what is due, for one company, now — for an administrator's action, the seat
   * confirmation, the staff activation and the sweeper. Never throws, never waits for the subscription lock:
   * `busy` means another writer holds it and the work is left to a later attempt.
   */
  async applyIfDue(companyId: Buffer, actor = 'system'): Promise<TrialEndOutcome> {
    try {
      const facts = await this.factsOf(companyId);
      if (!facts) return 'nothing_due';
      return (await this.run(companyId, facts, { expiry: true, due: true }, actor)).outcome;
    } catch (e) {
      this.logger.warn(`Free trial end check failed for company ${binToUuid(companyId)}: ${(e as Error).message}`);
      return 'failed';
    }
  }

  /**
   * The lazy path, from the entitlement check that every tenant request passes (R1-F2): returns at once while the
   * trial runs or once the company is settled, and otherwise never waits on another attempt —
   *
   *  - one attempt per company in flight; concurrent evaluations skip it;
   *  - a second's back-off after `busy`, a doubling back-off up to a minute after an error;
   *  - "is anything due?" asked at most once a minute (the expiry record needs no query: the claim is already read).
   *
   * True when this evaluation put something in force, so the caller re-reads what it counts. Never throws.
   */
  async onEvaluation(companyId: Buffer, subscriptionId: Buffer, label: string, claim: TrialClaimRow): Promise<boolean> {
    const now = this.clock.now().getTime();
    if (now < claim.endsAt.getTime()) return false;
    const key = companyId.toString('hex');
    if (this.settled.has(key) || this.inFlight.has(key)) return false;
    const until = this.retryAt.get(key);
    if (until !== undefined && now < until) return false;
    const expiry = claim.expiryRecordedAt === null;
    const checkedAt = this.dueCheckedAt.get(key);
    const due = checkedAt === undefined || now - checkedAt >= DUE_CHECK_TTL_MS;
    if (!expiry && !due) return false;
    // Recorded before the attempt, as the renewal check does: concurrent evaluations do not each ask.
    if (due) this.dueCheckedAt.set(key, now);

    const attempt = this.run(companyId, { subscriptionId, label, claim }, { expiry, due }, 'system').catch(
      (e: unknown): RunResult => {
        this.logger.warn(`Free trial end check failed for company ${binToUuid(companyId)}: ${(e as Error).message}`);
        return { outcome: 'failed', expiryRecorded: !expiry, activated: 0, dueChecked: false };
      },
    );
    this.inFlight.set(key, attempt);
    try {
      const result = await attempt;
      await this.afterLazyRun(companyId, key, result);
      return result.activated > 0;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Back-off after busy or an error; once the expiry is recorded and nothing scheduled remains, the company is settled. */
  private async afterLazyRun(companyId: Buffer, key: string, result: RunResult): Promise<void> {
    const now = this.clock.now().getTime();
    if (result.outcome === 'busy' || result.outcome === 'failed') {
      this.dueCheckedAt.delete(key);
      if (result.outcome === 'busy') {
        this.retryAt.set(key, now + BUSY_BACKOFF_MS);
        return;
      }
      const failures = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, failures);
      this.retryAt.set(key, now + Math.min(ERROR_BACKOFF_CAP_MS, ERROR_BACKOFF_BASE_MS * 2 ** (failures - 1)));
      return;
    }
    this.failures.delete(key);
    this.retryAt.delete(key);
    if (!result.expiryRecorded || !result.dueChecked) return;
    try {
      // No scheduled request can be made once the trial has ended (a confirmation schedules only while it runs); the
      // sweeper covers an instance whose clock lagged.
      const left = await this.prisma.seatAllocation.findFirst({ where: { companyId, status: 'scheduled' }, select: { id: true } });
      if (!left) this.settled.add(key);
    } catch (e) {
      this.logger.warn(`Free trial end check failed for company ${binToUuid(companyId)}: ${(e as Error).message}`);
    }
  }

  /** The subscription, the name and the claim, read together. Null when there is no claim: then nothing is ever due. */
  private async factsOf(companyId: Buffer): Promise<TrialEndFacts | null> {
    const row = await this.prisma.subscription.findFirst({
      where: { companyId },
      select: {
        id: true,
        company: { select: { name: true, trialClaim: { select: { id: true, endsAt: true, expiryRecordedAt: true } } } },
      },
    });
    const claim = row?.company?.trialClaim ?? null;
    if (!row || !claim) return null;
    return { subscriptionId: row.id, label: row.company.name, claim };
  }

  /**
   * Tx A then Tx B, each on its own: a busy or failed expiry record does not stop the activation, and a failed
   * activation never touches the record. Before the trial's end there is nothing to do: a scheduled request starts at
   * the end of the trial it was paid for during.
   */
  private async run(
    companyId: Buffer,
    facts: TrialEndFacts,
    checks: { expiry: boolean; due: boolean },
    actor: string,
  ): Promise<RunResult> {
    const result: RunResult = { outcome: 'nothing_due', expiryRecorded: facts.claim.expiryRecordedAt !== null, activated: 0, dueChecked: false };
    const asked = this.clock.now();
    if (asked.getTime() < facts.claim.endsAt.getTime()) return result;
    const outcomes: TrialEndOutcome[] = [];
    const company = binToUuid(companyId);

    if (checks.expiry && facts.claim.expiryRecordedAt === null) {
      const a = await this.attempt(() =>
        this.prisma.$transaction(async (tx) => {
          await lockSubscriptionNowait(tx, companyId);
          const now = this.clock.now();
          return recordTrialExpiryTx(tx, companyId, facts.subscriptionId, facts.label, facts.claim.id, facts.claim.endsAt, now);
        }, TX_OPTIONS),
      );
      if (a.kind === 'ok') {
        result.expiryRecorded = true;
        outcomes.push(a.value ? 'done' : 'nothing_due');
        if (a.value) this.logger.log(`Free trial expiry recorded for company ${company} (ended ${facts.claim.endsAt.toISOString()})`);
      } else if (a.kind === 'busy') {
        outcomes.push('busy');
      } else {
        outcomes.push('failed');
        this.logger.warn(`Free trial expiry record failed for company ${company}: ${a.error.message}`);
      }
    }

    if (checks.due) {
      const due = await this.prisma.seatAllocation.findFirst({
        where: { companyId, status: 'scheduled', effectiveAt: { lte: asked } },
        select: { id: true },
      });
      result.dueChecked = true;
      if (due) {
        const b = await this.attempt(() =>
          this.prisma.$transaction(async (tx) => {
            await lockSubscriptionNowait(tx, companyId);
            const now = this.clock.now();
            return activateDueAddOnsTx(tx, this.billing, companyId, now, actor);
          }, TX_OPTIONS),
        );
        if (b.kind === 'ok') {
          result.activated = b.value.activated.length;
          outcomes.push(b.value.activated.length > 0 || b.value.blocked.length > 0 ? 'done' : 'nothing_due');
          if (b.value.activated.length > 0) {
            this.logger.log(`Put in force for company ${company}: ${b.value.activated.length} request(s) paid for during the free trial`);
          }
        } else if (b.kind === 'busy') {
          outcomes.push('busy');
        } else {
          outcomes.push('failed');
          this.logger.warn(`Activation of what was paid for during the free trial failed for company ${company}: ${b.error.message}`);
        }
      }
    }

    result.outcome = outcomes.includes('failed')
      ? 'failed'
      : outcomes.includes('busy')
        ? 'busy'
        : outcomes.includes('done')
          ? 'done'
          : 'nothing_due';
    return result;
  }

  /** Run one transaction; a row another writer holds is `busy`, anything else thrown is `failed`. */
  private async attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
    try {
      return { kind: 'ok', value: await work() };
    } catch (e) {
      if (isLockBusy(e)) return { kind: 'busy' };
      return { kind: 'failed', error: e instanceof Error ? e : new Error(String(e)) };
    }
  }
}
