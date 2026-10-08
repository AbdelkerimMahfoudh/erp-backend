import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, type Clock } from '../entitlement/clock';
import { seatCensus } from '../entitlement/seat-census';
import { isActivity, type Activity } from '../entitlement/activity';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';
import {
  assessPeriod,
  estimateFor,
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
  /** The money services agent price and the price of a branch doing both (D154). */
  agentMonthly: number;
  bothMonthly: number;
  includedStaffPerBranch: number;
  extraStaffMonthly: number;
  effectiveFrom: string;
  reason: string;
}

export interface SubscriptionPricing {
  plan: PlanVersionView;
  /** A scheduled future price, when one exists. The customer is told. */
  upcomingPlan: PlanVersionView | null;
  /** Today's size at today's plan, store by store. */
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
  /** Today's size at the plan that will apply next, each branch at the activity it will have then. Goes down when seats are released. */
  nextRenewalEstimate: Quote;
  currency: 'MRU';
}

/** The plan in force, as the public website may show it. Prices only; nothing about any business. */
export interface PublicPlan {
  version: number;
  /** The electronics store price — the name predates the activities and the website reads it. */
  branchMonthly: number;
  agentMonthly: number;
  bothMonthly: number;
  includedSeatsPerStore: number;
  extraSeatMonthly: number;
  currency: 'MRU';
  effectiveFrom: string;
  upcoming: {
    version: number;
    branchMonthly: number;
    agentMonthly: number;
    bothMonthly: number;
    includedSeatsPerStore: number;
    extraSeatMonthly: number;
    effectiveFrom: string;
  } | null;
}

/** An applicant may describe at most this many stores in one estimate. */
export const ESTIMATE_MAX_STORES = 50;
export const ESTIMATE_MAX_STAFF_PER_STORE = 500;

/** The same map, whatever order MySQL hands its keys back in. */
function sameFees(a: Record<string, number> | null | undefined, b: Record<string, number>): boolean {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
  return left.length === right.length && left.every(([k, v], i) => right[i][0] === k && right[i][1] === v);
}

/** The stored per-branch assessment, read defensively: the column is JSON and nothing but a map of integers belongs in it. */
function feesFrom(value: Prisma.JsonValue | null | undefined): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * How big the company is, for pricing — store by store.
   *
   * The census is shared with entitlement (`seat-census.ts`), so the seats a
   * shop is charged for and the seats it may fill are counted by one piece of
   * code — and so is each branch's activity. A pending invitation is
   * `is_active = 0` until the server activates it, so it cannot be counted by
   * construction.
   */
  async sizeOf(companyId: Buffer): Promise<CompanySize> {
    const census = await seatCensus(this.prisma, companyId);
    return {
      activeBranchCount: census.activeBranchCount,
      activeStaffCount: census.seatsUsed,
      branches: census.branches.map((b) => ({
        branchId: b.branchId,
        name: b.name,
        activity: b.activity ?? 'electronics',
        activityNext: b.activityNext ?? null,
        staffCount: b.seatsUsed,
        paidSeats: b.paidSeats,
        grantedSeats: b.grantedSeats,
      })),
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
      agentMonthly: r.agentMonthly,
      bothMonthly: r.bothMonthly,
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
      agentMonthly: v.agentMonthly,
      bothMonthly: v.bothMonthly,
      includedStaffPerBranch: v.includedStaffPerBranch,
      extraStaffMonthly: v.extraStaffMonthly,
    };
  }

  /**
   * The plan in force, for the public website.
   *
   * Prices and dates only. Nothing here names, counts or describes any
   * business, so showing it to an anonymous visitor reveals nothing but the
   * price list — which is the one thing the website exists to show.
   */
  async publicPlan(): Promise<PublicPlan> {
    const plans = await this.planAt(this.clock.now());
    const c = plans.current;
    const u = plans.upcoming;
    return {
      version: c.version,
      branchMonthly: c.branchMonthly,
      agentMonthly: c.agentMonthly,
      bothMonthly: c.bothMonthly,
      includedSeatsPerStore: c.includedStaffPerBranch,
      extraSeatMonthly: c.extraStaffMonthly,
      currency: 'MRU',
      effectiveFrom: c.effectiveFrom,
      upcoming: u
        ? {
            version: u.version,
            branchMonthly: u.branchMonthly,
            agentMonthly: u.agentMonthly,
            bothMonthly: u.bothMonthly,
            includedSeatsPerStore: u.includedStaffPerBranch,
            extraSeatMonthly: u.extraStaffMonthly,
            effectiveFrom: u.effectiveFrom,
          }
        : null,
    };
  }

  /**
   * What a business of this shape would pay — the applicant's estimate.
   *
   * Stateless: it reads the plan and nothing else, so it can neither reveal a
   * real business nor be steered by a client-side figure. The website renders
   * the result and computes none of it. `activities` says what each store
   * would do, one per store; left out, every store is an electronics store.
   */
  async estimate(staffPerStore: readonly number[], activities: readonly Activity[] = []): Promise<Quote> {
    if (!Array.isArray(staffPerStore) || staffPerStore.length === 0) {
      throw new BadRequestException('Describe at least one store.');
    }
    if (staffPerStore.length > ESTIMATE_MAX_STORES) {
      throw new BadRequestException(`Describe at most ${ESTIMATE_MAX_STORES} stores.`);
    }
    for (const n of staffPerStore) {
      if (!Number.isInteger(n) || n < 0 || n > ESTIMATE_MAX_STAFF_PER_STORE) {
        throw new BadRequestException(
          `Each store takes a whole number of employees, up to ${ESTIMATE_MAX_STAFF_PER_STORE}.`,
        );
      }
    }
    if (!Array.isArray(activities)) {
      throw new BadRequestException('Say what each store does, one activity per store.');
    }
    if (activities.length !== 0 && activities.length !== staffPerStore.length) {
      throw new BadRequestException('Say what each store does: one activity per store, or none at all.');
    }
    for (const a of activities) {
      if (!isActivity(a)) {
        throw new BadRequestException('Each store is an electronics store, a money services agent, or both.');
      }
    }
    const plans = await this.planAt(this.clock.now());
    return estimateFor(staffPerStore, this.pricingOf(plans.current), activities);
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
      {
        assessedBranchFee: period.assessedBranchFee,
        assessedStaffFee: period.assessedStaffFee,
        assessedActivityFeeByBranch: feesFrom(period.assessedActivityFeeByBranch),
      },
      // Priced with the period's OWN copied unit prices, never today's plan.
      {
        branchMonthly: period.branchMonthly,
        agentMonthly: period.agentMonthly,
        bothMonthly: period.bothMonthly,
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
   * Called when a company grows — a store, a paid seat or an activity upgrade
   * confirmed mid-period costs the whole month at once, and the upgrade costs
   * exactly its branch's difference because the period remembers each branch's
   * fee. Never lowers anything: there is no prorating, so a release reduces
   * the next renewal and nothing else.
   */
  async assessNow(companyId: Buffer): Promise<void> {
    const period = await this.prisma.billingPeriod.findFirst({
      where: { companyId },
      orderBy: { periodStart: 'desc' },
    });
    if (!period) return;

    const size = await this.sizeOf(companyId);
    const stored = feesFrom(period.assessedActivityFeeByBranch);
    const assessment = assessPeriod(
      size,
      {
        assessedBranchFee: period.assessedBranchFee,
        assessedStaffFee: period.assessedStaffFee,
        assessedActivityFeeByBranch: stored,
      },
      {
        branchMonthly: period.branchMonthly,
        agentMonthly: period.agentMonthly,
        bothMonthly: period.bothMonthly,
        includedStaffPerBranch: period.includedStaffPerBranch,
        extraStaffMonthly: period.extraStaffMonthly,
      },
    );

    if (assessment.addedThisPeriod === 0) {
      // Nothing to charge. A period opened before the per-branch map existed
      // still learns its branches' fees here, so the next upgrade can be
      // priced as that branch's own difference.
      if (sameFees(stored, assessment.assessedActivityFeeByBranch)) return;
      await this.prisma.billingPeriod.update({
        where: { id: period.id },
        data: { assessedActivityFeeByBranch: assessment.assessedActivityFeeByBranch },
      });
      return;
    }

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
        assessedActivityFeeByBranch: assessment.assessedActivityFeeByBranch,
      },
    });
  }

  /**
   * Open a billing period, freezing the plan's unit prices into it.
   *
   * Called when a subscription is activated and at every renewal. The prices
   * are copied rather than referenced so that scheduling a new plan version
   * tomorrow cannot rewrite what this period was assessed at; each branch's
   * fee is written down beside them, so an upgrade later in the period is
   * charged as that branch's own difference.
   */
  async openPeriod(companyId: Buffer, subscriptionId: Buffer, endsAt: Date | null): Promise<void> {
    const now = this.clock.now();
    const [size, plans] = await Promise.all([this.sizeOf(companyId), this.planAt(now)]);
    const plan = this.pricingOf(plans.current);
    const q = quoteFor(size, plan);

    const assessedActivityFeeByBranch: Record<string, number> = {};
    for (const line of q.lines) {
      if (line.branchId !== null) assessedActivityFeeByBranch[line.branchId] = line.activityFee;
    }

    await this.prisma.billingPeriod.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId,
        planVersionId: Buffer.from(plans.current.id.replace(/-/g, ''), 'hex'),
        periodStart: now,
        periodEnd: endsAt,
        branchMonthly: plan.branchMonthly,
        agentMonthly: plan.agentMonthly,
        bothMonthly: plan.bothMonthly,
        includedStaffPerBranch: plan.includedStaffPerBranch,
        extraStaffMonthly: plan.extraStaffMonthly,
        activeBranchCount: q.activeBranchCount,
        activeStaffCount: q.activeStaffCount,
        includedStaffCount: q.includedStaffCount,
        chargeableStaffCount: q.chargeableStaffCount,
        assessedBranchFee: q.branchFee,
        assessedStaffFee: q.staffFee,
        assessedTotal: q.monthlyTotal,
        assessedActivityFeeByBranch,
        currency: 'MRU',
      },
    });
  }

  /**
   * Close the current billing period at this instant — the first half of a
   * renewal (D154 a); `openPeriod` is the second.
   *
   * What the period was assessed at is kept untouched: nothing is refunded and
   * nothing is re-priced. A period that had already run out keeps the end it
   * had — a shop that lapsed in September and renews in October was not
   * subscribed in between, and the snapshot must not say it was. Answers
   * whether there was a period to close, so the caller can say which it did.
   */
  async closeCurrentPeriod(companyId: Buffer, at: Date): Promise<boolean> {
    const period = await this.prisma.billingPeriod.findFirst({
      where: { companyId },
      orderBy: { periodStart: 'desc' },
      select: { id: true, periodEnd: true },
    });
    if (!period) return false;
    if (period.periodEnd === null || period.periodEnd.getTime() > at.getTime()) {
      await this.prisma.billingPeriod.update({ where: { id: period.id }, data: { periodEnd: at } });
    }
    return true;
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
    agentMonthly: number;
    bothMonthly: number;
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
      agentMonthly: input.agentMonthly,
      bothMonthly: input.bothMonthly,
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
        agentMonthly: input.agentMonthly,
        bothMonthly: input.bothMonthly,
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
      agentMonthly: created.agentMonthly,
      bothMonthly: created.bothMonthly,
      includedStaffPerBranch: created.includedStaffPerBranch,
      extraStaffMonthly: created.extraStaffMonthly,
      effectiveFrom: created.effectiveFrom.toISOString(),
      reason: created.reason,
    };
  }
}
