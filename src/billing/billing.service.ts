import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, type Clock } from '../entitlement/clock';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';
import {
  assessPeriod,
  nextRenewalEstimate,
  quoteFor,
  type CompanySize,
  type PlanPricing,
  type Quote,
} from './pricing-rules';

/**
 * Pricing, against real companies.
 *
 * The arithmetic lives in `pricing-rules.ts` and is pure; this file's whole job
 * is counting the company correctly and remembering what a period was assessed
 * at. Those are the two places a price goes wrong in practice — not the
 * multiplication.
 */

export interface PlanVersionView {
  id: string;
  planKey: string;
  version: number;
  branchMonthly: number;
  includedStaffPerBranch: number;
  extraStaffMonthly: number;
  effectiveFrom: string;
  reason: string;
}

export interface SubscriptionPricing {
  plan: PlanVersionView;
  /** A scheduled future price, when one exists. The customer is told. */
  upcomingPlan: PlanVersionView | null;
  /** Today's size at today's plan. */
  quote: Quote;
  /** What this period is actually assessed at — never below what was charged. */
  currentPeriod: {
    periodStart: string | null;
    assessedBranchFee: number;
    assessedStaffFee: number;
    assessedTotal: number;
    /** Raised above the plain quote by mid-period additions. Never negative. */
    adjustments: number;
    available: boolean;
  };
  /** Today's size at the plan that will apply next. Goes down when staff leave. */
  nextRenewalEstimate: Quote;
  currency: 'MRU';
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * How big the company is, for pricing.
   *
   * Two rules do the work, and both are easy to get wrong:
   *
   *  - **Distinct people, not assignments.** Somebody working across three
   *    branches is one person being paid for once. Counting `user_branches`
   *    rows would charge a shop for organising itself sensibly.
   *  - **The Owner is never counted.** Charging for the account that pays the
   *    bill would be absurd, and it matches the seat maths that has always
   *    been in `entitlement-rules.ts`.
   *
   * Inactive and soft-deleted users are excluded, and so are archived branches.
   * A pending invitation has no user row at all, so it cannot be counted by
   * construction.
   */
  async sizeOf(companyId: Buffer): Promise<CompanySize> {
    const staff = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT u.id) AS n
      FROM users u
      JOIN user_branches ub ON ub.user_id = u.id
      JOIN roles r ON r.id = ub.role_id
      WHERE u.company_id = ${companyId}
        AND u.is_active = 1
        AND u.deleted_at IS NULL
        AND r.\`key\` <> 'owner'
    `;

    const activeBranchCount = await this.prisma.branch.count({
      where: { companyId, isActive: true },
    });

    return {
      activeBranchCount,
      activeStaffCount: Number(staff[0]?.n ?? 0),
    };
  }

  /** The plan version in force at a moment, and the next one if scheduled. */
  async planAt(when: Date): Promise<{ current: PlanVersionView; upcoming: PlanVersionView | null }> {
    const rows = await this.prisma.planVersion.findMany({
      where: { planKey: 'standard' },
      orderBy: { effectiveFrom: 'asc' },
    });
    if (rows.length === 0) {
      throw new BadRequestException('No pricing is configured.');
    }

    const view = (r: (typeof rows)[number]): PlanVersionView => ({
      id: binToUuid(r.id),
      planKey: r.planKey,
      version: r.version,
      branchMonthly: r.branchMonthly,
      includedStaffPerBranch: r.includedStaffPerBranch,
      extraStaffMonthly: r.extraStaffMonthly,
      effectiveFrom: r.effectiveFrom.toISOString(),
      reason: r.reason,
    });

    const past = rows.filter((r) => r.effectiveFrom.getTime() <= when.getTime());
    const future = rows.filter((r) => r.effectiveFrom.getTime() > when.getTime());

    return {
      current: view(past[past.length - 1] ?? rows[0]),
      upcoming: future.length ? view(future[0]) : null,
    };
  }

  private pricingOf(v: PlanVersionView): PlanPricing {
    return {
      branchMonthly: v.branchMonthly,
      includedStaffPerBranch: v.includedStaffPerBranch,
      extraStaffMonthly: v.extraStaffMonthly,
    };
  }

  /**
   * Everything the portal and the administrator need, calculated here.
   *
   * The client renders these numbers and derives none of them. A client that
   * computes its own price is a client that can be made to compute it wrongly,
   * and the shopkeeper is the one who would find out.
   */
  async pricingFor(companyId: Buffer): Promise<SubscriptionPricing> {
    const now = this.clock.now();
    const [size, plans] = await Promise.all([this.sizeOf(companyId), this.planAt(now)]);

    const plan = this.pricingOf(plans.current);
    const quote = quoteFor(size, plan);

    const period = await this.prisma.billingPeriod.findFirst({
      where: { companyId },
      orderBy: { periodStart: 'desc' },
    });

    /*
     * No period snapshot yet — a business that has never been activated.
     *
     * Reported as `available: false` rather than as zeros. A zero here would
     * read as "this shop was billed nothing", which is a different and untrue
     * statement about a shop that has never been billed at all.
     */
    if (!period) {
      return {
        plan: plans.current,
        upcomingPlan: plans.upcoming,
        quote,
        currentPeriod: {
          periodStart: null,
          assessedBranchFee: 0,
          assessedStaffFee: 0,
          assessedTotal: 0,
          adjustments: 0,
          available: false,
        },
        nextRenewalEstimate: nextRenewalEstimate(size, this.pricingOf(plans.upcoming ?? plans.current)),
        currency: 'MRU',
      };
    }

    const assessment = assessPeriod(
      size,
      { assessedBranchFee: period.assessedBranchFee, assessedStaffFee: period.assessedStaffFee },
      // Priced with the period's OWN copied unit prices, never today's plan.
      {
        branchMonthly: period.branchMonthly,
        includedStaffPerBranch: period.includedStaffPerBranch,
        extraStaffMonthly: period.extraStaffMonthly,
      },
    );

    return {
      plan: plans.current,
      upcomingPlan: plans.upcoming,
      quote,
      currentPeriod: {
        periodStart: period.periodStart.toISOString(),
        assessedBranchFee: assessment.assessedBranchFee,
        assessedStaffFee: assessment.assessedStaffFee,
        assessedTotal: assessment.assessedTotal,
        // What mid-period growth has added above a plain quote of today's size.
        adjustments: Math.max(0, assessment.assessedTotal - assessment.monthlyTotal),
        available: true,
      },
      nextRenewalEstimate: nextRenewalEstimate(size, this.pricingOf(plans.upcoming ?? plans.current)),
      currency: 'MRU',
    };
  }

  /**
   * Raise this period's assessment to cover the company as it is now.
   *
   * Called when a company grows. Never lowers anything: there is no prorating,
   * so a removal reduces the next renewal and nothing else.
   */
  async assessNow(companyId: Buffer): Promise<void> {
    const now = this.clock.now();
    const period = await this.prisma.billingPeriod.findFirst({
      where: { companyId },
      orderBy: { periodStart: 'desc' },
    });
    if (!period) return;

    const size = await this.sizeOf(companyId);
    const assessment = assessPeriod(
      size,
      { assessedBranchFee: period.assessedBranchFee, assessedStaffFee: period.assessedStaffFee },
      {
        branchMonthly: period.branchMonthly,
        includedStaffPerBranch: period.includedStaffPerBranch,
        extraStaffMonthly: period.extraStaffMonthly,
      },
    );

    if (assessment.addedThisPeriod === 0) return;

    await this.prisma.billingPeriod.update({
      where: { id: period.id },
      data: {
        activeBranchCount: size.activeBranchCount,
        activeStaffCount: size.activeStaffCount,
        includedStaffCount: assessment.includedStaffCount,
        chargeableStaffCount: assessment.chargeableStaffCount,
        assessedBranchFee: assessment.assessedBranchFee,
        assessedStaffFee: assessment.assessedStaffFee,
        assessedTotal: assessment.assessedTotal,
      },
    });
    void now;
  }

  /**
   * Open a billing period, freezing the plan's unit prices into it.
   *
   * Called when a subscription is activated. The prices are copied rather than
   * referenced so that scheduling a new plan version tomorrow cannot rewrite
   * what this period was assessed at.
   */
  async openPeriod(companyId: Buffer, subscriptionId: Buffer, endsAt: Date | null): Promise<void> {
    const now = this.clock.now();
    const [size, plans] = await Promise.all([this.sizeOf(companyId), this.planAt(now)]);
    const plan = this.pricingOf(plans.current);
    const q = quoteFor(size, plan);

    await this.prisma.billingPeriod.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId,
        planVersionId: Buffer.from(plans.current.id.replace(/-/g, ''), 'hex'),
        periodStart: now,
        periodEnd: endsAt,
        branchMonthly: plan.branchMonthly,
        includedStaffPerBranch: plan.includedStaffPerBranch,
        extraStaffMonthly: plan.extraStaffMonthly,
        activeBranchCount: q.activeBranchCount,
        activeStaffCount: q.activeStaffCount,
        includedStaffCount: q.includedStaffCount,
        chargeableStaffCount: q.chargeableStaffCount,
        assessedBranchFee: q.branchFee,
        assessedStaffFee: q.staffFee,
        assessedTotal: q.monthlyTotal,
        currency: 'MRU',
      },
    });
  }

  /**
   * Schedule a future price.
   *
   * Never retroactive: a version whose effective date is in the past would
   * change what a period already in flight is assessed at, which is the one
   * thing an immutable snapshot exists to prevent.
   */
  async schedulePlanVersion(input: {
    branchMonthly: number;
    includedStaffPerBranch: number;
    extraStaffMonthly: number;
    effectiveFrom: Date;
    reason: string;
    createdBy: string;
  }): Promise<PlanVersionView> {
    const now = this.clock.now();
    if (input.effectiveFrom.getTime() <= now.getTime()) {
      throw new BadRequestException('A new price must take effect in the future.');
    }
    if (!input.reason?.trim()) {
      throw new BadRequestException('A price change needs a reason.');
    }
    for (const [k, v] of Object.entries({
      branchMonthly: input.branchMonthly,
      includedStaffPerBranch: input.includedStaffPerBranch,
      extraStaffMonthly: input.extraStaffMonthly,
    })) {
      if (!Number.isInteger(v) || v < 0) {
        throw new BadRequestException(`${k} must be a whole number of MRU.`);
      }
    }

    const latest = await this.prisma.planVersion.findFirst({
      where: { planKey: 'standard' },
      orderBy: { version: 'desc' },
    });

    const created = await this.prisma.planVersion.create({
      data: {
        id: newUuidV7Bin(),
        planKey: 'standard',
        version: (latest?.version ?? 0) + 1,
        branchMonthly: input.branchMonthly,
        includedStaffPerBranch: input.includedStaffPerBranch,
        extraStaffMonthly: input.extraStaffMonthly,
        effectiveFrom: input.effectiveFrom,
        createdBy: input.createdBy,
        reason: input.reason.slice(0, 500),
      },
    });

    return {
      id: binToUuid(created.id),
      planKey: created.planKey,
      version: created.version,
      branchMonthly: created.branchMonthly,
      includedStaffPerBranch: created.includedStaffPerBranch,
      extraStaffMonthly: created.extraStaffMonthly,
      effectiveFrom: created.effectiveFrom.toISOString(),
      reason: created.reason,
    };
  }
}
