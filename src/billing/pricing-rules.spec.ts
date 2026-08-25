import {
  assessPeriod,
  nextRenewalEstimate,
  quoteFor,
  STANDARD_PLAN_V1,
  type PlanPricing,
} from './pricing-rules';

/**
 * The approved pricing, pinned.
 *
 * Every figure in the brief appears here as its own case, because a formula
 * that is right in general and wrong at one boundary is still wrong for the
 * shop standing at that boundary.
 */

describe('the five approved examples', () => {
  const cases: [string, number, number, number][] = [
    ['1 branch, Owner only', 1, 0, 500],
    ['1 branch, Owner + 2 staff', 1, 2, 500],
    ['1 branch, Owner + 3 staff', 1, 3, 600],
    ['2 branches, Owner + 4 staff', 2, 4, 1000],
    ['2 branches, Owner + 5 staff', 2, 5, 1100],
  ];

  it.each(cases)('%s = %i MRU', (_label, branches, staff, expected) => {
    const q = quoteFor({ activeBranchCount: branches, activeStaffCount: staff });
    expect(q.monthlyTotal).toBe(expected);
    expect(q.currency).toBe('MRU');
  });

  it('and the breakdown adds up to the total in every one', () => {
    for (const [, branches, staff, expected] of cases) {
      const q = quoteFor({ activeBranchCount: branches, activeStaffCount: staff });
      expect(q.branchFee + q.staffFee).toBe(expected);
    }
  });
});

describe('who counts as staff', () => {
  /*
    The Owner never counts. The counting itself happens in the service — these
    cases pin the arithmetic that consumes it, which is where an off-by-one
    would turn into a real charge.
  */
  it('the Owner is not in the staff count, so a lone Owner pays the branch fee only', () => {
    expect(quoteFor({ activeBranchCount: 1, activeStaffCount: 0 }).monthlyTotal).toBe(500);
    expect(quoteFor({ activeBranchCount: 1, activeStaffCount: 0 }).staffFee).toBe(0);
  });

  it('the third staff member at a one-branch shop is the first chargeable one', () => {
    expect(quoteFor({ activeBranchCount: 1, activeStaffCount: 2 }).chargeableStaffCount).toBe(0);
    expect(quoteFor({ activeBranchCount: 1, activeStaffCount: 3 }).chargeableStaffCount).toBe(1);
  });

  it('the allowance is a company-wide pool, not two seats per branch', () => {
    /*
      A shop with two branches and four staff pays nothing extra however the
      people are distributed — all four at one branch, or two and two. Making
      the allowance per-branch would penalise the sensible arrangement.
    */
    expect(quoteFor({ activeBranchCount: 2, activeStaffCount: 4 }).staffFee).toBe(0);
    expect(quoteFor({ activeBranchCount: 2, activeStaffCount: 5 }).staffFee).toBe(100);
  });
});

describe('the arithmetic is integer MRU', () => {
  it('never produces a fraction', () => {
    for (let b = 0; b <= 12; b++) {
      for (let s = 0; s <= 30; s++) {
        const q = quoteFor({ activeBranchCount: b, activeStaffCount: s });
        expect(Number.isInteger(q.monthlyTotal)).toBe(true);
        expect(Number.isInteger(q.branchFee)).toBe(true);
        expect(Number.isInteger(q.staffFee)).toBe(true);
      }
    }
  });

  it('and refuses to be dragged negative or fractional by a bad count', () => {
    const q = quoteFor({ activeBranchCount: -3, activeStaffCount: 2.7 });
    expect(q.activeBranchCount).toBe(0);
    expect(q.activeStaffCount).toBe(2);
    expect(q.monthlyTotal).toBeGreaterThanOrEqual(0);
  });

  it('a company with nothing active owes nothing', () => {
    expect(quoteFor({ activeBranchCount: 0, activeStaffCount: 0 }).monthlyTotal).toBe(0);
  });
});

describe('there is no prorating, and it cuts both ways', () => {
  const none = { assessedBranchFee: 0, assessedStaffFee: 0 };

  it('a branch added mid-period costs the whole month immediately', () => {
    const start = assessPeriod({ activeBranchCount: 1, activeStaffCount: 0 }, none);
    expect(start.assessedTotal).toBe(500);

    const afterAdding = assessPeriod({ activeBranchCount: 2, activeStaffCount: 0 }, start);
    expect(afterAdding.assessedTotal).toBe(1000);
    expect(afterAdding.addedThisPeriod).toBe(500);
  });

  it('an extra staff account added mid-period costs the whole month immediately', () => {
    const start = assessPeriod({ activeBranchCount: 1, activeStaffCount: 2 }, none);
    const after = assessPeriod({ activeBranchCount: 1, activeStaffCount: 3 }, start);
    expect(after.assessedTotal).toBe(600);
    expect(after.addedThisPeriod).toBe(100);
  });

  it('removing a branch refunds nothing this period', () => {
    const two = assessPeriod({ activeBranchCount: 2, activeStaffCount: 0 }, none);
    const afterRemoval = assessPeriod({ activeBranchCount: 1, activeStaffCount: 0 }, two);
    expect(afterRemoval.assessedTotal).toBe(1000);
    expect(afterRemoval.addedThisPeriod).toBe(0);
  });

  it('disabling somebody refunds nothing this period', () => {
    const three = assessPeriod({ activeBranchCount: 1, activeStaffCount: 3 }, none);
    const after = assessPeriod({ activeBranchCount: 1, activeStaffCount: 2 }, three);
    expect(after.assessedTotal).toBe(600);
    expect(after.addedThisPeriod).toBe(0);
  });

  it('the assessed amount is monotonic across any sequence of changes', () => {
    let acc = { assessedBranchFee: 0, assessedStaffFee: 0 };
    let last = 0;
    const walk: [number, number][] = [
      [1, 0], [1, 3], [2, 3], [2, 7], [1, 7], [1, 2], [3, 2], [0, 0],
    ];
    for (const [b, s] of walk) {
      const a = assessPeriod({ activeBranchCount: b, activeStaffCount: s }, acc);
      expect(a.assessedTotal).toBeGreaterThanOrEqual(last);
      expect(a.addedThisPeriod).toBeGreaterThanOrEqual(0);
      last = a.assessedTotal;
      acc = { assessedBranchFee: a.assessedBranchFee, assessedStaffFee: a.assessedStaffFee };
    }
  });

  it('reactivating an already-assessed subject does not charge twice', () => {
    const three = assessPeriod({ activeBranchCount: 1, activeStaffCount: 3 }, none);
    const disabled = assessPeriod({ activeBranchCount: 1, activeStaffCount: 2 }, three);
    const reactivated = assessPeriod({ activeBranchCount: 1, activeStaffCount: 3 }, disabled);

    expect(reactivated.assessedTotal).toBe(600);
    expect(reactivated.addedThisPeriod).toBe(0);
  });

  it('a repeated assessment of an unchanged company adds nothing', () => {
    // A retried request must not double-charge.
    const first = assessPeriod({ activeBranchCount: 2, activeStaffCount: 5 }, none);
    const again = assessPeriod({ activeBranchCount: 2, activeStaffCount: 5 }, first);
    expect(again.assessedTotal).toBe(first.assessedTotal);
    expect(again.addedThisPeriod).toBe(0);
  });

  it('a branch added mid-period does NOT refund an extra-staff charge already assessed', () => {
    /*
      The subtle one. One branch with three staff has been charged 100 for the
      third. Adding a second branch raises the included pool to four, so a
      naive recalculation would price the staff fee at 0 — and hand back money
      the no-prorating rule says is not refundable.

      The high-water mark is taken per COMPONENT for exactly this reason.
    */
    const before = assessPeriod({ activeBranchCount: 1, activeStaffCount: 3 }, none);
    expect(before.assessedStaffFee).toBe(100);

    const after = assessPeriod({ activeBranchCount: 2, activeStaffCount: 3 }, before);
    expect(after.staffFee).toBe(0); // today's size alone would say zero
    expect(after.assessedStaffFee).toBe(100); // but it was already assessed
    expect(after.assessedTotal).toBe(1100);
    expect(after.addedThisPeriod).toBe(500);
  });

  it('but the larger allowance does apply at the next renewal', () => {
    const next = nextRenewalEstimate({ activeBranchCount: 2, activeStaffCount: 3 });
    expect(next.staffFee).toBe(0);
    expect(next.monthlyTotal).toBe(1000);
  });
});

describe('the next-renewal estimate is today, not this period', () => {
  it('goes down when a branch is archived', () => {
    expect(nextRenewalEstimate({ activeBranchCount: 2, activeStaffCount: 0 }).monthlyTotal).toBe(1000);
    expect(nextRenewalEstimate({ activeBranchCount: 1, activeStaffCount: 0 }).monthlyTotal).toBe(500);
  });

  it('goes down when staff are disabled', () => {
    expect(nextRenewalEstimate({ activeBranchCount: 1, activeStaffCount: 5 }).monthlyTotal).toBe(800);
    expect(nextRenewalEstimate({ activeBranchCount: 1, activeStaffCount: 2 }).monthlyTotal).toBe(500);
  });
});

describe('a historical period keeps its own prices', () => {
  it('re-pricing with the old plan is unaffected by a newer one', () => {
    /*
      The reason `quoteFor` takes the plan as an argument. A period priced under
      last year's numbers must stay priced that way however today's plan reads.
    */
    const oldPlan: PlanPricing = { branchMonthly: 400, includedStaffPerBranch: 2, extraStaffMonthly: 80 };
    const size = { activeBranchCount: 2, activeStaffCount: 5 };

    expect(quoteFor(size, oldPlan).monthlyTotal).toBe(880);
    expect(quoteFor(size, STANDARD_PLAN_V1).monthlyTotal).toBe(1100);
    // And the old figure has not moved.
    expect(quoteFor(size, oldPlan).monthlyTotal).toBe(880);
  });

  it('the standard plan is the approved one', () => {
    expect(STANDARD_PLAN_V1).toEqual({
      branchMonthly: 500,
      includedStaffPerBranch: 2,
      extraStaffMonthly: 100,
    });
  });
});
