import {
  activityChange,
  activityFee,
  assessPeriod,
  chooseReplacementSlot,
  CURRENT_PLAN,
  estimateFor,
  nextRenewalEstimate,
  quoteFor,
  replacementDue,
  replacementSlotValue,
  STANDARD_PLAN_V1,
  STANDARD_PLAN_V2,
  STANDARD_PLAN_V3,
  upgradeDue,
  type AssessedPeriod,
  type BranchSize,
  type CompanySize,
} from './pricing-rules';
import type { Activity } from '../entitlement/activity';

/**
 * The approved rule of 2026-10-05 (docs/21): 500 MRU per store per month, one
 * included staff seat per store, 100 MRU per additional seat per store, charged
 * in full. The Owner never counts; a person at two stores holds a seat at each.
 *
 * And of 2026-10-08 (D154, docs/73 §3): a branch is priced by its activity —
 * electronics 500, money services agent 300, both 700 (never the sum); an
 * upgrade costs the difference at once, a downgrade waits for the renewal.
 */

function store(name: string, staffCount: number, paidSeats = 0, grantedSeats = 0, activity: Activity = 'electronics') {
  return { branchId: `b-${name}`, name, staffCount, paidSeats, grantedSeats, activity };
}

function company(...stores: BranchSize[]): CompanySize {
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

describe('a branch is priced by its activity (D154, docs/73 §3)', () => {
  it('plan version 3 carries the approved figures, and is the plan in force; the earlier versions keep theirs', () => {
    expect(STANDARD_PLAN_V3).toEqual({
      branchMonthly: 500,
      agentMonthly: 300,
      bothMonthly: 700,
      includedStaffPerBranch: 1,
      extraStaffMonthly: 100,
    });
    expect(CURRENT_PLAN).toBe(STANDARD_PLAN_V3);
    // Migration 0088 backfilled the agent and both prices onto the older rows
    // so a period opened under them still re-prices with its own figures.
    expect(STANDARD_PLAN_V1).toMatchObject({ includedStaffPerBranch: 2, agentMonthly: 300, bothMonthly: 700 });
    expect(STANDARD_PLAN_V2).toMatchObject({ includedStaffPerBranch: 1, agentMonthly: 300, bothMonthly: 700 });
  });

  it('both is a price of its own, never 500 + 300', () => {
    expect(activityFee('electronics')).toBe(500);
    expect(activityFee('money_agent')).toBe(300);
    expect(activityFee('both')).toBe(700);
    expect(activityFee('both')).not.toBe(activityFee('electronics') + activityFee('money_agent'));
  });

  it('a value that is none of the three is billed as electronics — the column default — never as nothing', () => {
    expect(activityFee('' as Activity)).toBe(500);
  });

  it('a branch that says nothing about its activity is an electronics store, as every branch before 0088', () => {
    const q = quoteFor({ activeBranchCount: 1, activeStaffCount: 0, branches: [{ branchId: 'b', name: 'Main', staffCount: 0, paidSeats: 0, grantedSeats: 0 }] });
    expect(q.lines[0]).toMatchObject({ activity: 'electronics', activityFee: 500 });
    expect(q.branchFee).toBe(500);
  });

  it('the quote itemises every branch with its activity and its fee, and carries the three prices', () => {
    const q = quoteFor(company(store('Centre', 0), store('Kiosk', 0, 0, 0, 'money_agent'), store('Market', 0, 0, 0, 'both')));
    expect(q.lines.map((l) => [l.name, l.activity, l.activityFee])).toEqual([
      ['Centre', 'electronics', 500],
      ['Kiosk', 'money_agent', 300],
      ['Market', 'both', 700],
    ]);
    expect(q.branchFee).toBe(1500);
    expect(q).toMatchObject({ branchMonthly: 500, agentMonthly: 300, bothMonthly: 700 });
  });

  /** docs/73 §3.3, the eleven worked examples, integer MRU. */
  describe('the eleven worked examples', () => {
    const none = { assessedBranchFee: 0, assessedStaffFee: 0 };
    const agent = (name: string, staff = 0, paid = 0) => store(name, staff, paid, 0, 'money_agent');
    const both = (name: string, staff = 0, paid = 0) => store(name, staff, paid, 0, 'both');

    it.each([
      ['one electronics store, Owner alone', company(store('Main', 0)), 500],
      ['one money-agent branch, Owner alone', company(agent('Counter')), 300],
      ['one money-agent branch, two employees', company(agent('Counter', 2, 1)), 400],
      ['one combined branch', company(both('Main')), 700],
      ['an electronics store and an agent branch', company(store('Main', 0), agent('Counter')), 800],
      ['the same, one extra seat at the agent branch', company(store('Main', 0), agent('Counter', 2, 1)), 900],
      ['a warehouse: electronics by default, as billed today', company(store('Depot', 0)), 500],
    ] as const)('%s → %i', (_label, size, monthly) => {
      expect(quoteFor(size).monthlyTotal).toBe(monthly);
    });

    it('agent → both on the 12th of a paid month: +400 now, 700 from the renewal', () => {
      const change = activityChange('money_agent', 'both');
      expect(change).toMatchObject({ kind: 'upgrade', amountNow: 400, effective: 'now', feeFrom: 300, feeTo: 700 });
      // The period's assessed branch fee rises 300 → 700 when the upgrade is confirmed.
      const period = assessPeriod(company(agent('Counter')), none);
      const after = assessPeriod(company(both('Counter')), period);
      expect(period.assessedBranchFee).toBe(300);
      expect(after.assessedBranchFee).toBe(700);
      expect(after.addedThisPeriod).toBe(400);
      expect(nextRenewalEstimate(company(both('Counter'))).monthlyTotal).toBe(700);
    });

    it('electronics → both on the 12th: +200 now, 700 from the renewal', () => {
      expect(activityChange('electronics', 'both')).toMatchObject({ kind: 'upgrade', amountNow: 200, effective: 'now' });
      const period = assessPeriod(company(store('Main', 0)), none);
      const after = assessPeriod(company(both('Main')), period);
      expect(after.assessedBranchFee).toBe(700);
      expect(after.addedThisPeriod).toBe(200);
    });

    it('both → agent on the 20th: 0 now; 300 from the renewal; 700 stays assessed this period', () => {
      expect(activityChange('both', 'money_agent')).toMatchObject({ kind: 'downgrade', amountNow: 0, effective: 'renewal' });
      const period = assessPeriod(company(both('Main')), none);
      // The branch stays `both` this period and carries the scheduled change; the assessment does not move.
      const scheduled = company({ ...both('Main'), activityNext: 'money_agent' });
      const after = assessPeriod(scheduled, period);
      expect(after.assessedBranchFee).toBe(700);
      expect(after.addedThisPeriod).toBe(0);
      // Only the renewal estimate prices the branch at what it will be then.
      expect(nextRenewalEstimate(scheduled).monthlyTotal).toBe(300);
      expect(quoteFor(scheduled).monthlyTotal).toBe(700);
    });

    it('both → agent on the 5th, then agent → both on the 25th: 0, then +400 — the downgrade is cancelled, nothing refunded', () => {
      // The pure prices: a downgrade costs nothing now; the later upgrade is priced as the difference.
      expect(activityChange('both', 'money_agent').amountNow).toBe(0);
      expect(activityChange('money_agent', 'both').amountNow).toBe(400);
      // The period assessed at 700 never goes down for the scheduled downgrade and never pays twice for the cancellation.
      const period = assessPeriod(company(both('Main')), none);
      const scheduled = assessPeriod(company({ ...both('Main'), activityNext: 'money_agent' }), period);
      const cancelled = assessPeriod(company(both('Main')), scheduled);
      expect(cancelled.assessedBranchFee).toBe(700);
      expect(cancelled.addedThisPeriod).toBe(0);
    });
  });

  it('the sideways changes are priced, not named: electronics → agent waits for the renewal, agent → electronics is 200 now (D154 b)', () => {
    expect(activityChange('electronics', 'money_agent')).toMatchObject({ kind: 'downgrade', amountNow: 0, effective: 'renewal' });
    expect(activityChange('money_agent', 'electronics')).toMatchObject({ kind: 'upgrade', amountNow: 200, effective: 'now' });
    expect(activityChange('both', 'electronics')).toMatchObject({ kind: 'downgrade', amountNow: 0 });
  });

  it('the same activity again is no change at all', () => {
    expect(activityChange('both', 'both')).toMatchObject({ kind: 'unchanged', amountNow: 0, effective: null });
  });

  it('a change between two activities priced the same costs nothing and waits for the renewal', () => {
    const flat = { ...STANDARD_PLAN_V3, agentMonthly: 500 };
    expect(activityChange('electronics', 'money_agent', flat)).toMatchObject({ kind: 'downgrade', amountNow: 0, effective: 'renewal' });
  });

  it('a historical period is priced with its own copied prices, not today\'s', () => {
    const cheaper = { ...STANDARD_PLAN_V3, agentMonthly: 200, bothMonthly: 600 };
    expect(quoteFor(company(store('A', 0, 0, 0, 'money_agent'), store('B', 0, 0, 0, 'both')), cheaper).branchFee).toBe(800);
    expect(activityChange('money_agent', 'both', cheaper).amountNow).toBe(400);
  });
});

describe('the period remembers each branch\'s fee (D154: an upgrade\'s difference is the branch\'s own)', () => {
  const none = { assessedBranchFee: 0, assessedStaffFee: 0 };

  it('writes each real branch\'s fee into the map at the first assessment; hypothetical stores never', () => {
    const a = assessPeriod(company(store('Main', 0), store('Counter', 0, 0, 0, 'money_agent')), none);
    expect(a.assessedActivityFeeByBranch).toEqual({ 'b-Main': 500, 'b-Counter': 300 });
    const hypothetical = { branchId: null, staffCount: 0, paidSeats: 0, grantedSeats: 0 };
    const estimate = assessPeriod(
      { activeBranchCount: 2, activeStaffCount: 0, branches: [{ ...hypothetical, name: 'Store 1' }, { ...hypothetical, name: 'Store 2' }] },
      none,
    );
    expect(estimate.assessedActivityFeeByBranch).toEqual({});
    expect(estimate.assessedBranchFee).toBe(1000);
  });

  it('an upgrade after a store was archived still costs exactly its difference — the archived store\'s fee does not absorb it', () => {
    /*
     * The whole reason the map exists. A company-wide maximum reads 800 → 700
     * as "nothing to add", and the Owner who paid 400 for the upgrade would
     * have been charged nothing for it this period.
     */
    const opened = assessPeriod(company(store('Shop', 0), store('Counter', 0, 0, 0, 'money_agent')), none);
    expect(opened.assessedBranchFee).toBe(800);
    const archived = assessPeriod(company(store('Counter', 0, 0, 0, 'money_agent')), opened);
    expect(archived.assessedBranchFee).toBe(800);
    expect(archived.addedThisPeriod).toBe(0);
    const upgraded = assessPeriod(company(store('Counter', 0, 0, 0, 'both')), archived);
    expect(upgraded.assessedBranchFee).toBe(1200);
    expect(upgraded.addedThisPeriod).toBe(400);
    expect(upgraded.assessedActivityFeeByBranch).toEqual({ 'b-Shop': 500, 'b-Counter': 700 });
  });

  it('a store added beside an archived one with no replacement recorded costs its whole month: nothing was refunded for the one that left', () => {
    // No credit — no slot was taken (the store came after the period, or beside a store still running). A replacement
    // that took the slot carries a credit: see the D158 block below.
    const opened = assessPeriod(company(store('A', 0)), none);
    const replaced = assessPeriod(company(store('B', 0)), opened);
    expect(replaced.assessedBranchFee).toBe(1000);
    expect(replaced.addedThisPeriod).toBe(500);
  });

  it('a period opened before the map existed starts one from today\'s lines and reads exactly as before', () => {
    const old = { assessedBranchFee: 1000, assessedStaffFee: 0 };
    const a = assessPeriod(company(store('Main', 0)), old);
    expect(a.assessedBranchFee).toBe(1000);
    expect(a.addedThisPeriod).toBe(0);
    expect(a.assessedActivityFeeByBranch).toEqual({ 'b-Main': 500 });
    const b = assessPeriod(company(store('Main', 0)), { ...old, assessedActivityFeeByBranch: null });
    expect(b.assessedBranchFee).toBe(1000);
  });

  it('never lowers a branch\'s fee, whatever the map says today', () => {
    const prior = { assessedBranchFee: 700, assessedStaffFee: 0, assessedActivityFeeByBranch: { 'b-Main': 700 } };
    const a = assessPeriod(company(store('Main', 0, 0, 0, 'money_agent')), prior);
    expect(a.assessedActivityFeeByBranch).toEqual({ 'b-Main': 700 });
    expect(a.assessedBranchFee).toBe(700);
  });
});

describe('the applicant estimate takes an activity per store', () => {
  it('prices each store by what it would do, electronics when not said', () => {
    const q = estimateFor([0, 2, 1], CURRENT_PLAN, ['money_agent', 'both']);
    expect(q.lines.map((l) => [l.activity, l.activityFee, l.paidSeats])).toEqual([
      ['money_agent', 300, 0],
      ['both', 700, 1],
      ['electronics', 500, 0],
    ]);
    expect(q.branchFee).toBe(1500);
    expect(q.monthlyTotal).toBe(1600);
  });
});

/**
 * The owner's billing decisions of 2026-10-10 (D158, docs/73 §11.1): a store that takes the place of one archived in
 * the same paid period costs no second base fee when it is the same activity or cheaper (B2), only the difference when
 * dearer (B3); a store beside one still running pays in full (B4). Plan v3, one paid month running.
 */
describe('replacing an archived store in the same paid period (D158)', () => {
  const none = { assessedBranchFee: 0, assessedStaffFee: 0 };
  const at = (name: string, activity: Activity) => store(name, 0, 0, 0, activity);
  /** The one slot an archived branch leaves, valued from the period's map and any credit it carried itself. */
  const slotOf = (period: { assessedActivityFeeByBranch: Record<string, number> }, branchId: string, credit = 0) => ({
    branchId,
    value: replacementSlotValue(period.assessedActivityFeeByBranch[branchId], credit),
  });

  describe('the worked examples', () => {
    it.each([
      ['electronics A (500) archived; new electronics store', 'electronics', 'electronics', 0],
      ['both A (700) archived; new money-agent store — cheaper, nothing refunded', 'both', 'money_agent', 0],
      ['money-agent A (300) archived; new electronics store — dearer, the difference', 'money_agent', 'electronics', 200],
      ['money-agent A (300) archived; new both store', 'money_agent', 'both', 400],
    ] as const)('%s (%s → %s) → due %i', (_label, archived, replacement, due) => {
      const opened = assessPeriod(company(at('A', archived)), none);
      const slot = chooseReplacementSlot([slotOf(opened, 'b-A')], activityFee(replacement));
      expect(slot).toEqual({ branchId: 'b-A', value: activityFee(archived) });
      expect(replacementDue(activityFee(replacement), slot!.value)).toBe(due);
      // The period charges exactly what was due: the replacement's credit is the slot it took.
      const replaced = assessPeriod(company(at('N', replacement)), opened, CURRENT_PLAN, { 'b-N': slot!.value });
      expect(replaced.addedThisPeriod).toBe(due);
      expect(replaced.assessedBranchFee).toBe(Math.max(activityFee(archived), activityFee(replacement)));
      // Both locations stay in the map at their whole fee: a credit lowers the charge, never what was assessed.
      expect(replaced.assessedActivityFeeByBranch).toEqual({ 'b-A': activityFee(archived), 'b-N': activityFee(replacement) });
    });

    it('electronics A (500) still active; a new electronics store → 500: two stores at once (B4)', () => {
      const opened = assessPeriod(company(at('A', 'electronics')), none);
      // An active store is never a slot; with none, the new store is priced in full.
      expect(chooseReplacementSlot([], 500)).toBeNull();
      const both = assessPeriod(company(at('A', 'electronics'), at('N', 'electronics')), opened);
      expect(both.addedThisPeriod).toBe(500);
      expect(both.assessedBranchFee).toBe(1000);
    });

    it('A (700) archived; R an electronics store at 0; R later upgraded to both → 0: R’s credit of 700 covers 700', () => {
      const opened = assessPeriod(company(at('A', 'both')), none);
      const slot = chooseReplacementSlot([slotOf(opened, 'b-A')], 500)!;
      expect(replacementDue(500, slot.value)).toBe(0);
      const credits = { 'b-R': slot.value };
      const replaced = assessPeriod(company(at('R', 'electronics')), opened, CURRENT_PLAN, credits);
      expect(replaced.addedThisPeriod).toBe(0);
      expect(activityChange('electronics', 'both', CURRENT_PLAN, slot.value)).toMatchObject({ kind: 'upgrade', amountNow: 0, effective: 'now' });
      const upgraded = assessPeriod(company(at('R', 'both')), replaced, CURRENT_PLAN, credits);
      expect(upgraded.addedThisPeriod).toBe(0);
      expect(upgraded.assessedBranchFee).toBe(700);
      expect(upgraded.assessedActivityFeeByBranch).toEqual({ 'b-A': 700, 'b-R': 700 });
    });

    it('the chain: A (300) archived; R electronics (200 paid); R archived; R2 both → 200, slot(R) = max(500, 300)', () => {
      const opened = assessPeriod(company(at('A', 'money_agent')), none);
      const slotA = chooseReplacementSlot([slotOf(opened, 'b-A')], 500)!;
      expect(replacementDue(500, slotA.value)).toBe(200);
      const r = assessPeriod(company(at('R', 'electronics')), opened, CURRENT_PLAN, { 'b-R': slotA.value });
      expect(r.assessedBranchFee).toBe(500);
      // R leaves in turn: what the period paid for its location is the larger of its own fee and the credit it carried.
      const slotR = chooseReplacementSlot([slotOf(r, 'b-R', slotA.value)], 700)!;
      expect(slotR.value).toBe(500);
      expect(replacementSlotValue(500, 300)).toBe(500);
      expect(replacementSlotValue(500, 700)).toBe(700);
      expect(replacementDue(700, slotR.value)).toBe(200);
      const r2 = assessPeriod(company(at('R2', 'both')), r, CURRENT_PLAN, { 'b-R': slotA.value, 'b-R2': slotR.value });
      expect(r2.addedThisPeriod).toBe(200);
      // 300 + 200 + 200: the period charged exactly one location, at the dearest activity it ever had.
      expect(r2.assessedBranchFee).toBe(700);
    });

    it('two store requests at once, one 500 slot: one takes it at 0, the other pays 500 (B6)', () => {
      const opened = assessPeriod(company(at('A', 'electronics')), none);
      const first = chooseReplacementSlot([slotOf(opened, 'b-A')], 500)!;
      expect(replacementDue(500, first.value)).toBe(0);
      // Taken by the first, the slot is gone for the second.
      expect(chooseReplacementSlot([], 500)).toBeNull();
      const after = assessPeriod(company(at('N1', 'electronics'), at('N2', 'electronics')), opened, CURRENT_PLAN, { 'b-N1': first.value });
      expect(after.addedThisPeriod).toBe(500);
      expect(after.assessedBranchFee).toBe(1000);
    });

    it('a slot reserved when the period renews: the next period never billed A, so it offers no slot', () => {
      // The renewal opens the next period from the active branches alone (`openPeriod`), so A is not in its map.
      const next = assessPeriod(company(at('Main', 'electronics')), none);
      expect(Object.keys(next.assessedActivityFeeByBranch)).toEqual(['b-Main']);
    });
  });

  it('chooses the smallest slot that covers the fee in full, else the largest; ties by the archived branch’s id', () => {
    const slots = [
      { branchId: 'b-3', value: 700 },
      { branchId: 'b-2', value: 300 },
      { branchId: 'b-1', value: 500 },
      { branchId: 'b-0', value: 500 },
    ];
    expect(chooseReplacementSlot(slots, 300)?.branchId).toBe('b-2');
    // Two 500 slots cover a 500 store: the first by id, the 700 one kept for a dearer store.
    expect(chooseReplacementSlot(slots, 500)?.branchId).toBe('b-0');
    expect(chooseReplacementSlot(slots, 600)?.branchId).toBe('b-3');
    // Nothing covers 900: the largest, the smallest difference to pay.
    expect(chooseReplacementSlot(slots, 900)?.branchId).toBe('b-3');
    expect(chooseReplacementSlot(slots.filter((x) => x.value < 700), 900)?.branchId).toBe('b-0');
    expect(chooseReplacementSlot([], 500)).toBeNull();
    // The caller's list is read, never reordered.
    expect(slots.map((x) => x.branchId)).toEqual(['b-3', 'b-2', 'b-1', 'b-0']);
  });

  it('a difference is never negative, and a slot never worth less than either of its figures', () => {
    for (const fee of [0, 300, 500, 700]) {
      for (const slot of [0, 300, 500, 700, 900]) {
        expect(replacementDue(fee, slot)).toBe(Math.max(0, fee - slot));
        expect(replacementDue(fee, slot)).toBeGreaterThanOrEqual(0);
        expect(replacementSlotValue(fee, slot)).toBe(Math.max(fee, slot));
      }
    }
  });

  it('an upgrade with a credit costs max(0, fee(to) − c) − max(0, fee(from) − c); with none, the plain difference', () => {
    const activities: Activity[] = ['electronics', 'money_agent', 'both'];
    for (const from of activities) {
      for (const to of activities) {
        const plain = activityChange(from, to);
        expect(activityChange(from, to, CURRENT_PLAN, 0)).toEqual(plain);
        if (plain.kind === 'upgrade') expect(upgradeDue(plain.feeFrom, plain.feeTo)).toBe(plain.amountNow);
        for (const credit of [0, 300, 500, 700, 900]) {
          const change = activityChange(from, to, CURRENT_PLAN, credit);
          // The credit decides how much, never which way: a downgrade still waits for the renewal.
          expect(change.kind).toBe(plain.kind);
          if (change.kind === 'upgrade') {
            expect(change.amountNow).toBe(Math.max(0, change.feeTo - credit) - Math.max(0, change.feeFrom - credit));
            expect(change.amountNow).toBeLessThanOrEqual(plain.amountNow);
          } else {
            expect(change.amountNow).toBe(0);
          }
        }
      }
    }
    expect(upgradeDue(300, 700, 300)).toBe(400);
    expect(upgradeDue(500, 700, 300)).toBe(200);
    expect(upgradeDue(500, 700, 600)).toBe(100);
  });

  it('with no credits every figure is what it was: the earlier cases, assessed both ways, agree', () => {
    const cases: [CompanySize, AssessedPeriod][] = [
      [company(store('A', 0)), none],
      [company(store('A', 0), store('B', 0)), assessPeriod(company(store('A', 0)), none)],
      [company(store('A', 1, 1)), assessPeriod(company(store('A', 1)), none)],
      [company(store('A', 1, 0)), assessPeriod(company(store('A', 2, 1)), none)],
      [company(store('B', 0)), assessPeriod(company(store('A', 0)), none)],
      [company(store('Counter', 0, 0, 0, 'both')), assessPeriod(company(store('Shop', 0), store('Counter', 0, 0, 0, 'money_agent')), none)],
      [company(store('Main', 0)), { assessedBranchFee: 1000, assessedStaffFee: 0 }],
      [company(store('Main', 0)), { assessedBranchFee: 1000, assessedStaffFee: 0, assessedActivityFeeByBranch: null }],
      [company(store('Main', 0, 0, 0, 'money_agent')), { assessedBranchFee: 700, assessedStaffFee: 0, assessedActivityFeeByBranch: { 'b-Main': 700 } }],
      [company(store('Main', 3)), { assessedBranchFee: 500, assessedStaffFee: 100 }],
    ];
    for (const [size, prior] of cases) {
      expect(assessPeriod(size, prior, CURRENT_PLAN, {})).toEqual(assessPeriod(size, prior));
      // A credit for a branch the period never billed changes nothing either.
      expect(assessPeriod(size, prior, CURRENT_PLAN, { 'b-nowhere': 700 })).toEqual(assessPeriod(size, prior));
    }
  });

  it('never lower than before: every replacement sequence only ever raises the period, or leaves it', () => {
    const activities: Activity[] = ['electronics', 'money_agent', 'both'];
    let sequences = 0;
    for (const archived of activities) {
      for (const replacement of activities) {
        for (const upgradeTo of activities) {
          const opened = assessPeriod(company(at('Shop', 'electronics'), at('A', archived)), none);
          const slot = chooseReplacementSlot([slotOf(opened, 'b-A')], activityFee(replacement))!;
          const credits = { 'b-R': slot.value };
          const steps = [
            company(at('Shop', 'electronics'), at('R', replacement)),
            company(at('Shop', 'electronics'), at('R', activityFee(upgradeTo) > activityFee(replacement) ? upgradeTo : replacement)),
            // A brought back while R runs: two stores at once.
            company(at('Shop', 'electronics'), at('A', archived), at('R', replacement)),
            // And archived again: nothing refunded.
            company(at('Shop', 'electronics')),
          ];
          let acc: AssessedPeriod = opened;
          let last = opened.assessedTotal;
          for (const size of steps) {
            const a = assessPeriod(size, acc, CURRENT_PLAN, credits);
            expect(a.assessedTotal).toBeGreaterThanOrEqual(last);
            expect(a.addedThisPeriod).toBe(a.assessedTotal - last);
            last = a.assessedTotal;
            acc = a;
          }
          sequences += 1;
        }
      }
    }
    expect(sequences).toBe(27);
  });

  it('an archived store brought back while its replacement runs is charged in full by the plain-quote floor (B4)', () => {
    const opened = assessPeriod(company(at('A', 'electronics')), none);
    const credits = { 'b-R': 500 };
    const replaced = assessPeriod(company(at('R', 'electronics')), opened, CURRENT_PLAN, credits);
    expect(replaced.assessedBranchFee).toBe(500);
    const reactivated = assessPeriod(company(at('A', 'electronics'), at('R', 'electronics')), replaced, CURRENT_PLAN, credits);
    expect(reactivated.assessedBranchFee).toBe(1000);
    expect(reactivated.addedThisPeriod).toBe(500);
  });

  it('a credit larger than a branch’s fee charges that branch nothing, never less than nothing', () => {
    const opened = assessPeriod(company(at('A', 'both'), at('Shop', 'electronics')), none);
    const replaced = assessPeriod(company(at('R', 'money_agent'), at('Shop', 'electronics')), opened, CURRENT_PLAN, { 'b-R': 700 });
    // 700 (A) + 500 (Shop) + max(0, 300 − 700): the cheaper replacement is free, and the others are not discounted.
    expect(replaced.assessedBranchFee).toBe(1200);
    expect(replaced.addedThisPeriod).toBe(0);
  });
});
