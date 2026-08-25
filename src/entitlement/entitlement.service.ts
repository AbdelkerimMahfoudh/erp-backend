import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { CLOCK, type Clock } from './clock';
import {
  buildEntitlement,
  canWrite,
  mayConsumeSeat,
  seatMath,
  stateOf,
  type Entitlement,
  type SubscriptionRecord,
  canRead,
  ENTITLEMENT_PENDING,
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
      };
    }
    return {
      subscribedBranchCount: row.subscribedBranchCount,
      additionalSeats: row.additionalSeats,
      currentPeriodEnd: row.currentPeriodEnd,
      isComplimentary: row.isComplimentary,
      complimentaryUntil: row.complimentaryUntil,
    };
  }

  /**
   * Seats in use across the whole company.
   *
   * Counts **active, non-Owner** users. The Owner is excluded because charging
   * for the account that pays the bill would be absurd, and inactive users are
   * excluded because a seat is a person working, not a row that once existed.
   *
   * Counted on `user_branches` distinct by user: somebody assigned to two
   * branches is one employee, not two.
   */
  private async seatUsage(companyId: Buffer): Promise<{ seatsUsed: number; activeBranchCount: number }> {
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT u.id) AS n
      FROM users u
      JOIN user_branches ub ON ub.user_id = u.id
      JOIN roles r ON r.id = ub.role_id
      WHERE u.company_id = ${companyId}
        AND u.is_active = 1
        AND r.\`key\` <> 'owner'
    `;
    const branches = await this.prisma.branch.count({ where: { companyId } });
    return { seatsUsed: Number(rows[0]?.n ?? 0), activeBranchCount: branches };
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

    return {
      code: state === 'pending' ? ENTITLEMENT_PENDING : ENTITLEMENT_SUSPENDED,
      message:
        state === 'pending'
          ? 'This business is waiting to be activated.'
          : 'This business is not active. Open your account page to see why.',
      state,
    };
  }

  /**
   * Whether one more seat-consuming person may be activated.
   *
   * Asked at the moment of activation rather than trusted from a cached figure,
   * because two Owners adding the last seat at once must not both succeed.
   */
  async maySeat(companyId: Buffer): Promise<{ allowed: boolean; seatsUsed: number; seatLimit: number }> {
    const [record, usage] = await Promise.all([this.recordFor(companyId), this.seatUsage(companyId)]);
    const math = seatMath(record, usage);
    return { allowed: mayConsumeSeat(math), seatsUsed: math.seatsUsed, seatLimit: math.seatLimit };
  }
}
