import {
  GRACE_ALLOWANCE,
  GRACE_MS,
  decideGrace,
  graceDue,
  graceRunning,
  graceSpan,
  graceViewOf,
  graceWindowStart,
  grantCovers,
  periodGraceOf,
  shiftMonths,
  useRestoredAt,
  usesInWindow,
  type GraceFacts,
} from './grace-rules';
import { buildEntitlement, canRead, canWrite, graceEndsAt, stateOf, type SubscriptionRecord } from './entitlement-rules';

/**
 * Limited grace (0099; the owner's brief of 2026-10-18): three 72-hour activations per company in any rolling 12
 * months, decided once per paid period end, consumed at once, never after a free trial.
 */

const HOUR = 3_600_000;
const at = (iso: string) => new Date(iso);

/** A paid subscription ending at `end`, with the grace history given. */
function paid(end: Date, grace: GraceFacts | null | undefined, over: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    subscribedBranchCount: 1,
    additionalSeats: 0,
    currentPeriodEnd: end,
    isComplimentary: false,
    complimentaryUntil: null,
    status: 'activated',
    grace,
    ...over,
  };
}

describe('the calendar arithmetic is MySQL’s INTERVAL n MONTH, in UTC', () => {
  it('keeps the day and the time of day', () => {
    expect(shiftMonths(at('2026-10-18T09:30:15.123Z'), -12).toISOString()).toBe('2025-10-18T09:30:15.123Z');
    expect(shiftMonths(at('2026-10-18T09:30:15.123Z'), 12).toISOString()).toBe('2027-10-18T09:30:15.123Z');
    expect(shiftMonths(at('2026-01-31T23:59:59.999Z'), 1).toISOString()).toBe('2026-02-28T23:59:59.999Z');
  });

  it('clamps the day to the month’s end: 29 February minus 12 months is 28 February', () => {
    expect(shiftMonths(at('2028-02-29T10:00:00.000Z'), -12).toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(shiftMonths(at('2028-02-29T10:00:00.000Z'), 12).toISOString()).toBe('2029-02-28T10:00:00.000Z');
    expect(graceWindowStart(at('2027-03-31T00:00:00.000Z')).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });
});

describe('one decision per paid period end', () => {
  it('granted while fewer than three activations count against it; refused from the third', () => {
    expect(decideGrace(0)).toBe('granted');
    expect(decideGrace(1)).toBe('granted');
    expect(decideGrace(2)).toBe('granted');
    expect(decideGrace(3)).toBe('refused');
    expect(decideGrace(7)).toBe('refused');
    expect(GRACE_ALLOWANCE).toBe(3);
  });

  it('a granted decision runs exactly 72 hours from the period end; a refused one starts and ends there', () => {
    const end = at('2026-11-01T00:00:00.000Z');
    expect(graceSpan(end, 'granted')).toEqual({ startedAt: end, endsAt: new Date(end.getTime() + 72 * HOUR) });
    expect(graceSpan(end, 'refused')).toEqual({ startedAt: end, endsAt: end });
  });

  it('is owed only to a paid relationship whose end has passed, with no grant covering it', () => {
    const end = at('2026-11-01T00:00:00.000Z');
    const after = new Date(end.getTime() + 1);
    expect(graceDue(paid(end, null), new Date(end.getTime() - 1))).toBe(false);
    expect(graceDue(paid(end, null), end)).toBe(true);
    expect(graceDue(paid(end, null, { status: 'suspended' }), after)).toBe(true);
    for (const status of ['cancelled', 'rejected', 'pending_activation'] as const) {
      expect(graceDue(paid(end, null, { status }), after)).toBe(false);
    }
    expect(graceDue(paid(end, null, { isComplimentary: true, complimentaryUntil: new Date(end.getTime() + HOUR) }), after)).toBe(false);
    expect(graceDue(paid(end, null, { isComplimentary: true, complimentaryUntil: end }), after)).toBe(true);
    expect(graceDue({ ...paid(end, null), currentPeriodEnd: null }, after)).toBe(false);
  });
});

describe('the first, second and third paid expiry receive grace; the fourth in the rolling year receives none', () => {
  const ends = ['2026-01-10T08:00:00.000Z', '2026-04-10T08:00:00.000Z', '2026-07-10T08:00:00.000Z', '2026-10-10T08:00:00.000Z'].map(at);
  const granted = (n: number): Date[] => ends.slice(0, n);
  const factsFor = (end: Date, history: Date[]): GraceFacts => ({
    recorded: null,
    usesBefore: history.filter((s) => s.getTime() > graceWindowStart(end).getTime() && s.getTime() !== end.getTime()).length,
  });

  it.each([0, 1, 2])('activation #%i + 1 is granted: grace for exactly 72 hours, writes kept', (n) => {
    const end = ends[n];
    const sub = paid(end, factsFor(end, granted(n)));
    expect(stateOf(sub, end)).toBe('grace');
    expect(stateOf(sub, new Date(end.getTime() + 72 * HOUR - 1))).toBe('grace');
    expect(canWrite(stateOf(sub, new Date(end.getTime() + 72 * HOUR - 1)))).toBe(true);
    expect(stateOf(sub, new Date(end.getTime() + 72 * HOUR))).toBe('expired');
    expect(graceEndsAt(sub)).toEqual(new Date(end.getTime() + GRACE_MS));
  });

  it('the fourth inside 12 months is refused: read-only at the period end itself, no grace end', () => {
    const end = ends[3];
    const sub = paid(end, factsFor(end, granted(3)));
    expect(stateOf(sub, new Date(end.getTime() - 1))).toBe('active');
    expect(stateOf(sub, end)).toBe('expired');
    expect(canWrite(stateOf(sub, end))).toBe(false);
    expect(canRead(stateOf(sub, end))).toBe(true);
    expect(graceEndsAt(sub)).toBeNull();
  });

  it('the rolling window gives a use back when the oldest activation leaves it — not a day before', () => {
    const history = granted(3);
    // Exactly 12 months after the first activation, the window starts at it: it no longer counts.
    const restored = at('2027-01-10T08:00:00.000Z');
    expect(factsFor(restored, history).usesBefore).toBe(2);
    expect(stateOf(paid(restored, factsFor(restored, history)), restored)).toBe('grace');
    const aMillisecondEarlier = new Date(restored.getTime() - 1);
    expect(factsFor(aMillisecondEarlier, history).usesBefore).toBe(3);
    expect(stateOf(paid(aMillisecondEarlier, factsFor(aMillisecondEarlier, history)), aMillisecondEarlier)).toBe('expired');
  });

  it('activations counted are the company’s, whatever store, plan or person: the one subscription carries them all', () => {
    // A plan change, a new store or an employee change does not touch the history the count is made from.
    const end = ends[3];
    const sub = paid(end, factsFor(end, granted(3)), { subscribedBranchCount: 5, additionalSeats: 9 });
    expect(stateOf(sub, end)).toBe('expired');
  });
});

describe('a recorded decision is final; an unrecorded one is decided exactly as it will be recorded', () => {
  const end = at('2026-11-01T00:00:00.000Z');

  it('the recorded decision for this period end wins over the count', () => {
    const recorded = { periodEnd: end, decision: 'refused' as const, startedAt: end, endsAt: end };
    // Even with nothing counted now, a refusal written down stays a refusal.
    expect(periodGraceOf(paid(end, null), { recorded, usesBefore: 0 })).toEqual({ decision: 'refused', startedAt: end, endsAt: end, recorded: true });
    expect(stateOf(paid(end, { recorded, usesBefore: 0 }), end)).toBe('expired');
  });

  it('a decision recorded for another period end is not this one’s', () => {
    const old = at('2026-08-01T00:00:00.000Z');
    const recorded = { periodEnd: old, decision: 'granted' as const, startedAt: old, endsAt: new Date(old.getTime() + 72 * HOUR) };
    const grace = periodGraceOf(paid(end, null), { recorded, usesBefore: 1 });
    expect(grace).toMatchObject({ decision: 'granted', startedAt: end, recorded: false });
  });

  it('granted is consumed at once: a renewal minutes later does not give it back (the episode stays in the history)', () => {
    // The period was renewed 5 minutes into grace: a new end, and the episode of the old end still counts against it.
    const renewedEnd = shiftMonths(end, 1);
    const history = [end];
    const facts = { recorded: null, usesBefore: history.filter((s) => s.getTime() > graceWindowStart(renewedEnd).getTime()).length };
    expect(facts.usesBefore).toBe(1);
    expect(stateOf(paid(renewedEnd, facts), new Date(end.getTime() + 5 * 60_000))).toBe('active');
  });

  it('an expiry moved into the past cannot earn a fourth activation: later activations count too', () => {
    // Three granted in the window; the period end is then set back a day before the third one.
    const starts = [at('2026-03-01T00:00:00.000Z'), at('2026-06-01T00:00:00.000Z'), at('2026-09-01T00:00:00.000Z')];
    const moved = at('2026-08-31T00:00:00.000Z');
    const usesBefore = starts.filter((s) => s.getTime() > graceWindowStart(moved).getTime()).length;
    expect(usesBefore).toBe(3);
    expect(stateOf(paid(moved, { recorded: null, usesBefore }), moved)).toBe('expired');
  });

  it('a grant covering the period end means no grace was needed, and none follows the grant', () => {
    const covered = paid(end, { recorded: null, usesBefore: 0 }, { isComplimentary: true, complimentaryUntil: new Date(end.getTime() + 24 * HOUR) });
    expect(grantCovers(covered, end)).toBe(true);
    expect(periodGraceOf(covered, covered.grace)).toBeNull();
    expect(stateOf(covered, new Date(end.getTime() + HOUR))).toBe('complimentary');
    expect(stateOf(covered, new Date(end.getTime() + 25 * HOUR))).toBe('expired');
  });

  it('no facts at all (a caller written before 0099) reads as an activation still available', () => {
    expect(stateOf(paid(end, undefined), new Date(end.getTime() + HOUR))).toBe('grace');
  });
});

describe('a free trial’s end never receives grace', () => {
  it('trial_expired at the trial’s end, whatever the grace history', () => {
    const endsAt = at('2026-10-20T10:00:00.000Z');
    const trialSub: SubscriptionRecord = {
      subscribedBranchCount: 1,
      additionalSeats: 0,
      currentPeriodEnd: null,
      isComplimentary: false,
      complimentaryUntil: null,
      status: 'pending_activation',
      trial: { eligible: false, claim: { claimedAt: new Date(endsAt.getTime() - 168 * HOUR), startedAt: new Date(endsAt.getTime() - 168 * HOUR), endsAt } },
      grace: { recorded: null, usesBefore: 0 },
    };
    expect(stateOf(trialSub, new Date(endsAt.getTime() - 1))).toBe('trial_active');
    expect(stateOf(trialSub, endsAt)).toBe('trial_expired');
    expect(stateOf(trialSub, new Date(endsAt.getTime() + 71 * HOUR))).toBe('trial_expired');
    expect(graceDue(trialSub, endsAt)).toBe(false);
  });
});

describe('the uses in the window, and when one returns', () => {
  it('counts the activations of the 12 months before now', () => {
    const now = at('2026-10-18T00:00:00.000Z');
    const starts = [at('2025-10-18T00:00:00.000Z'), at('2025-10-18T00:00:00.001Z'), at('2026-05-01T00:00:00.000Z')];
    expect(usesInWindow(starts, now)).toBe(2);
  });

  it('a use returns 12 calendar months after it started', () => {
    expect(useRestoredAt(at('2026-01-10T08:00:00.000Z')).toISOString()).toBe('2027-01-10T08:00:00.000Z');
  });

  it('after a 29 February, it returns on 1 March 00:00 the next year — the first instant whose window starts after it', () => {
    const start = at('2028-02-29T10:00:00.000Z');
    const back = useRestoredAt(start);
    expect(back.toISOString()).toBe('2029-03-01T00:00:00.000Z');
    expect(graceWindowStart(back).getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(graceWindowStart(new Date(back.getTime() - 1)).getTime()).toBeLessThan(start.getTime());
  });
});

describe('the view the clients render', () => {
  const end = at('2026-11-01T00:00:00.000Z');

  it('active: started at the period end, its own end, the hours left rounded up, the allowance', () => {
    const facts = { recorded: null, usesBefore: 1, recentStarts: [at('2026-06-01T00:00:00.000Z'), end] };
    const view = graceViewOf(paid(end, facts), facts, new Date(end.getTime() + 30 * 60_000), false);
    expect(view).toEqual({
      status: 'active',
      startedAt: end.toISOString(),
      endsAt: new Date(end.getTime() + 72 * HOUR).toISOString(),
      hoursRemaining: 72,
      availableAtPeriodEnd: null,
      allowance: 3,
      windowMonths: 12,
      durationHours: 72,
      usesInWindow: 2,
      usesRemaining: 1,
      nextUseRestoredAt: '2027-06-01T00:00:00.000Z',
    });
  });

  it('unavailable: the period ended with the three uses taken — no grace end, nothing to count down', () => {
    const facts = { recorded: null, usesBefore: 3, recentStarts: [at('2026-02-01T00:00:00.000Z'), at('2026-05-01T00:00:00.000Z'), at('2026-08-01T00:00:00.000Z')] };
    const view = graceViewOf(paid(end, facts), facts, new Date(end.getTime() + HOUR), false);
    expect(view).toMatchObject({ status: 'unavailable', startedAt: end.toISOString(), endsAt: null, hoursRemaining: 0, usesInWindow: 3, usesRemaining: 0 });
  });

  it('while a paid period runs: whether its end would start grace, decided by the server', () => {
    const before = new Date(end.getTime() - 24 * HOUR);
    expect(graceViewOf(paid(end, { recorded: null, usesBefore: 2 }), { recorded: null, usesBefore: 2 }, before, true)).toMatchObject({
      status: 'none',
      availableAtPeriodEnd: true,
      usesInWindow: null,
    });
    expect(graceViewOf(paid(end, { recorded: null, usesBefore: 3 }), { recorded: null, usesBefore: 3 }, before, true).availableAtPeriodEnd).toBe(false);
  });

  it('the entitlement carries it, with the business’s zone and a grace end only when grace follows', () => {
    const refusedFacts = { recorded: null, usesBefore: 3 };
    const e = buildEntitlement({ ...paid(end, refusedFacts), timeZone: 'Africa/Nouakchott' }, { seatsUsed: 0, activeBranchCount: 1 }, new Date(end.getTime() + HOUR));
    expect(e.state).toBe('expired');
    expect(e.graceEnd).toBeNull();
    expect(e.graceHoursRemaining).toBe(0);
    expect(e.grace.status).toBe('unavailable');
    expect(e.timeZone).toBe('Africa/Nouakchott');
    expect(graceRunning(periodGraceOf(paid(end, refusedFacts), refusedFacts), new Date(end.getTime() + HOUR))).toBe(false);
  });
});
