import { Logger } from '@nestjs/common';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SubscriptionRenewal } from '../billing/renewal';
import { ALWAYS_ALLOWED } from '../entitlement/route-classification';
import { CTX, DAY, HOUR, makeTrialBillingWorld, type Business, type TrialBillingWorld, type WorldOptions } from './__testing__/trial-billing-world';
import { PlatformController } from './platform.controller';
import { SeatRequestsController } from './seat-requests.controller';
import { scheduledCoverage } from './staff-activation-rules';

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

/** The person proves their contact (the code itself is the verification service's, not what is asked here). */
const proves = (w: TrialBillingWorld, id: Buffer | string) => {
  const row = w.t.user.find((u) => w.uuid(u.id) === (typeof id === 'string' ? id : w.uuid(id)))!;
  // The WhatsApp number is what activation waits for (D214); an email address never holds it back.
  row.phoneVerifiedAt = w.clock.now();
};
/** Real instants apart: an invitation is stamped by the wall clock, and coverage follows the invitation order. */
const aMomentLater = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('2. paid seat requested during trial', () => {
  it('a seat the website asks for, naming nobody: priced at 100, counted nowhere until the end — then held, and charged once', async () => {
    const { w, b } = await trialWorld({ approve: true });
    w.person(b, { name: 'Ali', stores: ['Main'], active: true });
    const mayBefore = await w.entitlement.maySeat(b.companyId, [b.stores.Main]);
    const r = await askSeat(w, b);
    expect(r.created).toBe(true);
    expect(r.allocation).toMatchObject({ kind: 'seat', status: 'pending_payment', monthlyAmount: 100, person: null });

    await w.confirm(r.allocation.id, 100, { reference: 'BK-S' });
    expect(w.request(r.allocation.id)).toMatchObject({ status: 'scheduled', effectiveAt: T });
    const census = await w.entitlement.forCompany(b.companyId);
    const may = await w.entitlement.maySeat(b.companyId, [b.stores.Main]);
    expect(census.seatsByStore).toEqual([expect.objectContaining({ name: 'Main', paidSeats: 0 })]);
    expect(may).toEqual(mayBefore);
    expect(may.allowed).toBe(false);
    expect(w.periods(b)[0]).toMatchObject({ assessedStaffFee: 0, assessedTotal: 500 });

    w.clock.set(T);
    const after = await w.entitlement.maySeat(b.companyId, [b.stores.Main]);
    expect(after).toMatchObject({ allowed: true, stores: [expect.objectContaining({ name: 'Main', paidSeats: 1 })] });
    expect(w.periods(b)[0]).toMatchObject({ assessedStaffFee: 100, assessedTotal: 600 });
    expect(w.payments(b)).toHaveLength(1);
  });

  it('a person added at a full store: one request, priced; added again — before payment and once paid — the same one', async () => {
    const { w, b } = await trialWorld({ approve: true });
    w.person(b, { name: 'Ali', stores: ['Main'], active: true });
    const team = w.staff(b);
    const sara = { name: 'Sara', phone: '+22236000001', email: 'sara@shop.test', branchIds: [w.uuid(b.stores.Main)], role: 'store_employee' as const };
    const first = await team.invite(sara);
    expect(first).toMatchObject({ created: true, seats: [{ store: 'Main', state: 'awaiting_payment' }] });
    expect(w.requests(b)).toEqual([expect.objectContaining({ kind: 'seat', status: 'pending_payment', monthlyAmount: 100 })]);

    const again = await team.invite(sara);
    expect(again).toMatchObject({ created: false, user: { id: first.user.id } });
    expect(w.requests(b)).toHaveLength(1);

    await w.confirm(w.uuid(w.requests(b)[0].id), 100, { reference: 'BK-S' });
    const held = await team.invite(sara);
    // Paid during the trial: hers, shown as held, in force when the trial ends — never asked for again.
    expect(held).toMatchObject({ created: false, seats: [{ store: 'Main', state: 'held' }], activation: { pending: ['phone_verification', 'seat_scheduled'] } });
    proves(w, first.user.id);
    await expect(w.activation.tryActivate(Buffer.from(first.user.id.replace(/-/g, ''), 'hex'), 'person')).resolves.toMatchObject({ activated: false, pending: ['seat_scheduled'] });
    expect(w.requests(b)).toHaveLength(1);
    expect(w.payments(b)).toHaveLength(1);
  });

  it('a seat bought naming nobody seats the first person added after it — no second request — and the next one is priced', async () => {
    const { w, b } = await trialWorld({ approve: true });
    w.person(b, { name: 'Ali', stores: ['Main'], active: true });
    const seat = (await askSeat(w, b)).allocation.id;
    await w.confirm(seat, 100, { reference: 'BK-S' });

    const team = w.staff(b);
    const main = [w.uuid(b.stores.Main)];
    const tom = await team.invite({ name: 'Tom', phone: '+22236000002', email: 'tom@shop.test', branchIds: main, role: 'store_employee' });
    await aMomentLater();
    const uma = await team.invite({ name: 'Uma', phone: '+22236000003', email: 'uma@shop.test', branchIds: main, role: 'store_employee' });
    const asked = (id: string) => w.requests(b).filter((r) => r.userId && w.uuid(r.userId) === id);
    // Tom is covered by the seat already bought; Uma, invited after him, is priced one of her own.
    expect(asked(tom.user.id)).toEqual([]);
    expect(tom.activation.pending).toEqual(['phone_verification', 'seat_scheduled']);
    expect(asked(uma.user.id)).toEqual([expect.objectContaining({ status: 'pending_payment', monthlyAmount: 100 })]);

    proves(w, tom.user.id);
    proves(w, uma.user.id);
    const tomId = Buffer.from(tom.user.id.replace(/-/g, ''), 'hex');
    const umaId = Buffer.from(uma.user.id.replace(/-/g, ''), 'hex');
    await expect(w.activation.tryActivate(tomId, 'person')).resolves.toEqual({ activated: false, alreadyActive: false, pending: ['seat_scheduled'] });
    await expect(w.activation.tryActivate(umaId, 'person')).resolves.toEqual({ activated: false, alreadyActive: false, pending: ['seat_payment'] });
    expect(w.requests(b)).toHaveLength(2);

    w.clock.set(T);
    await w.sweeper.sweep();
    expect(w.user(tomId)).toMatchObject({ isActive: true, activatedAt: T });
    expect(w.events(b, 'staff_activated').map((e) => e.note)).toEqual([expect.stringMatching(/^Tom activated at Main/)]);
    expect(w.user(umaId).isActive).toBe(false);
    expect(asked(uma.user.id)[0].status).toBe('pending_payment');
    expect(w.periods(b)[0]).toMatchObject({ assessedStaffFee: 100, assessedTotal: 600 });
    expect(w.requests(b)).toHaveLength(2);
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
      // No instant in the note (C7): the end is the claim's own, kept as data in the audit.
      expect(w.events(b, 'trial_expired').map((x) => x.note)).toEqual(['The 7-day free trial ended. Nothing was charged.']);
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
    const { person, store, seat } = await scheduledStoreAndSeat(w, b);
    const versionBefore = w.subscription(b).version;
    w.clock.set(T);
    w.hooks.failBranchCreate = 1;
    await w.entitlement.forCompany(b.companyId);
    // Tx A committed; Tx B rolled back whole — the seat beside the store included.
    expect(w.claimOf(b)!.expiryRecordedAt).toEqual(T);
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    expect([w.request(store).status, w.request(seat).status]).toEqual(['scheduled', 'scheduled']);
    expect(w.periods(b)[0].assessedTotal).toBe(500);
    expect(w.branch(b, 'B')).toBeNull();
    expect(w.subscription(b).version).toBe(versionBefore);
    expect(w.user(person).isActive).toBe(false);
    expect(w.audits(b).filter((a) => /\.activate$/.test(a.action))).toEqual([]);

    await w.trialEnd.applyIfDue(b.companyId);
    expect([w.request(store).status, w.request(seat).status]).toEqual(['paid', 'paid']);
    expect(w.periods(b)[0].assessedTotal).toBe(1100);
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
  });
});

describe('7. one charge only', () => {
  const grant = (w: TrialBillingWorld, b: Business) => w.lifecycle.activateByGrant(w.uuid(b.companyId), { days: 30, reason: 'pilot shop' }, CTX);

  /** Everything the shop could be charged by, as it stands. */
  const ledger = (w: TrialBillingWorld, b: Business) =>
    JSON.stringify({
      periods: w.periods(b).map((p) => [p.periodStart.toISOString(), p.periodEnd?.toISOString() ?? null, p.assessedTotal, p.assessedBranchFee, p.assessedStaffFee]),
      payments: w.payments(b).map((p) => p.amount.toString()),
      stores: w.branches(b).map((x) => x.name),
      requests: w.requests(b).map((r) => [r.status, r.version]),
      activations: w.audits(b).filter((a) => /\.activate$/.test(a.action)).length,
    });

  /** Store B (500) and Sara's seat at Main (100) paid for during the trial — in the order each case says — then the end. */
  const cases: { order: string; run: (w: TrialBillingWorld, b: Business) => Promise<void>; earlier: number[] }[] = [
    {
      order: 'approved, then both confirmed during the trial',
      run: async (w, b) => {
        await approve(w, b);
        await scheduledStoreAndSeat(w, b);
      },
      earlier: [],
    },
    {
      order: 'both confirmed, then approved during the trial',
      run: async (w, b) => {
        await scheduledStoreAndSeat(w, b);
        await approve(w, b);
      },
      earlier: [],
    },
    {
      order: 'both confirmed between the approval’s decision and the opening of its first period',
      run: async (w, b) => {
        let between = false;
        w.hooks.onEvent = async (event) => {
          if (event.kind !== 'approved' || between) return;
          between = true;
          expect(w.periods(b)).toEqual([]);
          await scheduledStoreAndSeat(w, b);
        };
        await approve(w, b);
        w.hooks.onEvent = null;
        expect(between).toBe(true);
      },
      earlier: [],
    },
    {
      order: 'both confirmed during the trial, approved only a day after it ended',
      run: async (w, b) => {
        await scheduledStoreAndSeat(w, b);
        w.clock.set(new Date(T.getTime() + HOUR));
        await w.entitlement.forCompany(b.companyId);
        // Ended, recorded — and nothing in force without a paid period.
        expect(w.claimOf(b)!.expiryRecordedAt).not.toBeNull();
        expect(w.branch(b, 'B')).toBeNull();
        w.clock.set(new Date(T.getTime() + DAY));
        await approve(w, b);
        expect(w.periods(b)[0].periodStart).toEqual(new Date(T.getTime() + DAY));
      },
      earlier: [],
    },
    {
      order: 'granted during the trial, then both confirmed',
      run: async (w, b) => {
        await grant(w, b);
        await scheduledStoreAndSeat(w, b);
      },
      earlier: [],
    },
    {
      order: 'approved, both confirmed, then granted during the trial — the grant’s period is the one they join',
      run: async (w, b) => {
        await approve(w, b);
        await scheduledStoreAndSeat(w, b);
        await grant(w, b);
      },
      // The approval's first period, closed at the trial's end by the grant before it began (pre-existing, not an add-on's).
      earlier: [500],
    },
  ];

  /** One order, then the end: each add-on joins the latest period once, and nothing more is ever charged. */
  async function chargedOnce(run: (w: TrialBillingWorld, b: Business) => Promise<void>, earlier: number[], prepare?: (w: TrialBillingWorld, b: Business) => void) {
      const { w, b } = await trialWorld();
      prepare?.(w, b);
      await run(w, b);
      w.clock.set(new Date(Math.max(w.clock.now().getTime(), T.getTime()) + 5 * 60_000));
      await w.entitlement.forCompany(b.companyId);
      await w.sweeper.sweep();

      const joined = w.periods(b).at(-1)!;
      expect(joined).toMatchObject({ assessedTotal: 1100, assessedBranchFee: 1000, assessedStaffFee: 100, activeBranchCount: 2 });
      expect(w.periods(b).slice(0, -1).map((p) => p.assessedTotal)).toEqual(earlier);
      expect(w.payments(b).map((p) => p.amount.toString()).sort()).toEqual(['100', '500']);
      expect(w.branches(b).map((x) => x.name)).toEqual(['Main', 'B']);
      // Requests asked at the same instant are put in force in id order; which goes first changes no figure.
      const raised = w.audits(b)
        .filter((a) => /\.activate$/.test(a.action))
        .map((a) => [a.action, a.afterJson.raisedBy, a.afterJson.periodId])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      expect(raised).toEqual([
        ['seat.activate', 100, w.uuid(joined.id)],
        ['store.activate', 500, w.uuid(joined.id)],
      ]);
      expect(w.requests(b).map((r) => r.status)).toEqual(['paid', 'paid']);
      // Each in force from the start of the period it joined: the trial's end — or, approved only after it, the
      // approval (the period opened there at the base, and each add-on raised it by its own fee).
      expect(w.requests(b).map((r) => r.effectiveAt)).toEqual([joined.periodStart, joined.periodStart]);
      const opened = w.uuid(w.branch(b, 'B')!.id);
      expect(Object.keys(joined.assessedActivityFeeByBranch).sort()).toEqual([w.uuid(b.stores.Main), opened].sort());
      for (const p of w.periods(b).slice(0, -1)) expect(Object.keys(p.assessedActivityFeeByBranch ?? {})).not.toContain(opened);

      // Whoever looks again — the lazy path, the sweeper, a renewal check, a re-assessment, an administrator's
      // trigger — finds nothing more to charge.
      const settled = ledger(w, b);
      await w.trialEnd.applyIfDue(b.companyId);
      await w.trialEnd.applyIfDue(b.companyId, 'ops@example.test');
      await new SubscriptionRenewal(w.db as never, w.billing, w.clock).rollIfDue(b.companyId);
      await w.billing.assessNow(b.companyId);
      await w.billing.assessNow(b.companyId);
      await w.sweeper.sweep();
      await w.entitlement.forCompany(b.companyId);
      w.clock.advance(2 * 60_000);
      await w.entitlement.maySeat(b.companyId);
      expect(ledger(w, b)).toBe(settled);
  }

  for (const { order, run, earlier } of cases) {
    it(`${order}: each add-on raises the period it joins once — 500 and 100 — paid once, and nothing again on any re-run`, () => chargedOnce(run, earlier));
  }

  describe('the grant’s period is the latest whatever the periods’ ids (review 2026-10-16)', () => {
    const orderF = cases[cases.length - 1];

    it('twenty-five times with every id made in one millisecond (the clock frozen): the closed first period keeps the base; the add-ons join the grant’s once', async () => {
      expect(orderF.order).toMatch(/then granted during the trial/);
      for (let i = 0; i < 25; i += 1) {
        const frozen = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 16, 3, 0, 0, 0));
        try {
          await chargedOnce(orderF.run, orderF.earlier);
        } finally {
          frozen.mockRestore();
        }
      }
    });

    it('the first period written with the larger id — as an instance whose clock runs ahead would: the grant’s period is still the latest, and no renewal opens at the end', async () => {
      let ahead: Buffer | null = null;
      let seen: { w: TrialBillingWorld; b: Business } | null = null;
      await chargedOnce(orderF.run, orderF.earlier, (w, b) => {
        seen = { w, b };
        // The approval's first period, the moment it is written, takes an id from a clock three minutes ahead: larger
        // than the grant's, which comes later.
        w.hooks.onEvent = (event) => {
          if (event.kind !== 'renewed' || ahead) return;
          const [first] = w.periods(b);
          ahead = Buffer.from(first.id);
          ahead.writeUIntBE(ahead.readUIntBE(0, 6) + 3 * 60_000, 0, 6);
          first.id = ahead;
        };
      });
      expect(ahead).not.toBeNull();
      // Two periods, the closed first one holding the larger id — and the grant's the one every reader took.
      const { w, b } = seen as unknown as { w: TrialBillingWorld; b: Business };
      const [closed, granted] = w.periods(b);
      expect(closed.periodEnd).toEqual(closed.periodStart);
      expect(Buffer.compare(closed.id, granted.id)).toBeGreaterThan(0);
      expect((await w.billing.latestPeriod(b.companyId))?.id).toEqual(granted.id);
    });
  });

  it('R1, a store paid for before the approval: the first period opens at 500, not 1000; at the end it is 1000 — never 1500', async () => {
    const { w, b } = await trialWorld();
    const store = (await askStore(w, b)).allocation.id;
    await w.confirm(store, 500, { reference: 'BK-1' });
    await approve(w, b);
    expect(w.periods(b).map((p) => p.assessedTotal)).toEqual([500]);
    w.clock.set(T);
    await w.entitlement.forCompany(b.companyId);
    expect(w.periods(b).map((p) => p.assessedTotal)).toEqual([1000]);
    expect(w.payments(b).map((p) => p.amount.toString())).toEqual(['500']);
  });

  it('R1, approved first: the confirmation raises nothing and opens nothing during the trial; at the end 1000', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const store = (await askStore(w, b)).allocation.id;
    await w.confirm(store, 500, { reference: 'BK-1' });
    expect(w.periods(b).map((p) => p.assessedTotal)).toEqual([500]);
    expect(w.branches(b)).toHaveLength(1);
    w.clock.set(T);
    await w.entitlement.forCompany(b.companyId);
    expect(w.periods(b).map((p) => p.assessedTotal)).toEqual([1000]);
  });

  it('R1, the seat: the first period’s staff fee is 0 while the trial runs and 100 from its end — in either order', async () => {
    for (const approvedFirst of [true, false]) {
      const { w, b } = await trialWorld({ approve: approvedFirst });
      const sara = w.person(b, { name: 'Sara', stores: ['Main'], verified: true });
      w.person(b, { name: 'Ali', stores: ['Main'], active: true });
      const seat = (await askSeat(w, b, sara)).allocation.id;
      await w.confirm(seat, 100, { reference: 'BK-2' });
      if (!approvedFirst) await approve(w, b);
      expect(w.periods(b).map((p) => [p.assessedStaffFee, p.assessedTotal])).toEqual([[0, 500]]);
      w.clock.set(T);
      await w.entitlement.forCompany(b.companyId);
      expect(w.periods(b).map((p) => [p.assessedStaffFee, p.assessedTotal])).toEqual([[100, 600]]);
    }
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

describe('9. concurrent expiry and payment confirmation', () => {
  it('the row held by another writer at the end: every evaluation answers at once, nothing waits; released, it is done once', async () => {
    const { w, b } = await trialWorld({ approve: true });
    await scheduledStoreAndSeat(w, b);
    w.clock.set(T);
    const release = w.hold(b);
    const from = w.locks.length;
    // Twelve requests evaluating the business while the row is held: none waits for it (a wait would never end here).
    const answers = await Promise.all(Array.from({ length: 12 }, () => w.entitlement.forCompany(b.companyId)));
    expect(answers.every((e) => e.state === 'active')).toBe(true);
    const asked = w.locks.slice(from);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((l) => l.nowait && l.outcome === 'busy')).toBe(true);
    expect(w.claimOf(b)!.expiryRecordedAt).toBeNull();
    expect(w.requests(b).map((r) => r.status)).toEqual(['scheduled', 'scheduled']);
    // The administrator's trigger and the sweeper do not wait either. The sweeper looks again every second of its
    // pass (N2) — each look refused at once — and leaves the business to the next pass when the row stays held.
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('busy');
    let at = Date.now();
    const now = jest.spyOn(Date, 'now').mockImplementation(() => at);
    const pause = jest
      .spyOn(w.sweeper as unknown as { pause: (ms: number) => Promise<void> }, 'pause')
      .mockImplementation(async (ms: number) => void (at += ms));
    await expect(w.sweeper.sweep()).resolves.toMatchObject({ outcomes: { busy: 1 } });
    expect(pause).toHaveBeenCalledTimes(30);
    expect(w.locks.slice(from).every((l) => l.nowait && l.outcome === 'busy')).toBe(true);
    now.mockRestore();
    pause.mockRestore();

    release();
    w.clock.advance(1_000);
    await w.entitlement.forCompany(b.companyId);
    expect(w.claimOf(b)!.expiryRecordedAt).toEqual(new Date(T.getTime() + 1_000));
    expect(w.requests(b).map((r) => r.status)).toEqual(['paid', 'paid']);
    expect(w.periods(b)[0].assessedTotal).toBe(1100);
    await w.sweeper.sweep();
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    expect(w.audits(b).filter((a) => /\.activate$/.test(a.action))).toHaveLength(2);
  });

  it('confirmed a millisecond before the end, evaluated at the end and beside it: scheduled, then put in force once', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const store = (await askStore(w, b)).allocation.id;
    w.clock.set(new Date(T.getTime() - 1));
    const [confirmed] = await Promise.all([w.confirm(store, 500, { reference: 'BK-1' }), w.entitlement.forCompany(b.companyId)]);
    expect(confirmed.allocation).toMatchObject({ status: 'scheduled', effectiveAt: T.toISOString() });
    w.clock.set(T);
    await Promise.all([w.entitlement.forCompany(b.companyId), w.sweeper.sweep(), w.trialEnd.applyIfDue(b.companyId)]);
    expect(w.request(store)).toMatchObject({ status: 'paid', effectiveAt: T });
    expect(w.branches(b).filter((x) => x.name === 'B')).toHaveLength(1);
    expect(w.periods(b).map((p) => p.assessedTotal)).toEqual([1000]);
    expect(w.audits(b, 'store.activate')).toHaveLength(1);
  });

  for (const [label, at] of [
    ['exactly at the end', T],
    ['a millisecond after it', new Date(T.getTime() + 1)],
  ] as const) {
    it(`confirmed ${label} with the first paid period in force: in force at once, the period raised once — never scheduled`, async () => {
      const { w, b } = await trialWorld({ approve: true });
      const store = (await askStore(w, b)).allocation.id;
      w.clock.set(at);
      const [r] = await Promise.all([w.confirm(store, 500, { reference: 'BK-1' }), w.entitlement.forCompany(b.companyId)]);
      expect(r.allocation).toMatchObject({ status: 'paid', effectiveAt: null, activation: null, confirmedAt: at.toISOString() });
      expect(w.branches(b).filter((x) => x.name === 'B')).toHaveLength(1);
      expect(w.periods(b).map((p) => p.assessedTotal)).toEqual([1000]);
      await w.entitlement.forCompany(b.companyId);
      await w.sweeper.sweep();
      expect(w.periods(b).map((p) => p.assessedTotal)).toEqual([1000]);
      // The expiry was written down once, by whichever looked first.
      expect(w.events(b, 'trial_expired')).toHaveLength(1);
    });
  }

  it('confirmed a millisecond after the end with no paid period: refused with paid_period_not_started — no payment, nothing changed', async () => {
    const { w, b } = await trialWorld();
    const store = (await askStore(w, b)).allocation.id;
    w.clock.set(new Date(T.getTime() + 1));
    const refused = await w.confirm(store, 500, { reference: 'BK-1' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'paid_period_not_started' });
    expect(w.payments(b)).toEqual([]);
    expect(w.request(store)).toMatchObject({ status: 'pending_payment', version: 0, effectiveAt: null });
    expect(w.branches(b)).toHaveLength(1);
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

describe('11. cancelled or refused request', () => {
  const reason = { reason: 'not wanted after all' };
  const refuseOf = (w: TrialBillingWorld, id: string, expectedVersion?: number) =>
    w.seats.refuse(Buffer.from(id.replace(/-/g, ''), 'hex'), { ...reason, expectedVersion }, CTX);
  const releaseOf = (w: TrialBillingWorld, id: string) => w.seats.release(Buffer.from(id.replace(/-/g, ''), 'hex'), reason, CTX);
  const withdrawOf = (w: TrialBillingWorld, b: Business, id: string) =>
    w.seats.withdraw(b.companyId, Buffer.from(id.replace(/-/g, ''), 'hex'), OWNER);

  it('before payment, during the trial: withdrawn, refused, or the person’s account withdrawn — nothing paid, opened, counted or charged', async () => {
    const { w, b } = await trialWorld({ approve: true });
    w.person(b, { name: 'Ali', stores: ['Main'], active: true });
    const store = (await askStore(w, b)).allocation.id;
    const seat = (await askSeat(w, b)).allocation.id;
    const sara = await w.staff(b).invite({ name: 'Sara', phone: '+22236000001', email: 'sara@shop.test', branchIds: [w.uuid(b.stores.Main)], role: 'store_employee' });
    const saras = w.uuid(w.requests(b).find((r) => r.userId && w.uuid(r.userId) === sara.user.id)!.id);

    await expect(withdrawOf(w, b, store)).resolves.toMatchObject({ applied: true, allocation: { status: 'released' } });
    await expect(refuseOf(w, seat)).resolves.toMatchObject({ applied: true, allocation: { status: 'refused' } });
    await expect(w.staff(b).cancel(sara.user.id)).resolves.toEqual({ cancelled: true });
    expect([w.request(store).status, w.request(seat).status, w.request(saras).status]).toEqual(['released', 'refused', 'released']);

    // A refused request is not paid for afterwards.
    const late = await w.confirm(seat, 100, { reference: 'BK-9' }).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(BadRequestException);
    w.clock.set(T);
    await w.entitlement.forCompany(b.companyId);
    await w.sweeper.sweep();
    expect(w.payments(b)).toEqual([]);
    expect(w.branches(b).map((x) => x.name)).toEqual(['Main']);
    expect(w.periods(b).map((p) => p.assessedTotal)).toEqual([500]);
    expect(w.audits(b).filter((a) => /\.activate$/.test(a.action))).toEqual([]);
  });

  it('once scheduled: it cannot be withdrawn, refused or released — paid is paid — and it is put in force at the end', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { store, seat } = await scheduledStoreAndSeat(w, b);
    const snapshot = () => JSON.stringify([w.request(store), w.request(seat), w.subscription(b).version]);
    const before = snapshot();

    for (const id of [store, seat]) {
      await expect(withdrawOf(w, b, id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(refuseOf(w, id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(releaseOf(w, id)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(snapshot()).toBe(before);

    w.clock.set(T);
    await w.entitlement.forCompany(b.companyId);
    expect([w.request(store).status, w.request(seat).status]).toEqual(['paid', 'paid']);
    expect(w.periods(b)[0].assessedTotal).toBe(1100);
  });

  it('the account of a person whose seat was paid during the trial is withdrawn: the seat stays paid, and is the store’s at the end', async () => {
    const { w, b } = await trialWorld({ approve: true });
    w.person(b, { name: 'Ali', stores: ['Main'], active: true });
    const team = w.staff(b);
    const main = [w.uuid(b.stores.Main)];
    const sara = await team.invite({ name: 'Sara', phone: '+22236000001', email: 'sara@shop.test', branchIds: main, role: 'store_employee' });
    const seat = w.uuid(w.requests(b)[0].id);
    await w.confirm(seat, 100, { reference: 'BK-S' });
    await team.cancel(sara.user.id);
    expect(w.request(seat).status).toBe('scheduled');

    // Nobody holds it now: the next person added there is seated by it, not priced again.
    await aMomentLater();
    const tom = await team.invite({ name: 'Tom', phone: '+22236000002', email: 'tom@shop.test', branchIds: main, role: 'store_employee' });
    expect(w.requests(b)).toHaveLength(1);
    proves(w, tom.user.id);
    w.clock.set(T);
    await w.sweeper.sweep();
    expect(w.request(seat).status).toBe('paid');
    expect(w.user(Buffer.from(tom.user.id.replace(/-/g, ''), 'hex'))).toMatchObject({ isActive: true, activatedAt: T });
    expect(w.periods(b)[0]).toMatchObject({ assessedStaffFee: 100, assessedTotal: 600 });
  });

  for (const [who, closes, closed] of [
    ['refused by the Super Admin', (w: TrialBillingWorld, _b: Business, id: string) => refuseOf(w, id, 0), 'refused'],
    ['withdrawn by the Owner', (w: TrialBillingWorld, b: Business, id: string) => withdrawOf(w, b, id), 'released'],
  ] as const) {
    it(`${who} while the confirmation holds the lock: the closing stands, the confirmation is refused and its payment taken back`, async () => {
      const { w, b } = await trialWorld({ approve: true });
      const store = (await askStore(w, b)).allocation.id;
      let closing: Promise<unknown> | null = null;
      // Neither takes the subscription lock to close a request: it lands while the confirmation is deciding.
      w.hooks.onLock = async (_company, nowait) => {
        if (nowait || closing) return;
        closing = closes(w, b, store);
        await closing;
      };
      const confirmed = await w.confirm(store, 500, { reference: 'BK-1', expectedVersion: 0 }).catch((e: unknown) => e);
      w.hooks.onLock = null;
      await expect(closing).resolves.toMatchObject({ applied: true, allocation: { status: closed } });
      expect(confirmed).toBeInstanceOf(ConflictException);
      expect((confirmed as ConflictException).getResponse()).toMatchObject({ code: 'seat_request_changed' });
      expect(w.request(store)).toMatchObject({ status: closed, version: 1, paymentId: null, effectiveAt: null });
      expect(w.payments(b)).toEqual([]);
      w.clock.set(T);
      await w.sweeper.sweep();
      expect(w.branches(b).map((x) => x.name)).toEqual(['Main']);
      expect(w.periods(b)[0].assessedTotal).toBe(500);
    });
  }

  it('confirmed first, then refused or withdrawn: the closing is refused — paid is paid — and the request opens at the end', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const store = (await askStore(w, b)).allocation.id;
    await w.confirm(store, 500, { reference: 'BK-1', expectedVersion: 0 });
    const stale = await refuseOf(w, store, 0).catch((e: unknown) => e);
    expect((stale as ConflictException).getResponse()).toMatchObject({ code: 'seat_request_changed' });
    await expect(withdrawOf(w, b, store)).rejects.toBeInstanceOf(BadRequestException);
    expect(w.request(store)).toMatchObject({ status: 'scheduled', version: 1 });
    expect(w.payments(b)).toHaveLength(1);
    w.clock.set(T);
    await w.sweeper.sweep();
    expect(w.request(store).status).toBe('paid');
    expect(w.periods(b)[0].assessedTotal).toBe(1000);
  });
});

describe('12. suspended business at the scheduled activation time', () => {
  /** What a reinstatement, a sweep or a look could change: periods, stores, requests, payments, activations. */
  const ledger = (w: TrialBillingWorld, b: Business) =>
    JSON.stringify({
      periods: w.periods(b).map((p) => [p.periodStart.toISOString(), p.assessedTotal, p.assessedBranchFee, p.assessedStaffFee]),
      payments: w.payments(b).map((p) => p.amount.toString()),
      stores: w.branches(b).map((x) => [x.name, x.isActive]),
      requests: w.requests(b).map((r) => [r.status, r.version, r.effectiveAt?.toISOString() ?? null]),
      activations: w.audits(b).filter((a) => /\.activate$/.test(a.action)).length,
    });

  it('approved, then suspended before the end: put in force on schedule — the period it paid for starts on time — and still suspended', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { person, store, seat } = await scheduledStoreAndSeat(w, b);
    await w.lifecycle.suspend(w.uuid(b.companyId), { reason: 'documents to check' }, CTX);
    w.clock.set(T);
    // Nobody can look at a suspended business: the sweeper does it, at the end.
    await w.sweeper.sweep();

    expect(w.request(store)).toMatchObject({ status: 'paid', effectiveAt: T });
    expect(w.request(seat)).toMatchObject({ status: 'paid', effectiveAt: T });
    expect(w.branch(b, 'B')).toMatchObject({ isActive: true });
    expect(w.periods(b)).toHaveLength(1);
    expect(w.periods(b)[0]).toMatchObject({ periodStart: T, assessedTotal: 1100, assessedStaffFee: 100 });
    // PQ3's default: the seat's person is activated with it — the business's suspension, not the seat, keeps them out.
    expect(w.user(person).isActive).toBe(true);
    expect(w.subscription(b).status).toBe('suspended');
    await expect(w.entitlement.forCompany(b.companyId)).resolves.toMatchObject({ state: 'suspended', activeBranchCount: 2 });

    // Reinstated a day later: nothing is put in force or charged a second time.
    const settled = ledger(w, b);
    w.clock.set(new Date(T.getTime() + DAY));
    await expect(w.lifecycle.reinstate(w.uuid(b.companyId), { reason: 'documents received' }, CTX)).resolves.toMatchObject({ applied: true });
    await w.sweeper.sweep();
    expect(ledger(w, b)).toBe(settled);
    await expect(w.entitlement.forCompany(b.companyId)).resolves.toMatchObject({ state: 'active', activeBranchCount: 2 });
  });

  it('cancelled by the Super Admin before the end (not closed): the period it paid for still starts, and the request with it (PQ3)', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { store } = await scheduledStoreAndSeat(w, b);
    await w.lifecycle.cancel(w.uuid(b.companyId), { reason: 'asked to stop' }, CTX);
    w.clock.set(T);
    await w.sweeper.sweep();
    expect(w.request(store)).toMatchObject({ status: 'paid', effectiveAt: T });
    expect(w.periods(b)[0]).toMatchObject({ periodStart: T, assessedTotal: 1100 });
    expect(w.subscription(b).status).toBe('cancelled');
  });

  it('closed by its Owner (account deletion) before the end: nothing is put in force, ever — the trial’s end is still written down, once', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const { store, seat } = await scheduledStoreAndSeat(w, b);
    await w.closeCompany(b);
    const closed = ledger(w, b);
    w.clock.set(T);
    await w.sweeper.sweep();
    // The trial did end: its record is written once, so the sweeper never comes back for it.
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    expect([w.request(store).status, w.request(seat).status]).toEqual(['scheduled', 'scheduled']);
    expect(w.branch(b, 'B')).toBeNull();
    expect(ledger(w, b)).toBe(closed);
    const after = JSON.stringify(w.t);
    w.clock.advance(60_000);
    await w.sweeper.sweep();
    await w.trialEnd.applyIfDue(b.companyId);
    expect(JSON.stringify(w.t)).toBe(after);
  });

  it('closed by its Owner, then a payment confirmed during the trial — today’s behaviour, awaiting the owner (a PQ3/PQ4 follow-up): recorded and scheduled, said to start at the trial’s end, never put in force, never flagged', async () => {
    const { w, b } = await trialWorld({ approve: true });
    const store = (await askStore(w, b)).allocation.id;
    await w.closeCompany(b);
    // The console's queue still offers it for payment: the queue does not read a business's closure.
    expect((await w.seats.queue('pending_payment')).map((r) => r.id)).toContain(store);
    const confirmed = await w.confirm(store, 500, { reference: 'BK-CLOSED' });
    expect(confirmed).toMatchObject({
      applied: true,
      allocation: { status: 'scheduled', effectiveAt: T.toISOString(), activation: { startsAt: T.toISOString(), timeZone: 'Africa/Casablanca', waitsFor: 'trial_end' } },
    });
    for (const at of [T, new Date(T.getTime() + 61_000), new Date(T.getTime() + DAY)]) {
      w.clock.set(at);
      await w.trialEnd.applyIfDue(b.companyId);
      await w.sweeper.sweep();
    }
    // Paid for, kept, and never delivered; nothing on the request or in the audit tells anybody to settle it.
    expect(w.request(store)).toMatchObject({ status: 'scheduled', reason: null });
    expect(w.payments(b).map((p) => p.amount.toString())).toEqual(['500']);
    expect(w.branch(b, 'B')).toBeNull();
    expect(w.periods(b).map((p) => p.assessedTotal)).toEqual([500]);
    expect(w.audits(b).filter((a) => /activat/.test(a.action))).toEqual([]);
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    // And what the website and the console read still promises the trial's end.
    expect((await w.seats.listForCompany(b.companyId)).map((r) => r.activation)).toEqual([
      { startsAt: T.toISOString(), timeZone: 'Africa/Casablanca', waitsFor: 'trial_end' },
    ]);
  });

  it('suspended with no paid access approved: the requests wait, paid and counted nowhere — no period is opened for them', async () => {
    const { w, b } = await trialWorld();
    const { store, seat } = await scheduledStoreAndSeat(w, b);
    await w.lifecycle.suspend(w.uuid(b.companyId), { reason: 'documents to check' }, CTX);
    w.clock.set(T);
    await w.sweeper.sweep();
    expect([w.request(store).status, w.request(seat).status]).toEqual(['scheduled', 'scheduled']);
    expect(w.periods(b)).toEqual([]);
    expect(w.branch(b, 'B')).toBeNull();
    expect(w.payments(b)).toHaveLength(2);
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
  });
});

describe('13. trial claim racing an add-on request', () => {
  /** A self-registered business that has not claimed its trial: trial_available. */
  function available() {
    const w = makeTrialBillingWorld({ now: CLAIMED });
    const b = w.business({ name: 'Boutique' });
    return { w, b };
  }

  /**
   * The first operation takes the subscription row; the second arrives while it holds it — started from the lock
   * hook, so it queues behind the first's transaction exactly as a second connection waits on the row.
   */
  async function inOrder<A, B>(w: TrialBillingWorld, first: () => Promise<A>, second: () => Promise<B>) {
    let queued: Promise<B> | null = null;
    w.hooks.onLock = (_company, nowait) => {
      if (nowait || queued) return;
      queued = second();
      // Never left unobserved: its outcome is read below.
      queued.catch(() => undefined);
    };
    const one = await first().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    w.hooks.onLock = null;
    if (!queued) throw new Error('the second operation never arrived');
    const two = await (queued as Promise<B>).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    return { one, two };
  }

  /** The counts SPEC §2.3 says a claim never changes. */
  const counts = (w: TrialBillingWorld, b: Business) => ({ requests: w.requests(b).length, payments: w.payments(b).length, periods: w.periods(b).length });

  const claimIsValid = (w: TrialBillingWorld, b: Business) => {
    const claims = w.t.trialClaim.filter((c) => c.companyId.equals(b.companyId));
    expect(claims).toHaveLength(1);
    expect(claims[0].endsAt.getTime() - claims[0].startedAt.getTime()).toBe(168 * HOUR);
    return claims[0];
  };

  for (const claimFirst of [true, false]) {
    const order = claimFirst ? 'the claim holds the row first' : 'the request holds the row first';

    it(`a store asked for while the trial is claimed — ${order}: one claim, one request awaiting payment, nothing opened`, async () => {
      const { w, b } = available();
      const claim = () => w.claim(b);
      const ask = () => askStore(w, b);
      const { one, two } = claimFirst ? await inOrder(w, claim, ask) : await inOrder(w, ask, claim);
      expect([one.ok, two.ok]).toEqual([true, true]);
      claimIsValid(w, b);
      expect(w.requests(b)).toEqual([expect.objectContaining({ kind: 'store', status: 'pending_payment', label: 'B' })]);
      expect(counts(w, b)).toEqual({ requests: 1, payments: 0, periods: 0 });
      expect(w.branches(b).map((x) => x.name)).toEqual(['Main']);
    });

    it(`a seat asked for while the trial is claimed — ${order}: the two commute`, async () => {
      const { w, b } = available();
      w.person(b, { name: 'Ali', stores: ['Main'], active: true });
      if (claimFirst) {
        // The seat request takes no lock: it lands inside the claim's transaction and commits on its own.
        w.hooks.onLock = async (_company, nowait) => {
          if (nowait || w.requests(b).length > 0) return;
          await askSeat(w, b);
        };
        await w.claim(b);
        w.hooks.onLock = null;
      } else {
        await askSeat(w, b);
        await w.claim(b);
      }
      claimIsValid(w, b);
      expect(w.requests(b)).toEqual([expect.objectContaining({ kind: 'seat', status: 'pending_payment', monthlyAmount: 100 })]);
      expect(counts(w, b)).toEqual({ requests: 1, payments: 0, periods: 0 });
    });

    it(`a payment confirmed while the trial is claimed — ${order}: ${claimFirst ? 'scheduled for the claim’s end' : 'refused, nothing recorded'}`, async () => {
      const { w, b } = available();
      const store = (await askStore(w, b)).allocation.id;
      const before = counts(w, b);
      const claim = () => w.claim(b);
      const confirm = () => w.confirm(store, 500, { reference: 'BK-1' });
      const { one, two } = claimFirst ? await inOrder(w, claim, confirm) : await inOrder(w, confirm, claim);
      const claimed = claimIsValid(w, b);
      const [claimOutcome, confirmOutcome] = claimFirst ? [one, two] : [two, one];
      expect(claimOutcome.ok).toBe(true);
      if (claimFirst) {
        expect(confirmOutcome).toMatchObject({ ok: true, value: { applied: true, allocation: { status: 'scheduled', effectiveAt: claimed.endsAt.toISOString() } } });
        expect(w.payments(b)).toHaveLength(1);
      } else {
        expect(confirmOutcome.ok).toBe(false);
        const refused = (confirmOutcome as { error: unknown }).error;
        expect(refused).toBeInstanceOf(ConflictException);
        expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'paid_period_not_started' });
        expect(w.request(store)).toMatchObject({ status: 'pending_payment', version: 0, paymentId: null });
        expect(counts(w, b)).toEqual(before);
      }
      // Never a store before the trial's end, and the claim itself changed no request, payment or period.
      expect(w.branches(b).map((x) => x.name)).toEqual(['Main']);
      expect(w.periods(b)).toEqual([]);
      expect(w.requests(b)).toHaveLength(before.requests);
    });
  }
});

describe('14. correct company/store isolation', () => {
  /** Everything held for one business: what another business's activation must leave byte for byte. */
  const holdings = (w: TrialBillingWorld, b: Business) =>
    JSON.stringify(
      {
        subscription: w.subscription(b),
        claim: w.claimOf(b),
        requests: w.requests(b),
        payments: w.payments(b),
        periods: w.periods(b),
        branches: w.branches(b),
        people: w.t.user.filter((u) => u.companyId.equals(b.companyId)),
        assignments: w.t.userBranch.filter((ub) => ub.companyId.equals(b.companyId)),
        events: w.events(b),
        audits: w.audits(b),
      },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    );

  /** Two businesses on trial, each with a store "B" and a seat at its own S1 scheduled; Alpha's trial ends a day first. */
  async function twoBusinesses() {
    const w = makeTrialBillingWorld({ now: CLAIMED });
    const stores = [{ name: 'S1' }, { name: 'S2' }];
    const a = w.business({ name: 'Alpha', stores });
    const b = w.business({ name: 'Beta', timezone: 'Europe/Paris', stores });
    await w.claim(a);
    w.clock.set(new Date(CLAIMED.getTime() + DAY));
    await w.claim(b);
    w.clock.advance(HOUR);
    await approve(w, a);
    await approve(w, b);
    for (const x of [a, b]) {
      w.person(x, { name: 'Ali', stores: ['S1'], active: true });
      w.person(x, { name: 'Sam', stores: ['S2'], active: true });
    }
    // Waiting to be seated: Pia at Alpha's full S1, Sol at Alpha's full S2, Bea at Beta's full S1.
    const pia = w.person(a, { name: 'Pia', stores: ['S1'], verified: true });
    const sol = w.person(a, { name: 'Sol', stores: ['S2'], verified: true });
    const bea = w.person(b, { name: 'Bea', stores: ['S1'], verified: true });
    const ids = { a: { store: '', seat: '' }, b: { store: '', seat: '' } };
    for (const [key, x] of [['a', a], ['b', b]] as const) {
      ids[key].store = (await askStore(w, x)).allocation.id;
      ids[key].seat = (await askSeat(w, x, null, 'S1')).allocation.id;
      await w.confirm(ids[key].store, 500, { reference: `BK-${key}-1` });
      await w.confirm(ids[key].seat, 100, { reference: `BK-${key}-2` });
    }
    const TA = w.claimOf(a)!.endsAt as Date;
    const TB = w.claimOf(b)!.endsAt as Date;
    return { w, a, b, pia, sol, bea, ids, TA, TB };
  }

  /** The console's seat routes and the Owner's, as Alpha's Owner and an administrator call them. */
  const routesFor = (w: TrialBillingWorld, as: Business) =>
    new SeatRequestsController(
      w.db as never,
      { companyId: () => as.companyId, requireUserId: () => as.ownerId } as never,
      { confirmPassword: async () => undefined } as never,
      w.billing,
      w.seats,
      w.activation,
      // A customer's business: payments are taken (D217 refuses them for a test business only).
      { assertMayTakePayment: async () => undefined } as never,
    );

  it('Alpha’s end — looked at, then swept — changes Alpha’s rows only, taking Alpha’s lock only; Beta’s are untouched until its own end', async () => {
    const { w, a, b, pia, sol, bea, ids, TA, TB } = await twoBusinesses();
    expect(TB.getTime() - TA.getTime()).toBe(DAY);
    const beta = holdings(w, b);
    const from = w.locks.length;

    w.clock.set(TA);
    await w.entitlement.forCompany(a.companyId);
    w.clock.advance(60_000);
    await w.sweeper.sweep();

    expect([w.request(ids.a.store).status, w.request(ids.a.seat).status]).toEqual(['paid', 'paid']);
    expect(w.branches(a).map((x) => x.name)).toEqual(['S1', 'S2', 'B']);
    expect(w.periods(a)[0]).toMatchObject({ assessedTotal: 1600, assessedStaffFee: 100 });
    expect(w.user(pia).isActive).toBe(true);
    expect(w.user(sol).isActive).toBe(false);
    expect(new Set(w.locks.slice(from).map((l) => l.company))).toEqual(new Set([w.uuid(a.companyId)]));
    // Beta: byte for byte as it was — its rows, its period, its people, its timeline.
    expect(holdings(w, b)).toBe(beta);
    expect(w.user(bea).isActive).toBe(false);

    // Alpha's seat counts at Alpha's S1 only — not at its S2, and not anywhere in Beta.
    const census = (await w.entitlement.forCompany(a.companyId)).seatsByStore;
    expect(census.map((s) => [s.name, s.paidSeats])).toEqual([['S1', 1], ['S2', 0], ['B', 0]]);
    expect((await w.entitlement.forCompany(b.companyId)).seatsByStore.map((s) => [s.name, s.paidSeats])).toEqual([['S1', 0], ['S2', 0]]);

    w.clock.set(TB);
    const alpha = holdings(w, a);
    await w.sweeper.sweep();
    expect([w.request(ids.b.store).status, w.request(ids.b.seat).status]).toEqual(['paid', 'paid']);
    expect(w.branches(b).map((x) => x.name)).toEqual(['S1', 'S2', 'B']);
    expect(w.user(bea).isActive).toBe(true);
    expect(holdings(w, a)).toBe(alpha);
  });

  it('two trials ending at the same instant, one business with paid access and one without: the first’s activation leaves the second’s rows waiting', async () => {
    const w = makeTrialBillingWorld({ now: CLAIMED });
    const a = w.business({ name: 'Alpha' });
    const b = w.business({ name: 'Beta' });
    await w.claim(a);
    await w.claim(b);
    w.clock.advance(HOUR);
    await approve(w, a);
    const theirs = (await askStore(w, b)).allocation.id;
    await w.confirm(theirs, 500, { reference: 'BK-B' });
    const ours = (await askStore(w, a)).allocation.id;
    await w.confirm(ours, 500, { reference: 'BK-A' });
    w.clock.set(T);
    // Alpha's own trigger, at the instant both are due: Beta's row is due too, but not Alpha's to put in force.
    await w.trialEnd.applyIfDue(a.companyId);
    expect(w.request(ours).status).toBe('paid');
    expect(w.request(theirs)).toMatchObject({ status: 'scheduled', branchId: null });
    expect(w.branches(b).map((x) => x.name)).toEqual(['Main']);
    expect(w.branches(a).map((x) => x.name)).toEqual(['Main', 'B']);
    expect(w.periods(a)[0].assessedTotal).toBe(1000);
    expect(w.periods(b)).toEqual([]);
  });

  it('another business’s request: the console’s confirmation is refused as unknown, the Owner’s withdrawal is not found — nothing moves', async () => {
    const { w, a, b, ids } = await twoBusinesses();
    const pending = (await askStore(w, b, 'Annex')).allocation.id;
    const beta = holdings(w, b);
    const alpha = holdings(w, a);
    const routes = routesFor(w, a);
    const req = { platformAdmin: CTX.admin, ip: '127.0.0.1' };
    for (const rid of [ids.b.store, pending]) {
      const confirmed = await routes
        .confirmSeatPayment(w.uuid(a.companyId), rid, { amount: '500', paidAt: CLAIMED.toISOString(), reference: 'BK-X' } as never, req as never)
        .catch((e: unknown) => e);
      expect(confirmed).toBeInstanceOf(BadRequestException);
      expect((confirmed as BadRequestException).message).toBe('Unknown request');
      await expect(routes.withdrawSeatRequest(rid)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(holdings(w, b)).toBe(beta);
    expect(holdings(w, a)).toBe(alpha);
  });

  it('the people a seat bought during the trial covers are its own business’s, at its own store', async () => {
    const { w, a, b, pia, sol, bea } = await twoBusinesses();
    const db = w.db as never;
    expect(await scheduledCoverage(db, a.companyId, a.stores.S1)).toEqual({ seats: 1, candidates: [pia] });
    expect(await scheduledCoverage(db, a.companyId, a.stores.S2)).toEqual({ seats: 0, candidates: [] });
    // Alpha's company, Beta's store: nothing of Alpha's is there.
    expect(await scheduledCoverage(db, a.companyId, b.stores.S1)).toEqual({ seats: 0, candidates: [] });
    expect(await scheduledCoverage(db, b.companyId, b.stores.S1)).toEqual({ seats: 1, candidates: [bea] });
    await expect(w.activation.coveredByScheduledSeat(pia, a.stores.S1)).resolves.toBe(true);
    await expect(w.activation.coveredByScheduledSeat(sol, a.stores.S2)).resolves.toBe(false);
    await expect(w.activation.coveredByScheduledSeat(bea, b.stores.S1)).resolves.toBe(true);
    await expect(w.activation.coveredByScheduledSeat(bea, a.stores.S1)).resolves.toBe(false);
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
      w.entitlement,
      { companyId: () => b.companyId } as never,
      unused,
      unused,
      unused,
      { status: async () => null } as never,
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
