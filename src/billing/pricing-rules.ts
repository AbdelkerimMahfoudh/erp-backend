import type { Activity } from '../entitlement/activity';

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
 * ## The formula (docs/21, 2026-10-05; activities D154, 2026-10-08)
 *
 *     for each active branch:
 *       activityFee   = { electronics: 500, money_agent: 300, both: 700 }[activity]
 *     branchFee     = Σ activityFee                       (was activeBranchCount × 500)
 *     for each store:
 *       includedSeats = 1                       the Owner never counts
 *       paidSeats     = seats bought for THIS store, 100 MRU each per month
 *       grantedSeats  = seats held without a charge (the transition, or a grant)
 *       seatFee       = paidSeats × 100
 *     staffFee      = Σ seatFee
 *     monthlyTotal  = branchFee + staffFee
 *
 * **A branch is priced by its activity** (docs/73 §3). `both` is a price of its
 * own, never 500 + 300. An upgrade during a paid month costs the difference at
 * once — `activityChange` says how much; a downgrade waits for the next
 * renewal and refunds nothing. The seat rules below are untouched by it.
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
  /** MRU per active electronics store per month. */
  branchMonthly: number;
  /** MRU per money services agent branch per month (D154). */
  agentMonthly: number;
  /** MRU per branch doing both per month (D154). A price of its own, never the sum. */
  bothMonthly: number;
  /** Included staff seats per store. One, since 2026-10-05. */
  includedStaffPerBranch: number;
  /** MRU per additional seat per store per month. */
  extraStaffMonthly: number;
}

/**
 * The launch price: two included staff per branch, pooled company-wide. Kept so
 * a period opened under it still re-prices. The two activity prices are the
 * figures migration 0088 backfilled onto its row — no branch of that era was
 * anything but electronics, so they priced nothing.
 */
export const STANDARD_PLAN_V1: PlanPricing = {
  branchMonthly: 500,
  agentMonthly: 300,
  bothMonthly: 700,
  includedStaffPerBranch: 2,
  extraStaffMonthly: 100,
};

/** The approved rule of 2026-10-05: one included seat per store, 100 MRU per additional seat per store. */
export const STANDARD_PLAN_V2: PlanPricing = {
  branchMonthly: 500,
  agentMonthly: 300,
  bothMonthly: 700,
  includedStaffPerBranch: 1,
  extraStaffMonthly: 100,
};

/**
 * The approved rule of 2026-10-08 (D154, docs/73 §3): the three activity prices,
 * in force from migration 0088; the seat terms of version 2 untouched.
 */
export const STANDARD_PLAN_V3: PlanPricing = {
  branchMonthly: 500,
  agentMonthly: 300,
  bothMonthly: 700,
  includedStaffPerBranch: 1,
  extraStaffMonthly: 100,
};

export const CURRENT_PLAN: PlanPricing = STANDARD_PLAN_V3;

/** The prices an activity needs — a plan, a plan version, or a period's copied figures. */
export type ActivityPrices = Pick<PlanPricing, 'branchMonthly' | 'agentMonthly' | 'bothMonthly'>;

/**
 * What one branch pays per month for its activity.
 *
 * A value that is none of the three prices as electronics — the activity every
 * branch before 0088 carries and the column's default — so a corrupted row is
 * billed as it always was rather than for nothing or for a crash. (The route
 * gate, by contrast, fails closed on the same value: `activity.ts`.)
 */
export function activityFee(activity: Activity, plan: ActivityPrices = CURRENT_PLAN): number {
  switch (activity) {
    case 'money_agent':
      return whole(plan.agentMonthly);
    case 'both':
      return whole(plan.bothMonthly);
    default:
      return whole(plan.branchMonthly);
  }
}

export type ActivityChangeKind = 'upgrade' | 'downgrade' | 'unchanged';

/** What changing a branch's activity means for the invoice (docs/73 §3.2). */
export interface ActivityChange {
  from: Activity;
  to: Activity;
  kind: ActivityChangeKind;
  /** What the branch pays per month now, and what it would pay at the new activity. */
  feeFrom: number;
  feeTo: number;
  /**
   * Charged at once for an upgrade — the difference, this period, less what a replacement's credit already covers
   * (D158, `upgradeDue`). Zero otherwise.
   */
  amountNow: number;
  /** When it takes effect: an upgrade now, a downgrade at the next renewal. Null when nothing changes. */
  effective: 'now' | 'renewal' | null;
}

/**
 * An upgrade is a change priced higher; a downgrade one priced lower — including
 * the sideways changes (D154 b): electronics → money_agent is 500 → 300 and
 * waits for the renewal; money_agent → electronics is 300 → 500 and costs 200
 * now. The price decides, not the names.
 *
 * A change between two activities priced the same costs nothing, and a charge
 * of nothing has nothing to confirm, so it lands at the renewal like any other
 * free change. The approved prices never produce one; a later plan version
 * could.
 *
 * `credit` is what this period already paid for the branch's location when the
 * branch replaced a store archived in it (D158): an upgrade is then charged
 * only what the credit does not cover, and may cost nothing at all. It is still
 * an upgrade — a dearer activity, in force now — not a free change waiting for
 * the renewal.
 */
export function activityChange(
  from: Activity,
  to: Activity,
  plan: ActivityPrices = CURRENT_PLAN,
  credit = 0,
): ActivityChange {
  const feeFrom = activityFee(from, plan);
  const feeTo = activityFee(to, plan);
  if (from === to) {
    return { from, to, kind: 'unchanged', feeFrom, feeTo, amountNow: 0, effective: null };
  }
  const difference = feeTo - feeFrom;
  if (difference > 0) {
    return { from, to, kind: 'upgrade', feeFrom, feeTo, amountNow: upgradeDue(feeFrom, feeTo, credit), effective: 'now' };
  }
  return { from, to, kind: 'downgrade', feeFrom, feeTo, amountNow: 0, effective: 'renewal' };
}

/**
 * What an upgrade costs this period when the branch carries a credit (D158):
 * what the branch would be charged at the new fee less what it is charged at
 * the old one, each `max(0, fee − credit)`. A store that replaced a 700 one as a
 * 500 store and becomes a 700 one owes nothing — its location was paid for;
 * with no credit it is the plain difference.
 */
export function upgradeDue(feeFrom: number, feeTo: number, credit = 0): number {
  const c = whole(credit);
  return Math.max(0, Math.max(0, whole(feeTo) - c) - Math.max(0, whole(feeFrom) - c));
}

/**
 * Replacing a store archived during a paid period (D158, docs/73 §11.1).
 *
 * The owner's decisions: a store that replaces one archived in the same paid
 * period costs no second base fee when it is the same activity or a cheaper
 * one (B2); a dearer one costs only the difference (B3); a store added while
 * the old one still runs is a second store and pays in full (B4).
 *
 * A **slot** is the place an archived store left: a branch billed this period
 * that is no longer active and that no replacement has taken. Its value is what
 * the period already paid for that location — the archived branch's own
 * assessed fee, or, when it was itself a replacement, the credit it carried,
 * whichever is larger — so a chain of replacements never pays twice for one
 * location and never forgets what the first store paid.
 */
export interface ReplacementSlotChoice {
  /** The archived branch's id. */
  branchId: string;
  /** What this period already paid for its location (`replacementSlotValue`). */
  value: number;
}

/** What a slot is worth: the archived branch's assessed fee, or the credit it carried as a replacement, whichever is larger. */
export function replacementSlotValue(assessedFee: number, credit = 0): number {
  return Math.max(whole(assessedFee), whole(credit));
}

/**
 * Which slot a new store takes: the smallest that covers its fee in full — a
 * larger slot stays free for a dearer store — else the largest, the smallest
 * difference to pay. Ties go to the archived branch's id, so two reads of the
 * same slots always choose the same one. Null when there is none: the store is
 * priced in full.
 */
export function chooseReplacementSlot<T extends ReplacementSlotChoice>(slots: readonly T[], newFee: number): T | null {
  const fee = whole(newFee);
  const byId = (a: T, b: T): number => (a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0);
  const covering = slots.filter((s) => whole(s.value) >= fee).sort((a, b) => whole(a.value) - whole(b.value) || byId(a, b));
  if (covering.length > 0) return covering[0];
  const largest = [...slots].sort((a, b) => whole(b.value) - whole(a.value) || byId(a, b));
  return largest[0] ?? null;
}

/** What a new store pays to take a slot: what its fee exceeds what the location already paid. Never negative. */
export function replacementDue(newFee: number, slot: number): number {
  return Math.max(0, whole(newFee) - whole(slot));
}

/** One store, as the price sees it. */
export interface BranchSize {
  /** Null for a hypothetical store in a public estimate. */
  branchId: string | null;
  name: string;
  /** What the branch is subscribed to. Absent reads as `electronics` — what every branch before 0088 is. */
  activity?: Activity;
  /** A downgrade waiting for the next renewal, when one is scheduled. Prices the renewal estimate, nothing else. */
  activityNext?: Activity | null;
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

/** One store's activity and seats, priced. */
export interface BranchQuoteLine {
  branchId: string | null;
  name: string;
  activity: Activity;
  /** What this branch's activity costs per month. */
  activityFee: number;
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
  agentMonthly: number;
  bothMonthly: number;
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
  /** Σ of every line's activity fee. */
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
    const activity = b.activity ?? 'electronics';
    const staffCount = whole(b.staffCount);
    const paidSeats = whole(b.paidSeats);
    const grantedSeats = whole(b.grantedSeats);
    const seatLimit = includedSeats + paidSeats + grantedSeats;
    return {
      branchId: b.branchId,
      name: b.name,
      activity,
      activityFee: activityFee(activity, plan),
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

  // The lines ARE the active branches: each is priced by its own activity.
  const branchFee = lines.reduce((n, l) => n + l.activityFee, 0);
  const staffFee = lines.reduce((n, l) => n + l.seatFee, 0);

  return {
    branchMonthly: plan.branchMonthly,
    agentMonthly: plan.agentMonthly,
    bothMonthly: plan.bothMonthly,
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
 * `staffPerStore` is the number of non-Owner employees at each store, and
 * `activities` what each store would do (electronics when not said). Every
 * employee beyond the included seat is one paid seat at that store; nothing
 * pools across stores. A person who would work at two stores is listed at
 * both, which is exactly how they would be seated.
 */
export function estimateFor(
  staffPerStore: readonly number[],
  plan: PlanPricing = CURRENT_PLAN,
  activities: readonly Activity[] = [],
): Quote {
  const includedSeats = whole(plan.includedStaffPerBranch);
  const branches: BranchSize[] = staffPerStore.map((n, i) => {
    const staffCount = whole(n);
    return {
      branchId: null,
      name: `Store ${i + 1}`,
      activity: activities[i] ?? 'electronics',
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
 *
 * ## The branch fee is remembered branch by branch (D154)
 *
 * An activity upgrade costs its branch the difference, and that difference has
 * to be the branch's own: a shop that archived a 500 store on the 10th and
 * upgrades its agent branch to `both` on the 12th owes 400 more, not nothing.
 * A single company-wide maximum could not say that — the archived store's fee
 * would quietly absorb the upgrade — so the snapshot keeps each branch's
 * high-water mark, and a branch that leaves mid-period keeps the fee it was
 * assessed at (nothing is refunded). A period opened before this existed has
 * no map; it starts one from today's lines, which reads exactly as before.
 *
 * ## A replacement is charged only what its location was not paid (D158)
 *
 * A store that took the slot of one archived this period carries a credit —
 * what the period had already paid for that location. Each branch is charged
 * its high-water mark less its credit, never below zero, so the archived
 * store's fee and its replacement's are not both charged in full. The map
 * itself keeps every branch's whole mark: a credit lowers what a branch is
 * charged, never what it was assessed at. The plain quote of the branches
 * active now stays a floor: an archived store brought back while its
 * replacement runs is two stores at once, and both are charged in full (B4).
 * With no credits every figure is exactly what it was before.
 */
export interface AssessedPeriod {
  /** The largest store fee assessed so far this period. */
  assessedBranchFee: number;
  /** The largest seat fee assessed so far this period. */
  assessedStaffFee: number;
  /** The fee each branch was assessed at this period, by branch id. Absent for a period opened before 0088. */
  assessedActivityFeeByBranch?: Readonly<Record<string, number>> | null;
}

export interface PeriodAssessment extends Quote {
  /** What was already locked in before this recalculation. */
  previouslyAssessedBranchFee: number;
  previouslyAssessedStaffFee: number;
  /** The amount actually owed for this period — never below what was assessed. */
  assessedBranchFee: number;
  assessedStaffFee: number;
  assessedTotal: number;
  /** Each branch's high-water mark this period, by branch id — a branch archived mid-period keeps its fee. */
  assessedActivityFeeByBranch: Record<string, number>;
  /** How much this recalculation added. Zero or positive, never negative. */
  addedThisPeriod: number;
}

/**
 * What this period already paid for each replacement store's location, by the
 * replacement's branch id (D158): the value of the slot it took.
 */
export type ReplacementCredits = Readonly<Record<string, number>>;

export function assessPeriod(
  size: CompanySize,
  prior: AssessedPeriod,
  plan: PlanPricing = CURRENT_PLAN,
  credits: ReplacementCredits = {},
): PeriodAssessment {
  const q = quoteFor(size, plan);

  const priorBranch = whole(prior.assessedBranchFee);
  const priorStaff = whole(prior.assessedStaffFee);

  // Branch by branch: what was assessed stays, what grew is taken at its new
  // fee. Only real branches have an id; an estimate's hypothetical stores are
  // never assessed.
  const assessedActivityFeeByBranch: Record<string, number> = {};
  for (const [branchId, fee] of Object.entries(prior.assessedActivityFeeByBranch ?? {})) {
    assessedActivityFeeByBranch[branchId] = whole(fee);
  }
  for (const line of q.lines) {
    if (line.branchId === null) continue;
    assessedActivityFeeByBranch[line.branchId] = Math.max(
      assessedActivityFeeByBranch[line.branchId] ?? 0,
      line.activityFee,
    );
  }
  // What each branch is charged: its mark, less the credit a replacement carries for a location already paid for.
  const branchFeeByBranch = Object.entries(assessedActivityFeeByBranch).reduce(
    (n, [branchId, fee]) => n + Math.max(0, fee - whole(credits[branchId] ?? 0)),
    0,
  );

  // The high-water mark, component by component. Taken per component rather
  // than on the total, so a store added late cannot mask a seat charge that
  // was already assessed — the two are separate facts about the period.
  const assessedBranchFee = Math.max(priorBranch, q.branchFee, branchFeeByBranch);
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
    assessedActivityFeeByBranch,
    addedThisPeriod: Math.max(0, assessedTotal - priorTotal),
  };
}

/**
 * What the shop will owe at the next renewal.
 *
 * Today's size at today's plan, with no memory of the current period, and
 * every branch at the activity it will have THEN: a scheduled downgrade is
 * priced here and nowhere else until the renewal applies it. This is the
 * number that goes **down** when a seat is released, a store is archived or a
 * downgrade is scheduled, and saying so plainly is the whole reason it is
 * reported separately from the current period.
 */
export function nextRenewalEstimate(size: CompanySize, plan: PlanPricing = CURRENT_PLAN): Quote {
  return quoteFor(
    {
      ...size,
      branches: (size.branches ?? []).map((b) => ({
        ...b,
        activity: b.activityNext ?? b.activity ?? 'electronics',
        activityNext: null,
      })),
    },
    plan,
  );
}
