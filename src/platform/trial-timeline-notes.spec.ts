import { Logger } from '@nestjs/common';
import { CTX, HOUR, makeTrialBillingWorld, type Business, type TrialBillingWorld } from './__testing__/trial-billing-world';

/**
 * C7 (decision 4 of the add-on round, review finding R4-01): no note the server writes along a free trial carries an
 * instant.
 *
 * A note is English text the website and the console print as it is. An instant inside one was printed as a raw UTC
 * ISO string — beside the same instant shown in the business's zone, with the zone's name, a line above. So every
 * date travels as data instead (the claim's columns, the trial's view, a period's start, a request's
 * `activation.startsAt`), and every note says in words what happens and when: "when the free trial ends".
 *
 * Driven end to end through the real services (trial-billing-world): the claim, an approval or a grant while the trial
 * runs, a store and a seat paid for during it, and its end — every note of the business's timeline, read back.
 */

const CLAIMED = new Date('2026-10-14T09:30:00.123Z');
const T = new Date(CLAIMED.getTime() + 168 * HOUR);
/** An ISO instant, or the start of one: what no note may hold. */
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/** Every note of the business, with its kind, in the order written. */
const notesOf = (w: TrialBillingWorld, b: Business) => w.events(b).map((e) => ({ kind: e.kind as string, note: e.note as string | null }));

function expectNoInstant(notes: { kind: string; note: string | null }[]) {
  for (const { kind, note } of notes) {
    expect({ kind, note, instant: INSTANT.test(note ?? '') }).toEqual({ kind, note, instant: false });
    for (const at of [CLAIMED, T]) expect(note ?? '').not.toContain(at.toISOString());
  }
}

/** A store B and a seat at Main, requested and paid for an hour after the claim. */
async function paidDuringTheTrial(w: TrialBillingWorld, b: Business) {
  const sara = w.person(b, { name: 'Sara', stores: ['Main'], verified: true });
  w.person(b, { name: 'Ali', stores: ['Main'], active: true });
  const store = await w.seats.requestStore(b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'user:owner' });
  const seat = await w.seats.requestSeat(b.companyId, { branchId: b.stores.Main, userId: sara, requestedBy: 'user:owner' });
  await w.confirm(store.allocation.id, 500, { reference: 'BK-1' });
  await w.confirm(seat.allocation.id, 100, { reference: 'BK-2' });
}

describe('C7: a whole free trial, and not one instant in its notes', () => {
  it('claimed, approved during it, a store and a seat paid for during it, and its end — every note in words', async () => {
    const w = makeTrialBillingWorld({ now: CLAIMED });
    const b = w.business({ name: 'Boutique' });
    await w.claim(b);
    w.clock.set(new Date(CLAIMED.getTime() + HOUR));
    await w.lifecycle.approve(w.uuid(b.companyId), { months: 1, reason: 'Paid by transfer' }, CTX);
    await paidDuringTheTrial(w, b);
    w.clock.set(T);
    await w.entitlement.forCompany(b.companyId);

    const notes = notesOf(w, b);
    // The whole journey is here: the claim, the deferred approval and its first period, both requests and both
    // payments, the trial's end, and what was paid for during it put in force — Sara activated with her seat.
    expect(new Set(notes.map((n) => n.kind))).toEqual(
      new Set([
        'trial_claimed',
        'approved',
        'renewed',
        'store_requested',
        'seat_requested',
        'seat_paid',
        'trial_expired',
        'branches_changed',
        'seats_changed',
        'staff_activated',
      ]),
    );
    expectNoInstant(notes);
    const said = (kind: string) => notes.filter((n) => n.kind === kind).map((n) => n.note);
    expect(said('trial_claimed')).toEqual(['Free trial claimed on the website by the Owner: 7 days from the claim. Nothing was charged.']);
    expect(said('approved')).toEqual(['Paid by transfer Paid access starts when the free trial ends.']);
    expect(said('renewed')).toEqual(["First billing period opens when the free trial ends, at today's size and the prices in force then."]);
    expect(said('seat_paid')).toEqual([
      'Store "B": payment confirmed, reference BK-1. It opens when the free trial ends; its first paid month starts then.',
      'Seat at Main: payment confirmed, reference BK-2. It starts when the free trial ends; its first paid month starts then.',
    ]);
    expect(said('trial_expired')).toEqual(['The 7-day free trial ended. Nothing was charged.']);
    // The instants are data: the claim's own columns, the first period's start, each request's start.
    expect(w.claimOf(b)).toMatchObject({ startedAt: CLAIMED, endsAt: T });
    expect(w.periods(b)[0].periodStart).toEqual(T);
    expect(w.requests(b).map((r) => r.effectiveAt)).toEqual([T, T]);
  });

  it('granted during it: the grant, its first period and the end — in words', async () => {
    const w = makeTrialBillingWorld({ now: CLAIMED });
    const b = w.business({ name: 'Boutique' });
    await w.claim(b);
    w.clock.set(new Date(CLAIMED.getTime() + HOUR));
    await w.lifecycle.activateByGrant(w.uuid(b.companyId), { days: 30, reason: 'Pilot shop' }, CTX);
    await paidDuringTheTrial(w, b);
    w.clock.set(T);
    await w.entitlement.forCompany(b.companyId);

    const notes = notesOf(w, b);
    expect(notes.map((n) => n.kind)).toEqual(expect.arrayContaining(['trial_claimed', 'administrative_grant', 'renewed', 'seat_paid', 'trial_expired', 'branches_changed', 'seats_changed']));
    expectNoInstant(notes);
    expect(notes.find((n) => n.kind === 'administrative_grant')!.note).toBe('Pilot shop');
    expect(notes.find((n) => n.kind === 'renewed')!.note).toBe("First billing period opens when the free trial ends, at today's size and the prices in force then.");
    expect(w.periods(b)[0].periodStart).toEqual(T);
  });

  it('no paid access by the end: what was paid for waits, and the notes say so without a date', async () => {
    const w = makeTrialBillingWorld({ now: CLAIMED });
    const b = w.business({ name: 'Boutique' });
    await w.claim(b);
    w.clock.set(new Date(CLAIMED.getTime() + HOUR));
    await paidDuringTheTrial(w, b);
    w.clock.set(new Date(T.getTime() + HOUR));
    await w.entitlement.forCompany(b.companyId);

    const notes = notesOf(w, b);
    expectNoInstant(notes);
    expect(notes.filter((n) => n.kind === 'seat_paid').map((n) => n.note)).toEqual([
      'Store "B": payment confirmed, reference BK-1. It opens when paid access starts after the free trial; its first paid month starts then.',
      'Seat at Main: payment confirmed, reference BK-2. It starts when paid access starts after the free trial; its first paid month starts then.',
    ]);
    expect(notes.filter((n) => n.kind === 'trial_expired').map((n) => n.note)).toEqual(['The 7-day free trial ended. Nothing was charged.']);
  });
});
