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
 * ## The formula
 *
 *     branchFee            = activeBranchCount × 500
 *     includedStaffCount   = activeBranchCount × 2
 *     chargeableStaffCount = max(0, activeStaffCount − includedStaffCount)
 *     staffFee             = chargeableStaffCount × 100
 *     monthlyTotal         = branchFee + staffFee
 *
 * The Owner is never counted. Charging for the account that pays the bill would
 * be absurd, and it is the same rule the seat maths in `entitlement-rules.ts`
 * has always used.
 *
 * Included staff are a **company-wide pool**, not a per-branch allowance. A shop
 * that hires its second person at the quieter branch has not changed what it
 * owes, and making the allowance per-branch would penalise exactly the sensible
 * arrangement.
 */

/** Everything the price depends on, and nothing else. */
export interface PlanPricing {
  /** MRU per active branch per month. */
  branchMonthly: number;
  /** Included active staff accounts per active branch, pooled company-wide. */
  includedStaffPerBranch: number;
  /** MRU per active staff account beyond the pool. */
  extraStaffMonthly: number;
}

/** The Standard plan as approved. One plan; there are no tiers. */
export const STANDARD_PLAN_V1: PlanPricing = {
  branchMonthly: 500,
  includedStaffPerBranch: 2,
  extraStaffMonthly: 100,
};

export interface CompanySize {
  /** Branches that are active and not archived. */
  activeBranchCount: number;
  /**
   * Distinct active **non-Owner** users in the company.
   *
   * Distinct is load-bearing: somebody assigned to three branches is one person
   * being paid for once. Counting assignments instead of people would charge a
   * shop for organising itself sensibly.
   */
  activeStaffCount: number;
}

export interface Quote {
  branchMonthly: number;
  extraStaffMonthly: number;
  activeBranchCount: number;
  activeStaffCount: number;
  includedStaffCount: number;
  chargeableStaffCount: number;
  branchFee: number;
  staffFee: number;
  monthlyTotal: number;
  currency: 'MRU';
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
export function quoteFor(size: CompanySize, plan: PlanPricing = STANDARD_PLAN_V1): Quote {
  const activeBranchCount = whole(size.activeBranchCount);
  const activeStaffCount = whole(size.activeStaffCount);

  const includedStaffCount = activeBranchCount * whole(plan.includedStaffPerBranch);
  const chargeableStaffCount = Math.max(0, activeStaffCount - includedStaffCount);

  const branchFee = activeBranchCount * whole(plan.branchMonthly);
  const staffFee = chargeableStaffCount * whole(plan.extraStaffMonthly);

  return {
    branchMonthly: plan.branchMonthly,
    extraStaffMonthly: plan.extraStaffMonthly,
    activeBranchCount,
    activeStaffCount,
    includedStaffCount,
    chargeableStaffCount,
    branchFee,
    staffFee,
    monthlyTotal: branchFee + staffFee,
    currency: 'MRU',
  };
}

/**
 * What the CURRENT period is assessed at.
 *
 * ## Why this is not just `quoteFor` again
 *
 * There is **no prorating**, and that cuts both ways in a way a single quote
 * cannot express:
 *
 *  - a branch or chargeable staff account added mid-period costs the **whole**
 *    month, immediately;
 *  - removing one refunds **nothing** — the reduction lands at the next
 *    renewal.
 *
 * So the current period's assessed components only ever go **up**. The period
 * snapshot remembers the high-water mark of what has been charged, and this
 * function takes the larger of that and today's size. Recomputing from today's
 * size alone would silently refund a shop that disabled somebody on the 20th,
 * which is exactly the behaviour the no-prorating rule forbids.
 *
 * Reactivating an already-assessed subject does not charge twice, because the
 * high-water mark already contains it — the maximum of a number and itself is
 * itself.
 *
 * A branch added mid-period raises the included pool for the NEXT renewal, but
 * it must not retroactively refund an extra-staff charge already assessed. That
 * falls out of taking the maximum of the assessed *fees*, not of the counts.
 */
export interface AssessedPeriod {
  /** The largest branch fee assessed so far this period. */
  assessedBranchFee: number;
  /** The largest staff fee assessed so far this period. */
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
  plan: PlanPricing = STANDARD_PLAN_V1,
): PeriodAssessment {
  const q = quoteFor(size, plan);

  const priorBranch = whole(prior.assessedBranchFee);
  const priorStaff = whole(prior.assessedStaffFee);

  // The high-water mark, component by component. Taken per component rather
  // than on the total, so a branch added late cannot mask a staff charge that
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
 * the number that goes **down** when somebody is disabled or a branch is
 * archived, and saying so plainly is the whole reason it is reported separately
 * from the current period.
 */
export function nextRenewalEstimate(size: CompanySize, plan: PlanPricing = STANDARD_PLAN_V1): Quote {
  return quoteFor(size, plan);
}
