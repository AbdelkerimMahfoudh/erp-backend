import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { CLOCK, type Clock } from './clock';
import { seatCensus } from './seat-census';
import { binToUuid } from '../common/utils/uuid.util';
import { BillingService } from '../billing/billing.service';
import { SubscriptionRenewal } from '../billing/renewal';
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

/** What a refused write says, per state that cannot write. Only an expired subscription has "ended". */
const WRITE_REFUSED = {
  expired: 'Your subscription has ended. You can still read and export everything.',
  suspended: 'This business is suspended, so nothing can be changed. Open your account page to see why.',
  cancelled: 'This business is cancelled, so nothing can be changed. Open your account page to see why.',
  pending: 'This business is waiting to be activated, so nothing can be changed yet.',
  rejected: 'This registration was not approved, so nothing can be changed.',
} satisfies Record<Exclude<EntitlementState, 'active' | 'grace' | 'complimentary'>, string>;

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);
  /** The renewal a prepaid period is owed at its end (D154, billing/renewal.ts): applied by the first evaluation after it. */
  private readonly renewal: SubscriptionRenewal;
  /** company → when it was last checked: at most one cheap query a minute per company. */
  private readonly rollCheckedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.renewal = new SubscriptionRenewal(prisma, new BillingService(prisma, clock), clock);
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
   * The subscription row, or a synthetic never-subscribed one.
   *
   * A company with no row is treated as expired rather than as an error: the
   * backfill covers everybody who existed at deployment, and a company created
   * afterwards by some path that forgot to make one must fail closed rather
   * than crash on every request.
   */
  private async recordFor(companyId: Buffer): Promise<SubscriptionRecord> {
    await this.rollIfDue(companyId);
    const row = await this.prisma.subscription.findFirst({ where: { companyId } });
    if (!row) {
      return {
        subscribedBranchCount: 0,
        additionalSeats: 0,
        currentPeriodEnd: null,
        isComplimentary: false,
        complimentaryUntil: null,
        // No subscription row at all. `expired` is the honest reading: reads
        // work, writes do not, and nothing was ever granted.
        status: 'activated',
      };
    }
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

  /** The full object the mobile app renders and never recomputes. */
  async forCompany(companyId: Buffer): Promise<Entitlement> {
    const [record, usage] = await Promise.all([this.recordFor(companyId), this.seatUsage(companyId)]);
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
   * Returns `null` when it is open — including when the subscription has
   * EXPIRED, because expiry has never hidden anything and still does not.
   * Only the two deliberate states close the door, and each says which one it
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
    const [record, usage] = await Promise.all([this.recordFor(companyId), this.seatUsage(companyId)]);
    const math = seatMath(record, usage);
    if (!branchIds) {
      return { allowed: mayConsumeSeat(math), seatsUsed: math.seatsUsed, seatLimit: math.seatLimit, stores: math.branches, full: [] };
    }
    const full = branchIds.map((id) => binToUuid(id)).filter((id) => !mayConsumeSeatIn(math, id));
    return { allowed: full.length === 0, seatsUsed: math.seatsUsed, seatLimit: math.seatLimit, stores: math.branches, full };
  }
}
