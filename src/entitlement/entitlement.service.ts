import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { CLOCK, type Clock } from './clock';
import { seatCensus } from './seat-census';
import { binToUuid } from '../common/utils/uuid.util';
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
@Injectable()
export class EntitlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The subscription row, or a synthetic never-subscribed one.
   *
   * A company with no row is treated as expired rather than as an error: the
   * backfill covers everybody who existed at deployment, and a company created
   * afterwards by some path that forgot to make one must fail closed rather
   * than crash on every request.
   */
  private async recordFor(companyId: Buffer): Promise<SubscriptionRecord> {
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

  /** The one question the guard asks, kept cheap. */
  async mayWrite(companyId: Buffer): Promise<boolean> {
    const record = await this.recordFor(companyId);
    return canWrite(stateOf(record, this.clock.now()));
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
