import {
  buildEntitlement,
  canRead,
  canWrite,
  complimentaryOf,
  daysRemaining,
  ENTITLEMENT_TRIAL_AVAILABLE,
  ENTITLEMENT_WRITE_BLOCKED,
  GRACE_MS,
  graceEndsAt,
  graceHoursRemaining,
  mayConsumeSeat,
  seatMath,
  INCLUDED_SEATS_PER_STORE,
  mayConsumeSeatIn,
  stateOf,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from './entitlement-rules';
import { displayTimeZone, type TrialFacts } from '../platform/trial/trial-rules';
import {
  isAllowedWhenExpired,
  isMutation,
  ALWAYS_ALLOWED,
  ALWAYS_READABLE,
  isAlwaysReadable,
} from './route-classification';

/**
 * Subscription entitlement (Milestone K).
 *
 * Every boundary is tested with an injected clock rather than by waiting: the
 * instant before a period ends, the instant after, and both ends of the 72-hour
 * grace. A billing boundary that is only ever tested in the middle of a period
 * is a billing boundary nobody has actually tested.
 */

const AUG_18 = new Date('2026-08-18T12:00:00.000Z');

const sub = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  subscribedBranchCount: 1,
  additionalSeats: 0,
  currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
  isComplimentary: false,
  complimentaryUntil: null,
  ...over,
});

describe('the state comes from the server clock', () => {
  it('is active while the period is running', () => {
    expect(stateOf(sub(), AUG_18)).toBe('active');
  });

  it('is still active in the last millisecond of the period', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    expect(stateOf(sub(), new Date(end.getTime() - 1))).toBe('active');
  });

  it('enters grace the instant the period ends', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    expect(stateOf(sub(), end)).toBe('grace');
  });

  it('is still in grace one millisecond before 72 hours are up', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    expect(stateOf(sub(), new Date(end.getTime() + GRACE_MS - 1))).toBe('grace');
  });

  it('expires exactly 72 hours after the period ended', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    expect(stateOf(sub(), new Date(end.getTime() + GRACE_MS))).toBe('expired');
  });

  it('treats a company that never subscribed as expired', () => {
    // Reads still work. It simply cannot write business truth.
    expect(stateOf(sub({ currentPeriodEnd: null }), AUG_18)).toBe('expired');
  });
});

describe('grace keeps the till open', () => {
  it('writes are accepted during grace', () => {
    /*
      A shop three hours past renewal is still open and still selling. Refusing
      its sales over an administrative boundary would cost it real money, so the
      warning is loud and the till keeps working.
    */
    expect(canWrite('grace')).toBe(true);
  });

  it('and refused once grace is over', () => {
    expect(canWrite('expired')).toBe(false);
  });

  it('active and complimentary both write', () => {
    expect(canWrite('active')).toBe(true);
    expect(canWrite('complimentary')).toBe(true);
  });

  it('counts down the grace hours', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    const s = sub();
    expect(graceHoursRemaining(s, end)).toBe(72);
    expect(graceHoursRemaining(s, new Date(end.getTime() + 71 * 3600_000))).toBe(1);
    // Never negative: "expired 40 hours ago" is not a countdown.
    expect(graceHoursRemaining(s, new Date(end.getTime() + 200 * 3600_000))).toBe(0);
  });

  it('derives the grace end from the period rather than storing it', () => {
    const s = sub();
    expect(graceEndsAt(s)!.getTime()).toBe(s.currentPeriodEnd!.getTime() + GRACE_MS);
  });
});

describe('a complimentary grant outranks the paid period', () => {
  it('is complimentary while the grant is live, even with no paid period', () => {
    const s = sub({
      currentPeriodEnd: null,
      isComplimentary: true,
      complimentaryUntil: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(stateOf(s, AUG_18)).toBe('complimentary');
    expect(canWrite(stateOf(s, AUG_18))).toBe(true);
  });

  it('falls back to the paid period once the grant runs out', () => {
    // The two are separate facts. An ended grant does not expire a paid shop.
    const s = sub({
      isComplimentary: true,
      complimentaryUntil: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(stateOf(s, AUG_18)).toBe('active');
  });

  it('an ended grant with no paid period is expired', () => {
    const s = sub({
      currentPeriodEnd: null,
      isComplimentary: true,
      complimentaryUntil: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(stateOf(s, AUG_18)).toBe('expired');
  });
});

describe('the grant has its own dates (docs/73 §11.5)', () => {
  const usage = { activeBranchCount: 1, seatsUsed: 0 };

  it('a live grant is told with its own end, never the paid period’s', () => {
    const s = sub({ isComplimentary: true, complimentaryUntil: new Date('2026-12-01T00:00:00.000Z') });
    const e = buildEntitlement(s, usage, AUG_18);
    expect(e.state).toBe('complimentary');
    expect(e.complimentary).toEqual({ status: 'active', until: '2026-12-01T00:00:00.000Z', paidUntil: null });
    expect(e.complimentary.until).not.toBe(e.periodEnd);
  });

  it('a grant that ran out with nothing paid after it is ended, and access follows the paid period', () => {
    const s = sub({ currentPeriodEnd: null, isComplimentary: true, complimentaryUntil: new Date('2026-08-01T00:00:00.000Z') });
    const e = buildEntitlement(s, usage, AUG_18);
    expect(e.state).toBe('expired');
    expect(e.complimentary).toEqual({ status: 'ended', until: '2026-08-01T00:00:00.000Z', paidUntil: null });
  });

  it('a paid period that runs past the grant has superseded it', () => {
    const s = sub({ isComplimentary: true, complimentaryUntil: new Date('2026-08-01T00:00:00.000Z') });
    const e = buildEntitlement(s, usage, AUG_18);
    expect(e.state).toBe('active');
    expect(e.complimentary).toEqual({ status: 'superseded', until: '2026-08-01T00:00:00.000Z', paidUntil: '2026-09-01T00:00:00.000Z' });
  });

  it('a paid period that ended before the grant did not supersede it', () => {
    const s = sub({
      currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
      isComplimentary: true,
      complimentaryUntil: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(complimentaryOf(s, AUG_18).status).toBe('ended');
  });

  it('a grant with no end recorded is shown without a date, never another one', () => {
    const s = sub({ isComplimentary: true, complimentaryUntil: null });
    expect(complimentaryOf(s, AUG_18)).toEqual({ status: 'indefinite', until: null, paidUntil: null });
  });

  it('no grant is none, whatever the paid period says', () => {
    expect(complimentaryOf(sub(), AUG_18)).toEqual({ status: 'none', until: null, paidUntil: null });
    expect(buildEntitlement(sub(), usage, AUG_18).complimentary.status).toBe('none');
  });

  it('a newer grant replaces the older one: only its own end is told', () => {
    // activateByGrant overwrites complimentary_until; the earlier end lives on in the timeline only.
    const older = sub({ isComplimentary: true, complimentaryUntil: new Date('2026-09-15T00:00:00.000Z') });
    const newer = { ...older, complimentaryUntil: new Date('2026-10-01T00:00:00.000Z') };
    expect(complimentaryOf(newer, AUG_18)).toEqual({ status: 'active', until: '2026-10-01T00:00:00.000Z', paidUntil: null });
  });

  it('a suspended business with a live grant is suspended, and the grant keeps its own end', () => {
    const s = sub({ status: 'suspended', isComplimentary: true, complimentaryUntil: new Date('2026-12-01T00:00:00.000Z') });
    const e = buildEntitlement(s, usage, AUG_18);
    expect(e.state).toBe('suspended');
    expect(e.complimentary.status).toBe('active');
  });
});

describe('seats belong to a store (docs/21, 2026-10-05)', () => {
  const stores = (...lines: { name: string; used: number; paid?: number; granted?: number }[]) =>
    lines.map((l, i) => ({ branchId: `b${i}`, name: l.name, seatsUsed: l.used, paidSeats: l.paid ?? 0, grantedSeats: l.granted ?? 0 }));

  it('gives one included seat per store, and the Owner never counts', () => {
    expect(INCLUDED_SEATS_PER_STORE).toBe(1);
    const m = seatMath(sub({ subscribedBranchCount: 3 }), { seatsUsed: 0, activeBranchCount: 3, branches: stores({ name: 'A', used: 0 }, { name: 'B', used: 0 }, { name: 'C', used: 0 }) });
    expect(m.includedSeats).toBe(3);
    expect(m.seatLimit).toBe(3);
  });

  it('does NOT pool across stores: a free seat at the quiet store seats nobody at the busy one', () => {
    const m = seatMath(sub({ subscribedBranchCount: 2 }), { seatsUsed: 1, activeBranchCount: 2, branches: stores({ name: 'Busy', used: 1 }, { name: 'Quiet', used: 0 }) });
    expect(mayConsumeSeatIn(m, 'b0')).toBe(false);
    expect(mayConsumeSeatIn(m, 'b1')).toBe(true);
    expect(m.seatsAvailable).toBe(1);
  });

  it('a paid or granted seat opens one more place at THAT store only', () => {
    const m = seatMath(sub({ subscribedBranchCount: 2 }), { seatsUsed: 2, activeBranchCount: 2, branches: stores({ name: 'A', used: 1, paid: 1 }, { name: 'B', used: 1, granted: 0 }) });
    expect(m.branches[0].seatLimit).toBe(2);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(true);
    expect(mayConsumeSeatIn(m, 'b1')).toBe(false);
    expect(m.additionalSeats).toBe(1);
  });

  it('a person at two stores holds a seat at each', () => {
    // The same person appears in both stores' head-counts.
    const m = seatMath(sub({ subscribedBranchCount: 2 }), { seatsUsed: 2, activeBranchCount: 2, branches: stores({ name: 'A', used: 1 }, { name: 'B', used: 1 }) });
    expect(m.seatsUsed).toBe(2);
    expect(m.seatsAvailable).toBe(0);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(false);
  });

  it('an unknown store seats nobody — the boundary fails closed', () => {
    const m = seatMath(sub(), { seatsUsed: 0, activeBranchCount: 1, branches: stores({ name: 'A', used: 0 }) });
    expect(mayConsumeSeatIn(m, 'nowhere')).toBe(false);
  });

  it('seats bought under the pooled rule and not yet assigned stay usable anywhere', () => {
    const m = seatMath(sub({ subscribedBranchCount: 1, additionalSeats: 1 }), { seatsUsed: 1, activeBranchCount: 1, branches: stores({ name: 'A', used: 1 }) });
    expect(m.pooledSeats).toBe(1);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(true);
    const full = seatMath(sub({ subscribedBranchCount: 1, additionalSeats: 1 }), { seatsUsed: 2, activeBranchCount: 1, branches: stores({ name: 'A', used: 2 }) });
    expect(mayConsumeSeatIn(full, 'b0')).toBe(false);
    expect(full.overLimit).toBe(false);
  });

  it('reports a store over its seats without proposing to fix it', () => {
    /*
      Staff who predate the rule may outnumber a store's seats. Nobody is
      deactivated automatically: the Owner is told, further activations at that
      store are blocked, and the decision about who stays belongs to the shop.
    */
    const m = seatMath(sub({ subscribedBranchCount: 1 }), { seatsUsed: 3, activeBranchCount: 1, branches: stores({ name: 'A', used: 3 }) });
    expect(m.branches[0].overLimit).toBe(true);
    expect(m.overLimit).toBe(true);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(false);
  });

  it('granted seats from the transition bring a store back within its seats, uncharged', () => {
    const m = seatMath(sub(), { seatsUsed: 3, activeBranchCount: 1, branches: stores({ name: 'A', used: 3, granted: 2 }) });
    expect(m.branches[0].overLimit).toBe(false);
    expect(m.overLimit).toBe(false);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(false);
  });

  it('carries each store\'s activity and the change scheduled for the renewal; a store that says nothing is an electronics store (D156)', () => {
    /*
     * The app learns from `seatsByStore[].activity` which money routes a branch
     * may write — a flag, never a price. An older server omits it, and the app
     * reads that as electronics, which keeps today's app exactly as it is.
     */
    const lines = stores({ name: 'Shop', used: 0 }, { name: 'Counter', used: 0 });
    const m = seatMath(sub({ subscribedBranchCount: 2 }), {
      seatsUsed: 0,
      activeBranchCount: 2,
      branches: [lines[0], { ...lines[1], activity: 'money_agent', activityNext: 'electronics' }],
    });
    expect(m.branches.map((b) => [b.name, b.activity, b.activityNext])).toEqual([
      ['Shop', 'electronics', null],
      ['Counter', 'money_agent', 'electronics'],
    ]);
    const e = buildEntitlement(sub({ subscribedBranchCount: 2 }), { seatsUsed: 0, activeBranchCount: 2, branches: [{ ...lines[0], activity: 'both' }] }, AUG_18);
    expect(e.seatsByStore[0]).toMatchObject({ name: 'Shop', activity: 'both', activityNext: null });
  });

  it('without per-store detail it reads company-wide, one seat per subscribed store', () => {
    const m = seatMath(sub({ subscribedBranchCount: 2, additionalSeats: 1 }), { seatsUsed: 2, activeBranchCount: 2 });
    expect(m.includedSeats).toBe(2);
    expect(m.seatLimit).toBe(3);
    expect(mayConsumeSeat(m)).toBe(true);
    expect(mayConsumeSeat(seatMath(sub({ subscribedBranchCount: 1 }), { seatsUsed: 1, activeBranchCount: 1 }))).toBe(false);
  });
});

describe('the whole answer is calculated on the server', () => {
  it('carries every figure the client would otherwise derive', () => {
    const e = buildEntitlement(sub(), { seatsUsed: 1, activeBranchCount: 1 }, AUG_18);
    expect(e).toMatchObject({
      state: 'active',
      subscribedBranchCount: 1,
      activeBranchCount: 1,
      includedSeats: 1,
      seatLimit: 1,
      seatsUsed: 1,
      overLimit: false,
      seatsByStore: [],
      canRead: true,
      canWrite: true,
      isComplimentary: false,
    });
    expect(e.periodEnd).toBe('2026-09-01T00:00:00.000Z');
    expect(e.graceEnd).toBe('2026-09-04T00:00:00.000Z');
    expect(e.daysRemaining).toBe(13);
    // So a cached copy can be shown as stale rather than as current.
    expect(e.calculatedAt).toBe(AUG_18.toISOString());
  });

  it('reads are never blocked, in any state', () => {
    for (const end of [null, new Date('2020-01-01T00:00:00.000Z')]) {
      const e = buildEntitlement(sub({ currentPeriodEnd: end }), { seatsUsed: 0, activeBranchCount: 1 }, AUG_18);
      expect(e.canRead).toBe(true);
    }
  });

  it('reports no grace countdown when not in grace', () => {
    const e = buildEntitlement(sub(), { seatsUsed: 0, activeBranchCount: 1 }, AUG_18);
    expect(e.graceHoursRemaining).toBe(0);
  });

  it('counts remaining days without rounding up a part-day', () => {
    expect(daysRemaining(sub(), new Date('2026-08-31T23:00:00.000Z'))).toBe(0);
  });
});

/**
 * The free trial (0095): three states computed from its facts and the server clock, never stored.
 *
 * Every precedence row and both boundaries, to the millisecond: the trial writes until one millisecond before its
 * end and is read-only at the end itself, with no grace; a decision outranks it; paid access approved during it
 * takes over at its end, never beside it.
 */
describe('the free trial: three computed states (0095)', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const START = new Date('2026-10-13T10:00:00.123Z');
  const END = new Date(START.getTime() + 168 * HOUR);
  const claim = { claimedAt: START, startedAt: START, endsAt: END };
  const pending = (trial: TrialFacts | null, over: Partial<SubscriptionRecord> = {}) =>
    sub({ status: 'pending_activation', currentPeriodEnd: null, trial, ...over });
  const usage = { activeBranchCount: 1, seatsUsed: 0 };

  it('an open eligibility nobody has claimed is trial_available; no eligibility, or a closed one, is pending', () => {
    expect(stateOf(pending({ eligible: true, claim: null }), START)).toBe('trial_available');
    // Closed by an approval, a grant, a paid period, a refusal or a closure that did not change the status (yet).
    expect(stateOf(pending({ eligible: false, claim: null }), START)).toBe('pending');
    // A business the Super Admin created, and every business that existed before the trial: never eligible.
    expect(stateOf(pending(null), START)).toBe('pending');
    expect(stateOf(sub({ status: 'pending_activation', currentPeriodEnd: null }), START)).toBe('pending');
  });

  it('a claim is trial_active to its last millisecond and trial_expired at its exact end', () => {
    const claimed = pending({ eligible: true, claim });
    expect(stateOf(claimed, START)).toBe('trial_active');
    expect(stateOf(claimed, new Date(END.getTime() - 1))).toBe('trial_active');
    expect(stateOf(claimed, END)).toBe('trial_expired');
    expect(stateOf(claimed, new Date(END.getTime() + 1))).toBe('trial_expired');
    // Whatever the eligibility says: there is one trial per business, ever.
    expect(stateOf(pending({ eligible: false, claim }), END)).toBe('trial_expired');
  });

  it('an ended trial is read-only with no grace — three days later too', () => {
    const claimed = pending({ eligible: true, claim });
    expect(stateOf(claimed, new Date(END.getTime() + GRACE_MS - 1))).toBe('trial_expired');
    expect(stateOf(claimed, new Date(END.getTime() + 30 * DAY))).toBe('trial_expired');
    const e = buildEntitlement(claimed, usage, END);
    expect(e).toMatchObject({ state: 'trial_expired', canRead: true, canWrite: false, graceEnd: null, graceHoursRemaining: 0 });
  });

  it('a decision outranks a running trial: suspended, refused and cancelled stop it', () => {
    for (const status of ['suspended', 'rejected', 'cancelled'] as const) {
      const decided = sub({ status, currentPeriodEnd: null, trial: { eligible: true, claim } });
      expect([status, stateOf(decided, new Date(START.getTime() + HOUR))]).toEqual([status, status]);
      expect([status, canWrite(stateOf(decided, new Date(START.getTime() + HOUR)))]).toEqual([status, false]);
    }
  });

  it('a reinstated business resumes the same trial — its clock kept running, it is never extended', () => {
    // `reinstate` sets `activated` with no period: the claim's own instants still decide.
    const reinstated = sub({ status: 'activated', currentPeriodEnd: null, trial: { eligible: true, claim } });
    expect(stateOf(reinstated, new Date(END.getTime() - 1))).toBe('trial_active');
    expect(stateOf(reinstated, END)).toBe('trial_expired');
  });

  it('paid access approved during a trial: trial_active until its end, then active — never both, never a gap', () => {
    const paidEnd = new Date('2026-11-20T10:00:00.123Z');
    const approved = sub({ status: 'activated', currentPeriodEnd: paidEnd, trial: { eligible: false, claim } });
    expect(stateOf(approved, new Date(END.getTime() - 1))).toBe('trial_active');
    expect(stateOf(approved, END)).toBe('active');
    expect(stateOf(approved, paidEnd)).toBe('grace');
    // A business that was paid for lapses as any paid business does: expired, not "trial ended".
    expect(stateOf(approved, new Date(paidEnd.getTime() + GRACE_MS))).toBe('expired');
  });

  it('a grant given during a trial: trial_active, then complimentary, then the trial’s end if nothing was paid', () => {
    const granted = sub({
      status: 'activated',
      currentPeriodEnd: null,
      isComplimentary: true,
      complimentaryUntil: new Date(END.getTime() + 30 * DAY),
      trial: { eligible: false, claim },
    });
    expect(stateOf(granted, START)).toBe('trial_active');
    expect(stateOf(granted, END)).toBe('complimentary');
    expect(stateOf(granted, new Date(END.getTime() + 31 * DAY))).toBe('trial_expired');
  });

  it('activated with no period: trial_expired after a trial, expired without one (unchanged)', () => {
    expect(stateOf(sub({ status: 'activated', currentPeriodEnd: null, trial: { eligible: false, claim } }), END)).toBe('trial_expired');
    expect(stateOf(sub({ status: 'activated', currentPeriodEnd: null, trial: { eligible: false, claim: null } }), END)).toBe('expired');
    expect(stateOf(sub({ status: 'activated', currentPeriodEnd: null }), END)).toBe('expired');
  });

  it('suspended before claiming, then reinstated: trial_available again — suspension blocks and never closes', () => {
    // `reinstate` sets `activated` whatever the business was (F12). Nothing was ever paid or granted, and the
    // eligibility is still open: the business may claim, exactly as it could before it was suspended (SPEC §2.1).
    const reinstated = sub({ status: 'activated', currentPeriodEnd: null, trial: { eligible: true, claim: null } });
    expect(stateOf(reinstated, START)).toBe('trial_available');
    expect([canRead(stateOf(reinstated, START)), canWrite(stateOf(reinstated, START))]).toEqual([false, false]);
    // While it was suspended, the suspension answered.
    expect(stateOf({ ...reinstated, status: 'suspended' }, START)).toBe('suspended');
  });

  it('an open eligibility never outranks access that was given: dates and grants answer first', () => {
    // Every approval, grant and period closes the eligibility under the fence; if one were somehow left open, the
    // business would still be told its dates — a paying business is never closed by a trial it did not claim.
    expect(stateOf(sub({ status: 'activated', trial: { eligible: true, claim: null } }), AUG_18)).toBe('active');
    const grantRanOut = sub({
      status: 'activated',
      currentPeriodEnd: null,
      isComplimentary: true,
      complimentaryUntil: new Date(START.getTime() - DAY),
      trial: { eligible: true, claim: null },
    });
    expect(stateOf(grantRanOut, START)).toBe('expired');
  });

  it('a status nobody recognises fails to expired even during a trial — a corrupted row never writes', () => {
    const corrupt = sub({ status: '' as unknown as SubscriptionStatus, currentPeriodEnd: null, trial: { eligible: true, claim } });
    expect(stateOf(corrupt, START)).toBe('expired');
    expect(canWrite(stateOf(corrupt, START))).toBe(false);
  });

  it('what each trial state may do', () => {
    expect([canRead('trial_available'), canWrite('trial_available')]).toEqual([false, false]);
    expect([canRead('trial_active'), canWrite('trial_active')]).toEqual([true, true]);
    expect([canRead('trial_expired'), canWrite('trial_expired')]).toEqual([true, false]);
  });

  it('the code a closed, unstarted business is refused with is its own, and stable', () => {
    // The client says "not started" from it — never "waiting for approval", never "ended".
    expect(ENTITLEMENT_TRIAL_AVAILABLE).toBe('ENTITLEMENT_TRIAL_AVAILABLE');
  });
});

describe('the trial as the client is told it (0095)', () => {
  const HOUR = 60 * 60 * 1000;
  const START = new Date('2026-10-13T10:00:00.123Z');
  const END = new Date(START.getTime() + 168 * HOUR);
  const claim = { claimedAt: START, startedAt: START, endsAt: END };
  const usage = { activeBranchCount: 1, seatsUsed: 0 };
  const pending = (trial: TrialFacts | null, over: Partial<SubscriptionRecord> = {}) =>
    sub({ status: 'pending_activation', currentPeriodEnd: null, trial, ...over });

  it('available: no instants, the duration in hours and in days, the business’s zone', () => {
    const e = buildEntitlement(pending({ eligible: true, claim: null }, { timeZone: 'Africa/Nouakchott' }), usage, START);
    expect(e).toMatchObject({ state: 'trial_available', canRead: false, canWrite: false });
    expect(e.trial).toEqual({
      status: 'available',
      durationHours: 168,
      durationDays: 7,
      claimedAt: null,
      startedAt: null,
      endsAt: null,
      timeZone: 'Africa/Nouakchott',
      accessAfterTrial: null,
    });
  });

  it('active, then expired: the recorded instants as stored, in UTC, the zone beside them', () => {
    const claimed = pending({ eligible: true, claim }, { timeZone: 'Europe/Paris' });
    const running = buildEntitlement(claimed, usage, new Date(END.getTime() - 1));
    expect(running.state).toBe('trial_active');
    expect(running.trial).toEqual({
      status: 'active',
      durationHours: 168,
      durationDays: 7,
      claimedAt: '2026-10-13T10:00:00.123Z',
      startedAt: '2026-10-13T10:00:00.123Z',
      endsAt: '2026-10-20T10:00:00.123Z',
      timeZone: 'Europe/Paris',
      accessAfterTrial: null,
    });
    expect(buildEntitlement(claimed, usage, END).trial).toMatchObject({ status: 'expired', endsAt: '2026-10-20T10:00:00.123Z' });
  });

  it('nothing paid, nothing granted, no grace: the paid figures stay empty while a trial runs', () => {
    const e = buildEntitlement(pending({ eligible: true, claim }), usage, START);
    expect(e).toMatchObject({
      state: 'trial_active',
      canRead: true,
      canWrite: true,
      periodEnd: null,
      graceEnd: null,
      daysRemaining: null,
      graceHoursRemaining: 0,
      isComplimentary: false,
      complimentary: { status: 'none' },
      status: 'pending_activation',
    });
  });

  it('the zone is the one the record carries; a record without one is shown in UTC', () => {
    expect(buildEntitlement(pending({ eligible: true, claim: null }), usage, START).trial?.timeZone).toBe('UTC');
  });

  it('an invalid stored zone reaches the client as UTC — never a zone guessed for the country', () => {
    const zone = displayTimeZone('Mars/Olympus_Mons');
    const e = buildEntitlement(pending({ eligible: true, claim: null }, { timeZone: zone }), usage, START);
    expect(e.trial?.timeZone).toBe('UTC');
  });

  it('what follows the trial is read from the same record: its paid period, or its grant, running past the end (C6)', () => {
    const fenced = { eligible: false, claim, closure: { at: START, reason: 'approved' as const } };
    const paid = sub({ status: 'activated', currentPeriodEnd: new Date(END.getTime() + 30 * 24 * HOUR), trial: fenced });
    expect(buildEntitlement(paid, usage, START).trial?.accessAfterTrial).toEqual({ kind: 'paid', startsAt: END.toISOString() });
    const granted = sub({ status: 'activated', currentPeriodEnd: null, isComplimentary: true, complimentaryUntil: new Date(END.getTime() + 24 * HOUR), trial: fenced });
    expect(buildEntitlement(granted, usage, START).trial?.accessAfterTrial).toEqual({ kind: 'granted', startsAt: END.toISOString() });
    expect(buildEntitlement(pending({ eligible: true, claim }), usage, START).trial?.accessAfterTrial).toBeNull();
  });

  it('no trial to show: a business that never had one, or whose eligibility closed before a claim', () => {
    expect(buildEntitlement(sub(), usage, AUG_18).trial).toBeNull();
    expect(buildEntitlement(pending(null), usage, START).trial).toBeNull();
    expect(buildEntitlement(pending({ eligible: false, claim: null }), usage, START).trial).toBeNull();
    // Suspended before anything was claimed: nothing to offer, so nothing shown.
    expect(buildEntitlement(sub({ status: 'suspended', trial: { eligible: true, claim: null } }), usage, START).trial).toBeNull();
  });
});

describe('route classification fails closed', () => {
  it('a mutation nobody classified is blocked when expired', () => {
    // The realistic failure: a later milestone adds an endpoint and forgets
    // this file. Blocking is the safe answer; allowing would let a lapsed shop
    // write whatever the newest feature writes.
    expect(isAllowedWhenExpired('POST', 'some/future/endpoint')).toBe(false);
  });

  it('reads are always allowed', () => {
    expect(isAllowedWhenExpired('GET', 'sales')).toBe(true);
    expect(isAllowedWhenExpired('GET', 'analytics/daily')).toBe(true);
  });

  it('signing in and out survive expiry', () => {
    expect(isAllowedWhenExpired('POST', 'auth/login')).toBe(true);
    expect(isAllowedWhenExpired('POST', 'auth/refresh')).toBe(true);
    expect(isAllowedWhenExpired('POST', 'auth/logout')).toBe(true);
    expect(isAllowedWhenExpired('POST', 'auth/logout-all')).toBe(true);
  });

  it('marking a notification read survives, because it changes no business truth', () => {
    expect(isAllowedWhenExpired('POST', 'notifications/:id/read')).toBe(true);
  });

  it('but everything that moves stock, money or staff does not', () => {
    for (const [m, p] of [
      ['POST', 'sales'],
      ['POST', 'units'],
      ['POST', 'purchases'],
      ['POST', 'transfers'],
      ['POST', 'consignments'],
      ['POST', 'loans'],
      ['POST', 'returns'],
      ['POST', 'expenses'],
      ['POST', 'closings'],
      ['POST', 'corrections'],
      ['POST', 'goals'],
      ['POST', 'users'],
      ['PUT', 'settings'],
      ['POST', 'devices/adopt'],
    ] as const) {
      expect(isAllowedWhenExpired(m, p)).toBe(false);
    }
  });

  it('a device may be revoked, never adopted, once the subscription lapsed (2026-10-05)', () => {
    /*
     * Revoking removes authority, the way `logout-all` does: a stolen phone is
     * signed out whatever the shop owes. Adopting GRANTS authority, and a
     * lapsed shop enrolling new phones is exactly the case the block exists for.
     */
    expect(isAllowedWhenExpired('DELETE', 'devices/:deviceId')).toBe(true);
    expect(isAllowedWhenExpired('DELETE', 'devices/users/:userId/:deviceId')).toBe(true);
    expect(isAllowedWhenExpired('POST', 'devices/adopt')).toBe(false);
    // Nothing else under devices/ — a future route is blocked by default.
    expect(isAllowedWhenExpired('POST', 'devices/:deviceId')).toBe(false);
  });

  it('knows which methods can change something', () => {
    expect(isMutation('GET')).toBe(false);
    expect(isMutation('POST')).toBe(true);
    expect(isMutation('patch')).toBe(true);
    expect(isMutation('DELETE')).toBe(true);
  });

  it('every allowance explains itself', () => {
    for (const rule of ALWAYS_ALLOWED) {
      expect(rule.why.length).toBeGreaterThan(20);
    }
  });

  it('the allow-list stays exactly this short', () => {
    /*
     * The default is to BLOCK, and that is what protects a lapsed shop. Each
     * addition is a deliberate decision, so the list is pinned by name: a new
     * entry has to be argued for here as well as written there.
     */
    expect(ALWAYS_ALLOWED.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE devices/:deviceId',
      'DELETE devices/users/:userId/:deviceId',
      'POST account/deletion/cancel',
      'POST account/deletion/confirm',
      'POST account/deletion/request',
      'POST account/deletion/resend',
      'POST account/whatsapp/verify/confirm',
      'POST account/whatsapp/verify/start',
      'POST auth/login',
      'POST auth/logout',
      'POST auth/logout-all',
      'POST auth/refresh',
      'POST notifications/:id/read',
      // D154 (2026-10-08): asking for another activity for a branch is asking to pay (an
      // upgrade) or to pay less from the renewal (a downgrade); nothing changes by asking.
      'POST platform/my-subscription/activity-requests',
      'POST platform/my-subscription/seat-requests',
      'POST platform/my-subscription/seat-requests/:rid/withdraw',
      'POST platform/my-subscription/store-requests',
      // 0095: the free trial — a business that has not started claims it and checks its setup link; the claim writes
      // the trial itself and nothing paid or billed, and only the Owner may make it. The resend sends the Owner's own
      // setup instructions to the Owner's own verified contacts, from the website only.
      'POST platform/my-subscription/trial/claim',
      'POST platform/my-subscription/trial/link',
      'POST platform/my-subscription/trial/setup/resend',
      'POST platform/portal-handoff',
    ]);
  });

  it('a person may leave, whatever the shop owes (docs/64)', () => {
    /*
     * The App Store requires that the way out is in the app, and the product
     * decision is that a pending, suspended or lapsed subscription never
     * traps a person: deleting their own account, and proving the WhatsApp
     * number the deletion code needs, survive every state.
     */
    for (const path of [
      'account/deletion/request',
      'account/deletion/resend',
      'account/deletion/confirm',
      'account/deletion/cancel',
      'account/whatsapp/verify/start',
      'account/whatsapp/verify/confirm',
    ]) {
      expect(isAllowedWhenExpired('POST', path)).toBe(true);
    }
    // But nothing under `account/` that is not listed — a future route is blocked by default.
    expect(isAllowedWhenExpired('POST', 'account/anything-else')).toBe(false);
    expect(isAllowedWhenExpired('DELETE', 'account')).toBe(false);
  });

  it('no OPERATIONAL route survives a lapsed subscription', () => {
    /*
     * The portal handoff was added because every newly registered shop is
     * pending by definition and that route leads to the page which ends the
     * pending state. That argument covers exactly one route and must not
     * quietly extend to the shop's actual work.
     */
    const operational = [
      'sales', 'units', 'inventory', 'purchases', 'transfers', 'returns',
      'refunds', 'expenses', 'closing', 'suppliers', 'loans', 'consignments',
      'products', 'pricing', 'goals', 'imports',
    ];
    for (const rule of ALWAYS_ALLOWED) {
      for (const word of operational) {
        expect(rule.path.startsWith(`${word}/`) || rule.path === word).toBe(false);
      }
    }
  });

  it('and the handoff is the only platform route allowed through', () => {
    const platform = ALWAYS_ALLOWED.filter((r) => r.path.startsWith('platform/'));
    // The handoff, and asking to pay for a seat, a store or another activity for a
    // branch (docs/21, 2026-10-05; D154, 2026-10-08): nothing is granted by asking,
    // and a lapsed shop must be able to ask.
    expect(platform.map((r) => r.path)).toEqual([
      'platform/my-subscription/seat-requests',
      'platform/my-subscription/store-requests',
      'platform/my-subscription/seat-requests/:rid/withdraw',
      'platform/my-subscription/activity-requests',
      'platform/portal-handoff',
      // 0095: claiming the free trial, checking a setup link and asking for the setup instructions again — nothing
      // paid, nothing granted beyond the trial.
      'platform/my-subscription/trial/claim',
      'platform/my-subscription/trial/link',
      'platform/my-subscription/trial/setup/resend',
    ]);
    // Minting a ticket is not spending one, and neither moves money.
    for (const r of platform) expect(r.method).toBe('POST');
  });

  it('the code the client keys on is stable', () => {
    // The mobile app must never parse English to know what happened.
    expect(ENTITLEMENT_WRITE_BLOCKED).toBe('ENTITLEMENT_WRITE_BLOCKED');
  });
});

/**
 * The account surface a shop keeps in every state.
 *
 * Pinned by name for the same reason as the mutation allow-list: the default
 * refuses, and each exception is a decision somebody has to argue for twice.
 */
describe('what a pending or suspended shop may still read', () => {
  it('the readable list stays exactly this short', () => {
    expect(ALWAYS_READABLE.map((r) => r.path).sort()).toEqual([
      'account',
      'account/deletion',
      // 0095: the Owner's free trial status in the app — display data only, no action.
      'account/trial-setup',
      // D161 (2026-10-10): what became of the phone's own money record, under its own key.
      'agent/transactions/client/:clientUuid',
      'auth/logout',
      'auth/me',
      'auth/refresh',
      'entitlement',
      'health',
      'platform/my-subscription',
      // 2026-10-16: the Owner's own requests and their prices — asking is allowed in every state.
      'platform/my-subscription/activity-options',
      'platform/my-subscription/seat-requests',
      // 0095: the Owner's free trial card, read by a business that has not started yet.
      'platform/my-subscription/trial',
      'platform/payment-instructions',
    ]);
  });

  it('every readable exception explains itself', () => {
    for (const rule of ALWAYS_READABLE) expect([rule.path, rule.why.length > 20]).toEqual([rule.path, true]);
  });

  it('a phone can learn the fate of its own money record while the business is suspended (D161)', () => {
    /*
     * The exchange happened at the counter whatever the subscription became
     * while it sat in the queue; refusing the lookup would leave the phone
     * guessing whether to send it again. Only the lookup by the phone's own
     * key: the history, the detail and every other agent read stay closed.
     */
    expect(isAlwaysReadable('agent/transactions/client/:clientUuid')).toBe(true);
    for (const path of ['agent/transactions', 'agent/transactions/:id', 'agent/positions', 'agent/providers', 'agent/reports', 'agent/mistakes', 'agent/rebalancings']) {
      expect([path, isAlwaysReadable(path)]).toEqual([path, false]);
    }
  });

  it('lets a pending shop read how to pay', () => {
    /*
     * The CP8 acceptance walked the handoff as a genuinely pending shop and the
     * payment dialog never opened: `payment-instructions` answered
     * ENTITLEMENT_PENDING, and the page treats an instructions failure as
     * non-fatal, so it failed silently — for the only kind of shop that needs
     * it. The portal is where a pending shop finds out what to pay; refusing it
     * the instructions makes the whole handoff pointless.
     */
    expect(isAlwaysReadable('platform/payment-instructions')).toBe(true);
    expect(isAlwaysReadable('platform/my-subscription')).toBe(true);
  });

  it('opens no operational read to a pending shop', () => {
    for (const path of [
      'sales', 'products', 'units', 'inventory/summary', 'purchases', 'transfers',
      'returns', 'expenses', 'suppliers', 'analytics/dashboard', 'closing', 'goals',
      'consignments', 'loans', 'pricing', 'categories', 'users', 'settings',
    ]) {
      expect(isAlwaysReadable(path)).toBe(false);
    }
  });

  it('names only account routes, and the one money-record lookup — never another business read', () => {
    // The lookup is the single argued exception (D161, 2026-10-10): one record, under the phone's own key, masked.
    const accountish = /^(entitlement|health|auth\/|account(\/deletion|\/trial-setup)?$|platform\/(my-subscription|payment-instructions))/;
    for (const { path } of ALWAYS_READABLE.filter((r) => r.path !== 'agent/transactions/client/:clientUuid')) {
      expect([path, accountish.test(path)]).toEqual([path, true]);
    }
  });
});
