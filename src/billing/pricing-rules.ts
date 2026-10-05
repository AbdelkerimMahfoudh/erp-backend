/**
 * What a shop owes each month.
 *
 * Pure and integer-only, so every figure here can be tested without a database
 * and none of them can drift by a rounding error.
 *
 * ## Money is integer MRU, always
 *
 * There are no sub-units in play and no float ever touches an amount. A price
 * that is 1 000 in one place and 999.9999999 in another is not a rounding
 * problem, it is an argument with a shopkeeper — and the shopkeeper is right.
 *
 * ## The formula (docs/21, 2026-10-05)
 *
 *     branchFee     = activeBranchCount × 500
 *     for each store:
 *       includedSeats = 1                       the Owner never counts
 *       paidSeats     = seats bought for THIS store, 100 MRU each per month
 *       grantedSeats  = seats held without a charge (the transition, or a grant)
 *       seatFee       = paidSeats × 100
 *     staffFee      = Σ seatFee
 *     monthlyTotal  = branchFee + staffFee
 *
 * **Seats belong to a store, not to a company-wide pool.** This replaces the
 * launch rule of two included staff per branch pooled across the company. A
 * person who works at two stores holds one seat at each; within one store they
 * are counted once, however many roles or devices they have. A seat added
 * mid-month costs the whole month; removing one refunds nothing this period.
 *
 * What is charged is the seats a shop **holds** — bought and confirmed — not a
 * head-count the server took on its own. The head-count decides whether one
 * more person may be activated (`entitlement-rules.ts`); the held seats decide
 * the invoice. The two agree for every business activated under this rule,
 * because nobody can be activated into a seat the shop does not hold. Staff
 * who already worked above the included seat when the rule changed are
 * carried as granted seats by the transition, so nothing is charged
 * retroactively and nobody is deactivated.
 */

/** Everything the price depends on, and nothing else. */
export interface PlanPricing {
  /** MRU per active store per month. */
  branchMonthly: number;
  /** Included staff seats per store. One, since 2026-10-05. */
  includedStaffPerBranch: number;
  /** MRU per additional seat per store per month. */
  extraStaffMonthly: number;
}

/** The launch price: two included staff per branch, pooled company-wide. Kept so a period opened under it still re-prices. */
export const STANDARD_PLAN_V1: PlanPricing = {
  branchMonthly: 500,
  includedStaffPerBranch: 2,
  extraStaffMonthly: 100,
};

/** The approved rule of 2026-10-05: one included seat per store, 100 MRU per additional seat per store. */
export const STANDARD_PLAN_V2: PlanPricing = {
  branchMonthly: 500,
  includedStaffPerBranch: 1,
  extraStaffMonthly: 100,
};

export const CURRENT_PLAN: PlanPricing = STANDARD_PLAN_V2;

/** One store, as the price sees it. */
export interface BranchSize {
  /** Null for a hypothetical store in a public estimate. */
  branchId: string | null;
  name: string;
  /** Distinct active non-Owner people assigned to THIS store. */
  staffCount: number;
  /** Seats bought and confirmed for this store. Charged every month they are held. */
  paidSeats: number;
  /** Seats held without a charge: carried over by the transition, or granted by the platform. */
  grantedSeats: number;
}

export interface CompanySize {
  /** Stores that are active and not archived. */
  activeBranchCount: number;
  /**
   * Active non-Owner assignments, counted **per store**: a person at two
   * stores counts twice here because they hold a seat at each. Within one
   * store a person is counted once.
   */
  activeStaffCount: number;
  /** One line per active store. */
  branches: BranchSize[];
}

/** One store's seats, priced. */
export interface BranchQuoteLine {
  branchId: string | null;
  name: string;
  staffCount: number;
  includedSeats: number;
  paidSeats: number;
  grantedSeats: number;
  /** Included + paid + granted: how many people may work here. */
  seatLimit: number;
  seatsAvailable: number;
  /** More people than seats. Possible only for staff who predate the rule; never charged by this quote. */
  overLimit: boolean;
  seatFee: number;
}

export interface Quote {
  branchMonthly: number;
  extraStaffMonthly: number;
  includedSeatsPerStore: number;
  activeBranchCount: number;
  activeStaffCount: number;
  /** One per store. */
  includedStaffCount: number;
  paidSeatCount: number;
  grantedSeatCount: number;
  /** The seats this quote charges for: the paid ones. */
  chargeableStaffCount: number;
  branchFee: number;
  staffFee: number;
  monthlyTotal: number;
  currency: 'MRU';
  lines: BranchQuoteLine[];
}

/** Guard against a negative or fractional count reaching the arithmetic. */
function whole(n: number): number {
  return Math.max(0, Math.trunc(n));
}

/**
 * The monthly price for a company of this size, under this plan.
 *
 * Deliberately takes the plan as an argument rather than reading a constant:
 * a historical period must be re-priceable with the plan that was in force
 * *then*, and a function that reached for today's numbers could not do that.
 */
export function quoteFor(size: CompanySize, plan: PlanPricing = CURRENT_PLAN): Quote {
  const includedSeats = whole(plan.includedStaffPerBranch);
  const seatPrice = whole(plan.extraStaffMonthly);

  const lines: BranchQuoteLine[] = (size.branches ?? []).map((b) => {
    const staffCount = whole(b.staffCount);
    const paidSeats = whole(b.paidSeats);
    const grantedSeats = whole(b.grantedSeats);
    const seatLimit = includedSeats + paidSeats + grantedSeats;
    return {
      branchId: b.branchId,
      name: b.name,
      staffCount,
      includedSeats,
      paidSeats,
      grantedSeats,
      seatLimit,
      seatsAvailable: Math.max(0, seatLimit - staffCount),
      overLimit: staffCount > seatLimit,
      seatFee: paidSeats * seatPrice,
    };
  });

  const activeBranchCount = whole(size.activeBranchCount);
  const activeStaffCount = whole(size.activeStaffCount);
  const paidSeatCount = lines.reduce((n, l) => n + l.paidSeats, 0);
  const grantedSeatCount = lines.reduce((n, l) => n + l.grantedSeats, 0);

  const branchFee = activeBranchCount * whole(plan.branchMonthly);
  const staffFee = lines.reduce((n, l) => n + l.seatFee, 0);

  return {
    branchMonthly: plan.branchMonthly,
    extraStaffMonthly: plan.extraStaffMonthly,
    includedSeatsPerStore: includedSeats,
    activeBranchCount,
    activeStaffCount,
    includedStaffCount: activeBranchCount * includedSeats,
    paidSeatCount,
    grantedSeatCount,
    chargeableStaffCount: paidSeatCount,
    branchFee,
    staffFee,
    monthlyTotal: branchFee + staffFee,
    currency: 'MRU',
    lines,
  };
}

/**
 * What a business of this shape would pay — the website's public estimate.
 *
 * `staffPerStore` is the number of non-Owner employees at each store. Every
 * employee beyond the included seat is one paid seat at that store; nothing
 * pools across stores. A person who would work at two stores is listed at
 * both, which is exactly how they would be seated.
 */
export function estimateFor(staffPerStore: readonly number[], plan: PlanPricing = CURRENT_PLAN): Quote {
  const includedSeats = whole(plan.includedStaffPerBranch);
  const branches: BranchSize[] = staffPerStore.map((n, i) => {
    const staffCount = whole(n);
    return {
      branchId: null,
      name: `Store ${i + 1}`,
      staffCount,
      paidSeats: Math.max(0, staffCount - includedSeats),
      grantedSeats: 0,
    };
  });
  return quoteFor(
    {
      activeBranchCount: branches.length,
      activeStaffCount: branches.reduce((n, b) => n + b.staffCount, 0),
      branches,
    },
    plan,
  );
}

/**
 * What the CURRENT period is assessed at.
 *
 * ## Why this is not just `quoteFor` again
 *
 * There is **no prorating**, and that cuts both ways in a way a single quote
 * cannot express:
 *
 *  - a store or a paid seat added mid-period costs the **whole** month,
 *    immediately;
 *  - removing one refunds **nothing** — the reduction lands at the next
 *    renewal.
 *
 * So the current period's assessed components only ever go **up**. The period
 * snapshot remembers the high-water mark of what has been charged, and this
 * function takes the larger of that and today's size. Recomputing from today's
 * size alone would silently refund a shop that released a seat on the 20th,
 * which is exactly the behaviour the no-prorating rule forbids.
 *
 * This is also what keeps the 2026-10-05 rule change from touching any period
 * already in flight: a period assessed under the pooled rule keeps its
 * assessed fee, because the maximum never goes down.
 */
export interface AssessedPeriod {
  /** The largest store fee assessed so far this period. */
  assessedBranchFee: number;
  /** The largest seat fee assessed so far this period. */
  assessedStaffFee: number;
}

export interface PeriodAssessment extends Quote {
  /** What was already locked in before this recalculation. */
  previouslyAssessedBranchFee: number;
  previouslyAssessedStaffFee: number;
  /** The amount actually owed for this period — never below what was assessed. */
  assessedBranchFee: number;
  assessedStaffFee: number;
  assessedTotal: number;
  /** How much this recalculation added. Zero or positive, never negative. */
  addedThisPeriod: number;
}

export function assessPeriod(
  size: CompanySize,
  prior: AssessedPeriod,
  plan: PlanPricing = CURRENT_PLAN,
): PeriodAssessment {
  const q = quoteFor(size, plan);

  const priorBranch = whole(prior.assessedBranchFee);
  const priorStaff = whole(prior.assessedStaffFee);

  // The high-water mark, component by component. Taken per component rather
  // than on the total, so a store added late cannot mask a seat charge that
  // was already assessed — the two are separate facts about the period.
  const assessedBranchFee = Math.max(priorBranch, q.branchFee);
  const assessedStaffFee = Math.max(priorStaff, q.staffFee);

  const assessedTotal = assessedBranchFee + assessedStaffFee;
  const priorTotal = priorBranch + priorStaff;

  return {
    ...q,
    previouslyAssessedBranchFee: priorBranch,
    previouslyAssessedStaffFee: priorStaff,
    assessedBranchFee,
    assessedStaffFee,
    assessedTotal,
    addedThisPeriod: Math.max(0, assessedTotal - priorTotal),
  };
}

/**
 * What the shop will owe at the next renewal.
 *
 * Today's size at today's plan, with no memory of the current period. This is
 * the number that goes **down** when a seat is released or a store is
 * archived, and saying so plainly is the whole reason it is reported separately
 * from the current period.
 */
export function nextRenewalEstimate(size: CompanySize, plan: PlanPricing = CURRENT_PLAN): Quote {
  return quoteFor(size, plan);
}
