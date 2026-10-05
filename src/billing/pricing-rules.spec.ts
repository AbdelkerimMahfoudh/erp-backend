import {
  assessPeriod,
  estimateFor,
  quoteFor,
  STANDARD_PLAN_V1,
  STANDARD_PLAN_V2,
  type CompanySize,
} from './pricing-rules';

/**
 * The approved rule of 2026-10-05 (docs/21): 500 MRU per store per month, one
 * included staff seat per store, 100 MRU per additional seat per store, charged
 * in full. The Owner never counts; a person at two stores holds a seat at each.
 */

function store(name: string, staffCount: number, paidSeats = 0, grantedSeats = 0) {
  return { branchId: `b-${name}`, name, staffCount, paidSeats, grantedSeats };
}

function company(...stores: ReturnType<typeof store>[]): CompanySize {
  return {
    activeBranchCount: stores.length,
    activeStaffCount: stores.reduce((n, s) => n + s.staffCount, 0),
    branches: stores,
  };
}

describe('one store', () => {
  it('a lone Owner pays the store fee only', () => {
    const q = quoteFor(company(store('Main', 0)));
    expect(q.branchFee).toBe(500);
    expect(q.staffFee).toBe(0);
    expect(q.monthlyTotal).toBe(500);
  });

  it('the first employee is included', () => {
    const q = quoteFor(company(store('Main', 1)));
    expect(q.monthlyTotal).toBe(500);
    expect(q.lines[0].seatsAvailable).toBe(0);
    expect(q.lines[0].overLimit).toBe(false);
  });

  it('the second employee needs a paid seat, and the paid seat is what is charged', () => {
    const q = quoteFor(company(store('Main', 2, 1)));
    expect(q.paidSeatCount).toBe(1);
    expect(q.chargeableStaffCount).toBe(1);
    expect(q.staffFee).toBe(100);
    expect(q.monthlyTotal).toBe(600);
  });

  it('a seat bought and not yet filled is still charged — it is held', () => {
    const q = quoteFor(company(store('Main', 1, 1)));
    expect(q.staffFee).toBe(100);
    expect(q.lines[0].seatsAvailable).toBe(1);
  });
});

describe('seats belong to a store', () => {
  it('two stores with one employee each pay nothing for staff', () => {
    expect(quoteFor(company(store('A', 1), store('B', 1))).monthlyTotal).toBe(1000);
  });

  it('two employees at one store and none at the other is NOT pooled: the second seat is paid', () => {
    const q = quoteFor(company(store('A', 2, 1), store('B', 0)));
    expect(q.staffFee).toBe(100);
    expect(q.monthlyTotal).toBe(1100);
    expect(q.lines.map((l) => l.seatFee)).toEqual([100, 0]);
  });

  it('a person working at two stores holds one seat at each and is never double-counted within a store', () => {
    // The census counts distinct people per store; the same person appears in both lines.
    const shared = quoteFor(company(store('A', 1), store('B', 1)));
    expect(shared.activeStaffCount).toBe(2);
    expect(shared.staffFee).toBe(0);
    const second = quoteFor(company(store('A', 2, 1), store('B', 2, 1)));
    expect(second.staffFee).toBe(200);
  });

  it('the quote itemises every store', () => {
    const q = quoteFor(company(store('Centre', 3, 2), store('Market', 1)));
    expect(q.lines).toEqual([
      expect.objectContaining({
        name: 'Centre',
        staffCount: 3,
        includedSeats: 1,
        paidSeats: 2,
        seatLimit: 3,
        seatFee: 200,
        overLimit: false,
      }),
      expect.objectContaining({
        name: 'Market',
        staffCount: 1,
        includedSeats: 1,
        paidSeats: 0,
        seatLimit: 1,
        seatFee: 0,
        overLimit: false,
      }),
    ]);
    expect(q.includedStaffCount).toBe(2);
  });
});

describe('the transition keeps its promises', () => {
  it('staff who predate the rule are carried as granted seats: nothing charged, nobody over the limit', () => {
    const q = quoteFor(company(store('Main', 3, 0, 2)));
    expect(q.grantedSeatCount).toBe(2);
    expect(q.staffFee).toBe(0);
    expect(q.lines[0].overLimit).toBe(false);
    expect(q.lines[0].seatsAvailable).toBe(0);
  });

  it('a store with more people than seats is reported over the limit and still not charged by the quote', () => {
    const q = quoteFor(company(store('Main', 3)));
    expect(q.lines[0].overLimit).toBe(true);
    expect(q.staffFee).toBe(0);
  });

  it('a period assessed under the pooled rule keeps its assessed fee when the rule changes', () => {
    // Under the launch plan, three staff at one branch were one chargeable account: 100.
    const pooled = { assessedBranchFee: 500, assessedStaffFee: 100 };
    // Re-assessed with no paid seats under today's size: the high-water mark holds.
    const after = assessPeriod(company(store('Main', 3)), pooled, STANDARD_PLAN_V2);
    expect(after.assessedStaffFee).toBe(100);
    expect(after.addedThisPeriod).toBe(0);
  });
});

describe('the applicant estimate', () => {
  it('prices each store with every employee beyond the included one as a paid seat', () => {
    const q = estimateFor([2, 1, 0]);
    expect(q.activeBranchCount).toBe(3);
    expect(q.branchFee).toBe(1500);
    expect(q.paidSeatCount).toBe(1);
    expect(q.staffFee).toBe(100);
    expect(q.monthlyTotal).toBe(1600);
    expect(q.lines.map((l) => l.paidSeats)).toEqual([1, 0, 0]);
  });

  it('the five worked examples', () => {
    expect(estimateFor([0]).monthlyTotal).toBe(500);
    expect(estimateFor([1]).monthlyTotal).toBe(500);
    expect(estimateFor([2]).monthlyTotal).toBe(600);
    expect(estimateFor([1, 1]).monthlyTotal).toBe(1000);
    expect(estimateFor([3, 2]).monthlyTotal).toBe(1300);
  });
});

describe('the arithmetic is integer MRU', () => {
  it('never produces a fraction', () => {
    for (let b = 0; b <= 6; b++) {
      for (let s = 0; s <= 10; s++) {
        const q = quoteFor(company(...Array.from({ length: b }, (_, i) => store(`S${i}`, s, Math.max(0, s - 1)))));
        for (const v of [q.branchFee, q.staffFee, q.monthlyTotal]) expect(Number.isInteger(v)).toBe(true);
        expect(q.monthlyTotal).toBe(q.branchFee + q.staffFee);
      }
    }
  });

  it('refuses to be dragged negative or fractional by a bad count', () => {
    const q = quoteFor({ activeBranchCount: -3, activeStaffCount: 2.7, branches: [store('Main', -1, 2.9)] });
    expect(q.activeBranchCount).toBe(0);
    expect(q.activeStaffCount).toBe(2);
    expect(q.lines[0].staffCount).toBe(0);
    expect(q.lines[0].paidSeats).toBe(2);
  });

  it('a company with nothing active owes nothing', () => {
    expect(quoteFor(company()).monthlyTotal).toBe(0);
  });

  it('the launch plan is still re-priceable for a period opened under it', () => {
    const q = quoteFor(company(store('Main', 3, 1)), STANDARD_PLAN_V1);
    expect(q.includedSeatsPerStore).toBe(2);
    expect(q.staffFee).toBe(100);
  });
});

describe('there is no prorating, and it cuts both ways', () => {
  const none = { assessedBranchFee: 0, assessedStaffFee: 0 };

  it('a store added mid-period costs the whole month immediately', () => {
    const start = assessPeriod(company(store('A', 0)), none);
    expect(start.assessedTotal).toBe(500);
    const afterAdding = assessPeriod(company(store('A', 0), store('B', 0)), start);
    expect(afterAdding.assessedTotal).toBe(1000);
    expect(afterAdding.addedThisPeriod).toBe(500);
  });

  it('a seat confirmed mid-period costs the whole month immediately', () => {
    const start = assessPeriod(company(store('A', 1)), none);
    const after = assessPeriod(company(store('A', 1, 1)), start);
    expect(after.assessedStaffFee).toBe(100);
    expect(after.addedThisPeriod).toBe(100);
  });

  it('releasing a seat refunds nothing this period', () => {
    const held = assessPeriod(company(store('A', 2, 1)), none);
    const after = assessPeriod(company(store('A', 1, 0)), held);
    expect(after.assessedStaffFee).toBe(100);
    expect(after.addedThisPeriod).toBe(0);
  });

  it('archiving a store refunds nothing this period', () => {
    const two = assessPeriod(company(store('A', 0), store('B', 0)), none);
    const after = assessPeriod(company(store('A', 0)), two);
    expect(after.assessedBranchFee).toBe(1000);
  });

  it('the assessed amount is monotonic across any sequence of changes', () => {
    let acc = none;
    let last = 0;
    for (const [b, s] of [
      [1, 0],
      [2, 3],
      [1, 1],
      [3, 0],
      [1, 5],
      [2, 2],
    ] as const) {
      const a = assessPeriod(
        company(...Array.from({ length: b }, (_, i) => store(`S${i}`, s, Math.max(0, s - 1)))),
        acc,
      );
      expect(a.assessedTotal).toBeGreaterThanOrEqual(last);
      last = a.assessedTotal;
      acc = a;
    }
  });
});
