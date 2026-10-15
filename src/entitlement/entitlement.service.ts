import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { CLOCK, type Clock } from './clock';
import { seatCensus } from './seat-census';
import { binToUuid } from '../common/utils/uuid.util';
import { BillingService } from '../billing/billing.service';
import { SubscriptionRenewal } from '../billing/renewal';
import { displayTimeZone, trialFactsOf } from '../platform/trial/trial-rules';
import { TrialEndRoll } from '../platform/trial/trial-end-roll';
import { evaluationFactsOf, evaluationRead, type EvaluationColumns, type EvaluationFacts } from './evaluation-facts';
import {
  buildEntitlement,
  canWrite,
  mayConsumeSeat,
  mayConsumeSeatIn,
  seatMath,
  type BranchSeatMath,
  type SeatUsage,
  stateOf,
  type Entitlement,
  type SubscriptionRecord,
  canRead,
  ENTITLEMENT_PENDING,
  ENTITLEMENT_REJECTED,
  ENTITLEMENT_SUSPENDED,
  ENTITLEMENT_TRIAL_AVAILABLE,
  ENTITLEMENT_WRITE_BLOCKED,
  type EntitlementState,
} from './entitlement-rules';

/**
 * What a company is entitled to, calculated on the server (Milestone K).
 *
 * Reads the **unscoped** client deliberately: `subscriptions` is keyed by
 * company and every query here filters on it explicitly, but a company that has
 * lapsed must still be able to ask about itself, and the tenant extension is
 * about business data rather than about the billing relationship.
 *
 * The clock is injected. Every boundary in this feature is a moment in time, and
 * a feature whose boundaries can only be tested by waiting three days is a
 * feature nobody tests.
 */
/** How long a company's "is a renewal due?" answer is trusted before it is asked again. */
const ROLL_CHECK_TTL_MS = 60_000;

/** What a refused write says, per state that cannot write. Only an expired subscription or trial has "ended". */
const WRITE_REFUSED = {
  expired: 'Your subscription has ended. You can still read and export everything.',
  suspended: 'This business is suspended, so nothing can be changed. Open your account page to see why.',
  cancelled: 'This business is cancelled, so nothing can be changed. Open your account page to see why.',
  pending: 'This business is waiting to be activated, so nothing can be changed yet.',
  rejected: 'This registration was not approved, so nothing can be changed.',
  trial_available: 'This business has not started yet, so nothing can be changed.',
  trial_expired: 'The free trial has ended. You can still read and export everything.',
} satisfies Record<Exclude<EntitlementState, 'active' | 'grace' | 'complimentary' | 'trial_active'>, string>;

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);
  /** The renewal a prepaid period is owed at its end (D154, billing/renewal.ts): applied by the first evaluation after it. */
  private readonly renewal: SubscriptionRenewal;
  /**
   * The free trial's end (0095; D176): its record, and what was paid for during it put in force — applied by the first
   * evaluation after it, never waiting on the subscription row (trial-end-roll.ts).
   */
  private readonly trialEnd: TrialEndRoll;
  /** company → when it was last checked: at most one cheap query a minute per company. */
  private readonly rollCheckedAt = new Map<string, number>();
  /** Companies whose stored time zone was refused — said once per process, not on every request. */
  private readonly unknownZones = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.renewal = new SubscriptionRenewal(prisma, new BillingService(prisma, clock), clock);
    this.trialEnd = new TrialEndRoll(prisma, clock);
  }

  /**
   * Apply a renewal that fell due at the end of a prepaid period — the
   * downgrades scheduled for it and the next billing period — before anything
   * reads the company's state (D154, reviewed 2026-10-09). Every authenticated
   * request passes here, so the shop's activities change within a minute of
   * the old period's end, and the route gate reads them after this.
   *
   * Never blocks the request: a failure is logged and retried on the next
   * check. The roll itself is locked and idempotent.
   */
  private async rollIfDue(companyId: Buffer): Promise<void> {
    const key = companyId.toString('hex');
    const now = this.clock.now().getTime();
    const last = this.rollCheckedAt.get(key);
    if (last !== undefined && now - last < ROLL_CHECK_TTL_MS) return;
    this.rollCheckedAt.set(key, now);
    try {
      const rolled = await this.renewal.rollIfDue(companyId);
      if (rolled) this.logger.log(`Renewal applied for company ${binToUuid(companyId)} at ${rolled.at}`);
    } catch (e) {
      this.rollCheckedAt.delete(key);
      this.logger.warn(`Renewal check failed for company ${binToUuid(companyId)}: ${(e as Error).message}`);
    }
  }

  /**
   * The zone the trial's dates are shown in: the company's own, validated. An
   * unknown name reads as UTC and is reported once — never replaced by a zone
   * guessed for the country (trial-rules `displayTimeZone`).
   *
   * Shared with the website's trial routes and the console (0095), and with
   * every other date of a business that has trial facts (C18): the console's
   * lists and the Owner's account page say the business's zone by this same
   * rule. So a business's zone is checked once and reported once per process,
   * wherever it is read.
   */
  trialZone(companyId: Buffer, stored: string): string {
    return displayTimeZone(stored, (refused) => {
      const key = companyId.toString('hex');
      if (this.unknownZones.has(key)) return;
      this.unknownZones.add(key);
      this.logger.warn(`Company ${binToUuid(companyId)} has an unknown time zone "${refused}"; its dates are shown in UTC`);
    });
  }

  /**
   * The subscription row, or a synthetic never-subscribed one.
   *
   * A company with no row is treated as expired rather than as an error: the
   * backfill covers everybody who existed at deployment, and a company created
   * afterwards by some path that forgot to make one must fail closed rather
   * than crash on every request.
   *
   * The free trial's facts are read with it on every evaluation, never cached
   * (0095): a claim made on the website must be what the very next request
   * sees, and an ended trial must stop writes at its exact end.
   */
  private async recordFor(companyId: Buffer): Promise<SubscriptionRecord> {
    await this.rollIfDue(companyId);
    let row = await this.readRecord(companyId);
    // After the trial's end: its record, and what was paid for during it put in force (D176) — before anything is
    // counted, so the census read after this sees the store opened and the seat held. Never blocks the request.
    if (row?.company.trialClaim && (await this.trialEnd.onEvaluation(companyId, row.id, row.company.name, row.company.trialClaim))) {
      row = (await this.readRecord(companyId)) ?? row;
    }
    if (!row) {
      return {
        subscribedBranchCount: 0,
        additionalSeats: 0,
        currentPeriodEnd: null,
        isComplimentary: false,
        complimentaryUntil: null,
        // No subscription row at all. `expired` is the honest reading: reads
        // work, writes do not, and nothing was ever granted — not a trial either.
        status: 'activated',
        trial: null,
      };
    }
    const { timezone, trialEligibility, trialClaim } = row.company;
    return {
      subscribedBranchCount: row.subscribedBranchCount,
      additionalSeats: row.additionalSeats,
      currentPeriodEnd: row.currentPeriodEnd,
      isComplimentary: row.isComplimentary,
      complimentaryUntil: row.complimentaryUntil,
      // Carried explicitly. Omitting it silently defaults to `activated`, and a
      // pending business then reads as EXPIRED — which is what happened, and
      // which no test caught because the field is optional by design.
      status: row.status,
      trial: trialFactsOf(trialEligibility, trialClaim),
      // Only the trial's view shows a date in the business's zone, so only a business with a trial has it checked.
      timeZone: trialEligibility || trialClaim ? this.trialZone(companyId, timezone) : undefined,
    };
  }

  /**
   * Seats in use, store by store (docs/21, 2026-10-05).
   *
   * Counts **active, non-Owner** people at each active store, and what the shop
   * holds for that store — through the census that billing also reads, so the
   * two never disagree. The Owner is excluded because charging for the account
   * that pays the bill would be absurd; a pending invitation is inactive until
   * the server activates it, so it holds nothing yet.
   */
  private async seatUsage(companyId: Buffer): Promise<SeatUsage> {
    return seatCensus(this.prisma, companyId);
  }

  /**
   * The subscription row with what the evaluation reads beside it: the company's name and zone, and its free trial —
   * the eligibility's closure (with its reason: what proves, after the trial, that the access following it was decided
   * while it ran, C6) and the claim. One statement, one round trip, no cache (R1-F4; evaluation-facts.ts): every tenant
   * request passes here.
   */
  private async readRecord(companyId: Buffer): Promise<EvaluationFacts | null> {
    const [row] = await this.prisma.$queryRaw<EvaluationColumns[]>(evaluationRead(companyId));
    return row ? evaluationFactsOf(row) : null;
  }

  /** The full object the mobile app renders and never recomputes. */
  async forCompany(companyId: Buffer): Promise<Entitlement> {
    // One after the other (D176): the record may put in force what was paid for during the free trial, and the census
    // must count it.
    const record = await this.recordFor(companyId);
    const usage = await this.seatUsage(companyId);
    return buildEntitlement(record, usage, this.clock.now());
  }

  async current(): Promise<Entitlement> {
    return this.forCompany(this.tenant.companyId());
  }

  /**
   * Why a write is refused, or `null` when it may run — the one question the
   * write gate asks, kept cheap.
   *
   * The refusal names the state (D161). A suspended business was told its
   * subscription "has ended", which is untrue and sends the Owner looking for
   * a renewal that will not help; and a phone replaying a queued write needs
   * the state to know whether sending again later can ever succeed.
   */
  async writeRefusal(companyId: Buffer): Promise<{ code: string; message: string; state: EntitlementState } | null> {
    const record = await this.recordFor(companyId);
    const state = stateOf(record, this.clock.now());
    if (canWrite(state)) return null;
    return { code: ENTITLEMENT_WRITE_BLOCKED, message: WRITE_REFUSED[state as keyof typeof WRITE_REFUSED], state };
  }

  /**
   * Whether the operational app is closed to this company entirely.
   *
   * Returns `null` when it is open — including when the subscription or the
   * free trial has EXPIRED, because expiry has never hidden anything and still
   * does not. Only the closed states close the door, and each says which one it
   * is so the client can show the right screen rather than guess.
   */
  async operationalAccessBlocked(
    companyId: Buffer,
  ): Promise<{ code: string; message: string; state: EntitlementState } | null> {
    const record = await this.recordFor(companyId);
    const state = stateOf(record, this.clock.now());
    if (canRead(state)) return null;

    // Each closed state names itself. The app shows the right screen from the
    // code, and the Owner is told what actually happened — not a guess.
    if (state === 'pending') {
      return { code: ENTITLEMENT_PENDING, message: 'This business is waiting to be activated.', state };
    }
    if (state === 'rejected') {
      return { code: ENTITLEMENT_REJECTED, message: 'This registration was not approved.', state };
    }
    // Eligible for the free trial and not started: "not started", never "waiting for approval" or "ended" (0095).
    if (state === 'trial_available') {
      return { code: ENTITLEMENT_TRIAL_AVAILABLE, message: 'This business has not started yet.', state };
    }
    return {
      code: ENTITLEMENT_SUSPENDED,
      message: 'This business is not active. Open your account page to see why.',
      state,
    };
  }

  /**
   * Whether one more seat-consuming person may be activated.
   *
   * With `branchIds`, the question is asked store by store — a free seat at the
   * quiet store does not seat somebody at the busy one — and every store named
   * must have room. Without them it is the company-wide reading kept for
   * callers that have no store in hand.
   *
   * Asked at the moment of activation rather than trusted from a cached figure,
   * because two Owners adding the last seat at once must not both succeed.
   */
  async maySeat(
    companyId: Buffer,
    branchIds?: readonly Buffer[],
  ): Promise<{ allowed: boolean; seatsUsed: number; seatLimit: number; stores: BranchSeatMath[]; full: string[] }> {
    // The census after the record, as in `forCompany`: a seat put in force by this evaluation counts.
    const record = await this.recordFor(companyId);
    const usage = await this.seatUsage(companyId);
    const math = seatMath(record, usage);
    if (!branchIds) {
      return { allowed: mayConsumeSeat(math), seatsUsed: math.seatsUsed, seatLimit: math.seatLimit, stores: math.branches, full: [] };
    }
    const full = branchIds.map((id) => binToUuid(id)).filter((id) => !mayConsumeSeatIn(math, id));
    return { allowed: full.length === 0, seatsUsed: math.seatsUsed, seatLimit: math.seatLimit, stores: math.branches, full };
  }
}
