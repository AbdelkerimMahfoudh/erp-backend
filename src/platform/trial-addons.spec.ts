import { Logger } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { ALWAYS_ALLOWED } from '../entitlement/route-classification';
import { CTX, DAY, HOUR, makeTrialBillingWorld, type Business, type TrialBillingWorld, type WorldOptions } from './__testing__/trial-billing-world';
import { PlatformController } from './platform.controller';

/**
 * Additional stores and paid employee seats during the free trial — the owner's correction of 2026-10-15 (D176).
 *
 * A request is not refused because a trial runs. The trial covers the first store and its included seat; another
 * store or a paid seat may be asked for, quoted and paid for during it, and then waits — `scheduled` — until the
 * trial ends: its activation and its first paid period begin exactly then, it is charged once, nothing paid for
 * consumes an entitlement before its date, and the trial is never shortened, replaced or extended.
 *
 * Driven through the real services over one in-memory database (trial-billing-world): every figure below is what the
 * shop was actually charged. Each `describe` is one of the owner's required tests, by his wording.
 */

const CLAIMED = new Date('2026-10-14T09:30:00.123Z');
const T = new Date(CLAIMED.getTime() + 168 * HOUR);
const OWNER = 'user:owner';

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/** A self-registered business whose Owner claimed the trial at CLAIMED; the clock an hour later. */
async function trialWorld(opts: { approve?: boolean; plans?: WorldOptions['plans'] } = {}) {
  const w = makeTrialBillingWorld({ now: CLAIMED, plans: opts.plans });
  const b = w.business({ name: 'Boutique' });
  await w.claim(b);
  w.clock.set(new Date(CLAIMED.getTime() + HOUR));
  if (opts.approve) await approve(w, b);
  return { w, b };
}

const approve = (w: TrialBillingWorld, b: Business, months = 1) => w.lifecycle.approve(w.uuid(b.companyId), { months, reason: 'paid by transfer' }, CTX);
const askStore = (w: TrialBillingWorld, b: Business, name = 'B') => w.seats.requestStore(b.companyId, { name, activity: 'electronics', requestedBy: OWNER });
const askSeat = (w: TrialBillingWorld, b: Business, userId: Buffer | null = null, store = 'Main') =>
  w.seats.requestSeat(b.companyId, { branchId: b.stores[store], userId, requestedBy: OWNER });

/** A store B and a seat at Main for a verified pending person, both confirmed during the trial. */
async function scheduledStoreAndSeat(w: TrialBillingWorld, b: Business) {
  const person = w.person(b, { name: 'Sara', stores: ['Main'], verified: true });
  // Main's included seat is taken: Sara needs a paid one.
  w.person(b, { name: 'Ali', stores: ['Main'], active: true });
  const store = (await askStore(w, b)).allocation.id;
  const seat = (await askSeat(w, b, person)).allocation.id;
  await w.confirm(store, 500, { reference: 'BK-1' });
  await w.confirm(seat, 100, { reference: 'BK-2' });
  return { person, store, seat };
}

describe('1. store requested during trial', () => {
  it('is allowed while the trial runs, priced, and waits for payment — nothing opened, counted or billed', async () => {
    expect(ALWAYS_ALLOWED.some((r) => r.method === 'POST' && r.path === 'platform/my-subscription/store-requests')).toBe(true);
    const { w, b } = await trialWorld();
    const versionBefore = w.subscription(b).version;
    const r = await askStore(w, b);
    expect(r.created).toBe(true);
    expect(r.allocation).toMatchObject({ kind: 'store', status: 'pending_payment', monthlyAmount: 500, label: 'B', activityTo: 'electronics', effectiveAt: null, activation: null });
    expect(w.branch(b, 'B')).toBeNull();
    expect(w.branches(b)).toHaveLength(1);
    expect(w.subscription(b)).toMatchObject({ subscribedBranchCount: 1, version: versionBefore });
    expect(w.periods(b)).toEqual([]);
    expect(w.payments(b)).toEqual([]);
    expect(w.events(b, 'store_requested')).toHaveLength(1);
  });

  it('approved during the trial at a plan version of 450, it is quoted at the first period’s own copied price', async () => {
    const { w, b } = await trialWorld({
      plans: [{ effectiveFrom: new Date('2026-01-01T00:00:00Z') }, { effectiveFrom: new Date(CLAIMED.getTime() + DAY), branchMonthly: 450 }],
    });
    w.clock.set(new Date(CLAIMED.getTime() + 2 * DAY));
    await approve(w, b);
    expect(w.periods(b)[0]).toMatchObject({ periodStart: T, branchMonthly: 450 });
    expect((await askStore(w, b)).allocation.monthlyAmount).toBe(450);
  });

  it('the same name again is the request that exists — while it waits for payment, and once it is scheduled', async () => {
    const { w, b } = await trialWorld();
    const first = await askStore(w, b);
    const again = await askStore(w, b);
    expect(again).toMatchObject({ created: false, allocation: { id: first.allocation.id, status: 'pending_payment' } });
    await w.confirm(first.allocation.id, 500);
    const scheduled = await askStore(w, b);
    expect(scheduled).toMatchObject({ created: false, allocation: { id: first.allocation.id, status: 'scheduled' } });
    expect(w.requests(b)).toHaveLength(1);
  });
});

describe('3. payment confirmed during trial', () => {
  for (const approved of [true, false]) {
    it(`a store and a seat are scheduled for the trial’s end — ${approved ? 'paid access approved' : 'no paid access yet'}`, async () => {
      const { w, b } = await trialWorld({ approve: approved });
      const person = w.person(b, { name: 'Sara', stores: ['Main'], verified: true });
      w.person(b, { name: 'Ali', stores: ['Main'], active: true });
      const store = (await askStore(w, b)).allocation.id;
      const seat = (await askSeat(w, b, person)).allocation.id;
      w.clock.set(new Date(T.getTime() - HOUR));
      const versionBefore = w.subscription(b).version;
      const periodsBefore = JSON.stringify(w.periods(b));
      const assess = jest.spyOn(w.billing, 'assessNow');
      // The instant is read after the lock: a confirmation that waited for it is dated when it ran.
      w.hooks.onLock = (_company, nowait) => {
        if (!nowait) w.clock.advance(1_500);
      };
      const r = await w.confirm(store, '500', { reference: 'BK-1' });
      w.hooks.onLock = null;
      const locked = new Date(T.getTime() - HOUR + 1_500);

      expect(r.applied).toBe(true);
      expect(r.allocation).toMatchObject({ status: 'scheduled', effectiveAt: T.toISOString(), confirmedAt: locked.toISOString() });
      expect(r.paymentId).toEqual(expect.any(String));
      expect(r.allocation.activation).toEqual({ startsAt: T.toISOString(), timeZone: 'Africa/Casablanca', waitsFor: approved ? 'trial_end' : 'paid_access' });
      expect(w.payments(b).map((p) => [p.amount.toString(), p.reference])).toEqual([['500', 'BK-1']]);
      expect(w.branch(b, 'B')).toBeNull();
      expect(w.subscription(b)).toMatchObject({ subscribedBranchCount: 1, version: versionBefore });
      expect(JSON.stringify(w.periods(b))).toBe(periodsBefore);
      expect(assess).not.toHaveBeenCalled();
      // The timeline says when in words, never as an instant (C7): the date travels as `activation.startsAt`.
      expect(w.events(b, 'seat_paid').map((e) => e.note)).toEqual([
        approved
          ? 'Store "B": payment confirmed, reference BK-1. It opens when the free trial ends; its first paid month starts then.'
          : 'Store "B": payment confirmed, reference BK-1. It opens when paid access starts after the free trial; its first paid month starts then.',
      ]);
      expect(w.audits(b, 'store.payment_confirm').map((a) => a.afterJson)).toEqual([
        expect.objectContaining({ status: 'scheduled', startsAt: T.toISOString(), storeToOpen: 'B', providerVerified: false }),
      ]);

      const s = await w.confirm(seat, '100', { reference: 'BK-2' });
      expect(s.allocation).toMatchObject({ status: 'scheduled', effectiveAt: T.toISOString() });
      // What the controller asks next: the person waits for the trial's end, and nothing is priced again.
      const requests = w.requests(b).length;
      await expect(w.activation.tryActivate(person, 'ops@example.test')).resolves.toEqual({ activated: false, alreadyActive: false, pending: ['seat_scheduled'] });
      expect(w.requests(b)).toHaveLength(requests);
    });
  }
});

describe('4. no immediate billing period', () => {
  it('paid for with no approval: no period at all; approved afterwards: one, starting at the trial’s end, at the base only', async () => {
    const { w, b } = await trialWorld();
    await scheduledStoreAndSeat(w, b);
    expect(w.periods(b)).toEqual([]);
    await approve(w, b);
    expect(w.periods(b)).toHaveLength(1);
    expect(w.periods(b)[0]).toMatchObject({ periodStart: T, assessedTotal: 500, activeBranchCount: 1, assessedStaffFee: 0 });
    expect(Object.keys(w.periods(b)[0].assessedActivityFeeByBranch)).toEqual([w.uuid(b.stores.Main)]);
  });

  it('approved first, then paid for before the end: the first period stays at the base', async () => {
    const { w, b } = await trialWorld({ approve: true });
    await scheduledStoreAndSeat(w, b);
    expect(w.periods(b)).toHaveLength(1);
    expect(w.periods(b)[0]).toMatchObject({ periodStart: T, assessedTotal: 500, activeBranchCount: 1, assessedStaffFee: 0 });
  });
});

describe('5. no immediate activation', () => {
  it('to the last millisecond of the trial nothing scheduled is open, counted, offered or activated', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { person, store, seat } = await scheduledStoreAndSeat(w, b);
    w.clock.set(new Date(T.getTime() - 1));
    const e = await w.entitlement.forCompany(b.companyId);
    const may = await w.entitlement.maySeat(b.companyId, [b.stores.Main]);
    const tried = await w.activation.tryActivate(person, 'person');
    const options = await w.seats.activityOptions(b.companyId);
    await w.sweeper.sweep();

    expect(w.branches(b)).toHaveLength(1);
    expect(w.t.userBranch.filter((ub) => ub.userId.equals(b.ownerId))).toHaveLength(1);
    expect(e.seatsByStore).toEqual([expect.objectContaining({ name: 'Main', paidSeats: 0 })]);
    expect(may.stores).toEqual([expect.objectContaining({ name: 'Main', paidSeats: 0 })]);
    expect(tried).toEqual({ activated: false, alreadyActive: false, pending: ['seat_scheduled'] });
    expect(w.user(person).isActive).toBe(false);
    // No store B exists, so no activity request can name it and the options list only Main.
    expect(options.stores.map((s) => s.name)).toEqual(['Main']);
    expect([w.request(store).status, w.request(seat).status]).toEqual(['scheduled', 'scheduled']);
    expect(w.events(b, 'trial_expired')).toEqual([]);
    expect(w.claimOf(b)!.expiryRecordedAt).toBeNull();
  });
});

describe('6. exact activation at trial expiry', () => {
  for (const [label, at] of [
    ['one evaluation at exactly the end', T],
    ['a first evaluation five minutes after it', new Date(T.getTime() + 5 * 60_000)],
  ] as const) {
    it(`${label}: the record once, the store opened and the seat in force — stamped at the end — and the first period raised by each`, async () => {
      const { w, b } = await trialWorld({ approve: true });
      const { person, store, seat } = await scheduledStoreAndSeat(w, b);
      const versionBefore = w.subscription(b).version;
      w.clock.set(at);
      const e = await w.entitlement.forCompany(b.companyId);

      expect(w.claimOf(b)!.expiryRecordedAt).toEqual(at);
      expect(w.events(b, 'trial_expired').map((x) => x.note)).toEqual([`The 7-day free trial ended at ${T.toISOString()}. Nothing was charged.`]);
      expect(w.audits(b, 'trial.expired')).toHaveLength(1);

      const opened = w.branch(b, 'B')!;
      expect(opened).toMatchObject({ activity: 'electronics', isActive: true });
      expect(w.request(store)).toMatchObject({ status: 'paid', effectiveAt: T, branchId: opened.id });
      expect(w.request(seat)).toMatchObject({ status: 'paid', effectiveAt: T });
      expect(w.t.userBranch.filter((ub) => ub.branchId.equals(opened.id)).map((ub) => ub.userId)).toEqual([b.ownerId]);
      expect(w.subscription(b)).toMatchObject({ subscribedBranchCount: 2, version: versionBefore + 1 });

      const [p1] = w.periods(b);
      expect(p1).toMatchObject({ periodStart: T, assessedTotal: 1100, assessedBranchFee: 1000, assessedStaffFee: 100, activeBranchCount: 2 });
      expect(w.user(person)).toMatchObject({ isActive: true, activatedAt: at });
      expect(w.events(b, 'staff_activated')).toHaveLength(1);
      expect(w.audits(b, 'store.activate').map((a) => a.afterJson)).toEqual([
        expect.objectContaining({ periodId: w.uuid(p1.id), paymentId: w.uuid(w.request(store).paymentId), effectiveAt: T.toISOString(), raisedBy: 500 }),
      ]);
      expect(w.audits(b, 'seat.activate').map((a) => a.afterJson)).toEqual([expect.objectContaining({ raisedBy: 100 })]);
      // The very evaluation that did it answers with it.
      expect(e).toMatchObject({ state: 'active', activeBranchCount: 2, subscribedBranchCount: 2 });
    });
  }

  it('the store cannot be created: the record stands, nothing is half-done, and the next attempt succeeds', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { store } = await scheduledStoreAndSeat(w, b);
    w.clock.set(T);
    w.hooks.failBranchCreate = 1;
    await w.entitlement.forCompany(b.companyId);
    expect(w.claimOf(b)!.expiryRecordedAt).toEqual(T);
    expect(w.request(store).status).toBe('scheduled');
    expect(w.periods(b)[0].assessedTotal).toBe(500);
    expect(w.branch(b, 'B')).toBeNull();
    await w.trialEnd.applyIfDue(b.companyId);
    expect(w.request(store).status).toBe('paid');
    expect(w.periods(b)[0].assessedTotal).toBe(1100);
  });
});

describe('8. duplicate payment confirmation', () => {
  it('again, sequentially: nothing new — the same payment; with a stale version: refused', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { allocation } = await askStore(w, b);
    const first = await w.confirm(allocation.id, 500, { reference: 'BK-1' });
    const again = await w.confirm(allocation.id, 500, { reference: 'BK-1-retry' });
    expect(again).toMatchObject({ applied: false, paymentId: first.paymentId, allocation: { status: 'scheduled' } });
    expect(w.payments(b)).toHaveLength(1);
    const stale = await w.confirm(allocation.id, 500, { reference: 'BK-9', expectedVersion: 0 }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ConflictException);
    expect((stale as ConflictException).getResponse()).toMatchObject({ code: 'seat_request_changed' });
    expect(w.payments(b)).toHaveLength(1);
  });

  it('two at once: one is scheduled, the other is refused, and only one payment exists', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { allocation } = await askStore(w, b);
    const outcomes = await Promise.allSettled([w.confirm(allocation.id, 500, { reference: 'BK-A' }), w.confirm(allocation.id, 500, { reference: 'BK-B' })]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as ConflictException).getResponse()).toMatchObject({ code: 'seat_request_changed' });
    expect(w.payments(b)).toHaveLength(1);
    expect(w.request(allocation.id).status).toBe('scheduled');
  });

  it('after the activation: nothing new — one store, the period as it was, no request for anybody', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { person, store } = await scheduledStoreAndSeat(w, b);
    w.clock.set(T);
    await w.trialEnd.applyIfDue(b.companyId);
    const total = w.periods(b)[0].assessedTotal;
    const again = await w.confirm(store, 500, { reference: 'BK-1' });
    expect(again).toMatchObject({ applied: false, allocation: { status: 'paid' } });
    expect(w.branches(b).filter((x) => x.name === 'B')).toHaveLength(1);
    expect(w.periods(b)[0].assessedTotal).toBe(total);
    const requests = w.requests(b).length;
    await w.activation.tryActivate(person, 'ops@example.test');
    expect(w.requests(b)).toHaveLength(requests);
  });
});

describe('10. unpaid request at expiry', () => {
  it('approved business: at the end the unpaid request stays waiting; paid afterwards it takes effect at once, charged once', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { allocation } = await askStore(w, b);
    w.clock.set(T);
    await w.entitlement.forCompany(b.companyId);
    expect(w.request(allocation.id).status).toBe('pending_payment');
    expect(w.branch(b, 'B')).toBeNull();
    expect(w.periods(b)[0].assessedTotal).toBe(500);
    expect(w.audits(b).filter((a) => /activate/.test(a.action))).toEqual([]);

    const later = new Date(T.getTime() + HOUR);
    w.clock.set(later);
    const r = await w.confirm(allocation.id, 500, { reference: 'BK-late' });
    expect(r.allocation).toMatchObject({ status: 'paid', confirmedAt: later.toISOString(), effectiveAt: null, activation: null });
    expect(w.branch(b, 'B')).not.toBeNull();
    expect(w.periods(b)[0].assessedTotal).toBe(1000);
    await w.confirm(allocation.id, 500, { reference: 'BK-late' });
    expect(w.periods(b)[0].assessedTotal).toBe(1000);
  });

  it('no paid access: confirming after the end is refused and writes nothing; after the approval it takes effect at once', async () => {
    const { w, b } = await trialWorld();
    const { allocation } = await askStore(w, b);
    w.clock.set(new Date(T.getTime() + HOUR));
    const refused = await w.confirm(allocation.id, 500, { reference: 'BK-late' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'paid_period_not_started' });
    expect(w.payments(b)).toEqual([]);
    expect(w.request(allocation.id)).toMatchObject({ status: 'pending_payment', version: 0 });

    await approve(w, b);
    const r = await w.confirm(allocation.id, 500, { reference: 'BK-late' });
    expect(r.allocation).toMatchObject({ status: 'paid', effectiveAt: null });
    expect(w.periods(b)).toHaveLength(1);
    expect(w.periods(b)[0].assessedTotal).toBe(1000);
  });
});

describe('the scheduled requests as the website and the console read them', () => {
  it('the Owner’s list and the console’s queue carry each start in its own business’s zone, and what it waits for', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const other = w.business({ name: 'Other', timezone: 'Europe/Paris' });
    await w.claim(other);
    const { store, seat } = await scheduledStoreAndSeat(w, b);
    const theirs = (await askStore(w, other, 'Annex')).allocation.id;
    await w.confirm(theirs, 500, { reference: 'BK-O' });

    const list = await w.seats.listForCompany(b.companyId);
    expect(list.filter((r) => r.status === 'scheduled').map((r) => [r.id, r.activation])).toEqual(
      expect.arrayContaining([
        [store, { startsAt: T.toISOString(), timeZone: 'Africa/Casablanca', waitsFor: 'trial_end' }],
        [seat, { startsAt: T.toISOString(), timeZone: 'Africa/Casablanca', waitsFor: 'trial_end' }],
      ]),
    );
    const queue = await w.seats.queue('scheduled');
    const byId = new Map(queue.map((r) => [r.id, r]));
    expect(byId.get(store)!.activation).toEqual({ startsAt: T.toISOString(), timeZone: 'Africa/Casablanca', waitsFor: 'trial_end' });
    // The other business claimed later and has no paid access: its own end, its own zone, waiting for paid access.
    expect(byId.get(theirs)!.activation).toMatchObject({ timeZone: 'Europe/Paris', waitsFor: 'paid_access' });
    expect(byId.get(theirs)!.business.name).toBe('Other');
    // Every other status carries no start.
    expect((await w.seats.queue('pending_payment')).every((r) => r.activation === null)).toBe(true);
  });

  /** The console's business page and the Owner's account page, over the world; the timeline is not what is asked. */
  const pagesOf = (w: TrialBillingWorld, b: Business) => {
    const unused = {} as never;
    return new PlatformController(
      w.db as never,
      unused,
      unused,
      { timeline: async () => ({ events: [], payments: [] }) } as never,
      unused,
      w.billing,
      unused,
      w.entitlement,
      { companyId: () => b.companyId } as never,
      unused,
      unused,
      unused,
    );
  };

  it('the console’s business page, the first look after the end, is read after the activation it causes — the store, the record, the version', async () => {
    const { w, b } = await trialWorld({ approve: true });
    await scheduledStoreAndSeat(w, b);
    const versionBefore = w.subscription(b).version;
    const at = new Date(T.getTime() + 5 * 60_000);
    w.clock.set(at);
    const page = await pagesOf(w, b).business(w.uuid(b.companyId));
    expect(w.subscription(b).version).toBe(versionBefore + 1);
    // The version the console sends back with its next action: the one after the activation, never the one before it.
    expect(page).toMatchObject({
      version: versionBefore + 1,
      branches: [expect.objectContaining({ name: 'Main' }), expect.objectContaining({ name: 'B' })],
      entitlement: { state: 'active', activeBranchCount: 2, subscribedBranchCount: 2 },
      trial: { claim: { endsAt: T.toISOString(), expiryRecordedAt: at.toISOString() } },
    });
  });

  it('the Owner’s account page, the first look after the end, lists, counts and prices the store the evaluation opened', async () => {
    const { w, b } = await trialWorld({ approve: true });
    await scheduledStoreAndSeat(w, b);
    w.clock.set(new Date(T.getTime() + 5 * 60_000));
    const page = await pagesOf(w, b).mySubscription();
    expect(page.business.branches.map((x) => x.name)).toEqual(['Main', 'B']);
    expect(page.entitlement).toMatchObject({ state: 'active', activeBranchCount: 2, subscribedBranchCount: 2 });
    expect(page.pricing.currentPeriod).toMatchObject({ periodStart: T.toISOString(), assessedTotal: 1100, available: true });
  });
});
