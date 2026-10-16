import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { newUuidV7Bin } from '../../common/utils/uuid.util';
import { CTX, DAY, HOUR, makeTrialBillingWorld, type Business, type TrialBillingWorld } from '../__testing__/trial-billing-world';

/**
 * When a free trial ends (0095; D176): the record that it did (Tx A), and what was paid for during it put in force
 * (Tx B) — each in its own transaction, each taking the subscription row with NOWAIT, neither ever waiting for it.
 *
 * The rows a confirmation schedules are written here directly, as the confirmation would leave them (its own spec,
 * trial-addons.spec, drives the whole journey): `scheduled`, paid, starting at the claim's end.
 */

const CLAIMED = new Date('2026-10-14T09:30:00.123Z');
const T = new Date(CLAIMED.getTime() + 168 * HOUR);

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/** A business that claimed its trial at CLAIMED, approved for a month during it, with a store and a seat scheduled. */
async function scheduledWorld(opts: { approve?: boolean; person?: 'own' | 'none' } = {}) {
  const w = makeTrialBillingWorld({ now: CLAIMED });
  const b = w.business({ name: 'Boutique' });
  await w.claim(b);
  w.clock.set(new Date(CLAIMED.getTime() + HOUR));
  if (opts.approve ?? true) await w.lifecycle.approve(w.uuid(b.companyId), { months: 1, reason: 'paid' }, CTX);
  const person = opts.person === 'own' ? w.person(b, { name: 'Sara', stores: ['Main'], verified: true }) : null;
  const store = schedule(w, b, { kind: 'store', label: 'B', amount: 500, reference: 'BK-1' });
  const seat = schedule(w, b, { kind: 'seat', branch: 'Main', userId: person, amount: 100, reference: 'BK-2' });
  return { w, b, store, seat, person };
}

/** A request as a confirmation during the trial leaves it: paid, scheduled to start at the trial's end. */
function schedule(
  w: TrialBillingWorld,
  b: Business,
  o: { kind: 'store' | 'seat'; label?: string; branch?: string; userId?: Buffer | null; amount: number; reference: string },
): string {
  const paymentId = newUuidV7Bin();
  const at = w.clock.now();
  w.t.subscriptionPayment.push({
    id: paymentId,
    companyId: b.companyId,
    subscriptionId: b.subscriptionId,
    amount: new Prisma.Decimal(o.amount),
    currency: 'MRU',
    paidAt: at,
    channel: 'manual',
    reference: o.reference,
    note: null,
    recordedBy: 'ops@example.test',
    confirmedBy: 'ops@example.test',
    confirmedAt: at,
    reversesId: null,
    createdAt: at,
  });
  const id = newUuidV7Bin();
  w.t.seatAllocation.push({
    id,
    companyId: b.companyId,
    subscriptionId: b.subscriptionId,
    branchId: o.branch ? b.stores[o.branch] : null,
    userId: o.userId ?? null,
    kind: o.kind,
    status: 'scheduled',
    label: o.label ?? null,
    activityFrom: null,
    activityTo: o.kind === 'store' ? 'electronics' : null,
    activityEffective: null,
    replacesBranchId: null,
    replacementCredit: null,
    replacementPeriodId: null,
    monthlyAmount: o.amount,
    currency: 'MRU',
    requestedBy: 'owner',
    requestedAt: at,
    paymentId,
    confirmedBy: 'ops@example.test',
    confirmedAt: at,
    effectiveAt: T,
    closedAt: null,
    closedBy: null,
    reason: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  return w.uuid(id);
}

/** Everything a pass could write, to compare before and after. */
const snapshot = (w: TrialBillingWorld) => JSON.stringify(w.t, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

describe('before the trial ends: nothing is due, and nothing is even locked', () => {
  it('the last millisecond of the trial', async () => {
    const { w, b } = await scheduledWorld();
    w.clock.set(new Date(T.getTime() - 1));
    const locksBefore = w.locks.length;
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('nothing_due');
    expect(w.locks.length).toBe(locksBefore);
    expect(w.requests(b).filter((r) => r.status === 'scheduled')).toHaveLength(2);
    expect(w.claimOf(b)!.expiryRecordedAt).toBeNull();
  });

  it('a business with no claim has nothing due, ever', async () => {
    const w = makeTrialBillingWorld({ now: CLAIMED });
    const b = w.business({ eligible: false, status: 'activated' });
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('nothing_due');
    expect(w.locks).toEqual([]);
  });
});

describe('at the trial’s end: the record, then the activation — each once', () => {
  it('records the expiry and puts the store and the seat in force, stamped at the end, the first period raised by each', async () => {
    const { w, b, store, seat } = await scheduledWorld();
    w.clock.set(T);
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('done');

    // Tx A, as before: once, with its event and its audit.
    expect(w.claimOf(b)!.expiryRecordedAt).toEqual(T);
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    expect(w.audits(b, 'trial.expired')).toHaveLength(1);

    // Tx B: the store opened and named, the seat counted, both at the trial's end.
    const opened = w.branch(b, 'B')!;
    expect(opened).toMatchObject({ activity: 'electronics', isActive: true });
    expect(w.request(store)).toMatchObject({ status: 'paid', effectiveAt: T, branchId: opened.id });
    expect(w.request(seat)).toMatchObject({ status: 'paid', effectiveAt: T });
    expect(w.t.userBranch.filter((ub) => ub.branchId.equals(opened.id)).map((ub) => ub.userId)).toEqual([b.ownerId]);
    expect(w.subscription(b)).toMatchObject({ subscribedBranchCount: 2 });

    const [p1] = w.periods(b);
    expect(p1.periodStart).toEqual(T);
    expect(p1).toMatchObject({ assessedBranchFee: 1000, assessedStaffFee: 100, assessedTotal: 1100, activeBranchCount: 2 });
    expect(w.audits(b, 'store.activate').map((a) => a.afterJson)).toEqual([
      expect.objectContaining({ requestId: store, periodId: w.uuid(p1.id), effectiveAt: T.toISOString(), monthlyAmount: 500, paid: '500', raisedBy: 500 }),
    ]);
    expect(w.audits(b, 'seat.activate').map((a) => a.afterJson)).toEqual([expect.objectContaining({ requestId: seat, raisedBy: 100, paid: '100' })]);
    expect(w.events(b, 'branches_changed').map((e) => e.note)).toEqual([
      'Store "B" (electronics) opened with its first paid period: paid for during the free trial, payment BK-1.',
    ]);
    expect(w.events(b, 'seats_changed').map((e) => e.note)).toEqual([
      'Seat at Main in force with its first paid period: paid for during the free trial, payment BK-2.',
    ]);
    // The notes the server writes here carry no instant (C7): the dates travel as data.
    for (const e of [...w.events(b, 'branches_changed'), ...w.events(b, 'seats_changed')]) expect(e.note).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    // Both transactions took the row with NOWAIT, bounded.
    expect(w.locks.slice(-2)).toEqual([
      { company: w.uuid(b.companyId), nowait: true, outcome: 'taken' },
      { company: w.uuid(b.companyId), nowait: true, outcome: 'taken' },
    ]);
    expect(w.txOptions.slice(-2)).toEqual([
      { maxWait: 2000, timeout: 10000 },
      { maxWait: 2000, timeout: 10000 },
    ]);
  });

  it('a later first look stamps the same instant, and a re-run changes nothing at all', async () => {
    const { w, b, store } = await scheduledWorld();
    w.clock.set(new Date(T.getTime() + 5 * 60_000));
    await w.trialEnd.applyIfDue(b.companyId);
    expect(w.request(store).effectiveAt).toEqual(T);
    const settled = snapshot(w);
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('nothing_due');
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('nothing_due');
    expect(snapshot(w)).toBe(settled);
  });

  it('the person a scheduled seat was paid for is activated with it', async () => {
    const { w, b, person } = await scheduledWorld({ person: 'own' });
    expect(w.user(person!)).toMatchObject({ isActive: false, activatedAt: null });
    w.clock.set(T);
    await w.trialEnd.applyIfDue(b.companyId);
    expect(w.user(person!)).toMatchObject({ isActive: true, activatedAt: T });
    expect(w.events(b, 'staff_activated')).toHaveLength(1);
  });
});

describe('never waiting on the subscription row (R1-F2)', () => {
  it('a row another writer holds is busy: nothing written, nothing waited for — and the next attempt finishes', async () => {
    const { w, b, store } = await scheduledWorld();
    w.clock.set(T);
    const release = w.hold(b);
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('busy');
    expect(w.locks.slice(-2).map((l) => l.outcome)).toEqual(['busy', 'busy']);
    expect(w.claimOf(b)!.expiryRecordedAt).toBeNull();
    expect(w.request(store).status).toBe('scheduled');
    expect(warn).not.toHaveBeenCalled();
    release();
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('done');
    expect(w.request(store).status).toBe('paid');
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
  });
});

describe('never waiting on any other row the end’s work needs (N1)', () => {
  /** Store B and an unnamed seat at Main scheduled; Ali holds Main's included seat, so Uma, waiting there, is covered. */
  async function coveredWorld() {
    const x = await scheduledWorld();
    x.w.person(x.b, { name: 'Ali', stores: ['Main'], active: true });
    const uma = x.w.person(x.b, { name: 'Uma', stores: ['Main'], verified: true });
    return { ...x, uma };
  }

  it('every row is taken before anything is written, each with NOWAIT and once: the business, the claim; then the business, the period, the requests, the people, the Owners and their role', async () => {
    const { w, b, store, seat, uma } = await coveredWorld();
    w.clock.set(T);
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('done');
    const [p1] = w.periods(b);
    const row = (table: string, id: Buffer | string, mode: 'update' | 'share') => ({ table, id: typeof id === 'string' ? id : w.uuid(id), mode, outcome: 'taken' });
    expect(w.rowLocks).toEqual([
      // Tx A
      row('companies', b.companyId, 'share'),
      row('trial_claims', w.claimOf(b)!.id, 'update'),
      // Tx B
      row('companies', b.companyId, 'share'),
      row('billing_periods', p1.id, 'update'),
      // In the order they are put in force: both start at the end and were asked at one instant, so by id.
      ...[store, seat].sort().map((id) => row('seat_allocations', id, 'update')),
      row('users', uma, 'update'),
      row('users', b.ownerId, 'share'),
      row('roles', b.roles.owner, 'share'),
    ]);
    // …and the work they guard was done once: the store open, the seat counted, Uma activated by it.
    expect(w.request(store).status).toBe('paid');
    expect(w.user(uma)).toMatchObject({ isActive: true, activatedAt: T });
    expect(p1.assessedTotal).toBe(1100);
  });

  const holders: { what: string; row: (x: Awaited<ReturnType<typeof coveredWorld>>) => [string, Buffer] }[] = [
    { what: 'the business’s row', row: ({ b }) => ['companies', b.companyId] },
    { what: 'the period it raises', row: ({ w, b }) => ['billing_periods', w.periods(b)[0].id] },
    { what: 'the store request', row: ({ w, store }) => ['seat_allocations', w.request(store).id] },
    { what: 'the seat request', row: ({ w, seat }) => ['seat_allocations', w.request(seat).id] },
    { what: 'the person the seat covers', row: ({ uma }) => ['users', uma] },
    { what: 'an Owner the store is assigned to', row: ({ b }) => ['users', b.ownerId] },
    { what: 'the Owner’s role', row: ({ b }) => ['roles', b.roles.owner] },
  ];
  for (const { what, row } of holders) {
    it(`${what} held by another writer: busy at once, nothing of the activation written — released, it is all done once`, async () => {
      const x = await coveredWorld();
      const { w, b, store, seat, uma } = x;
      w.clock.set(T);
      const release = w.holdRow(...row(x));
      await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('busy');
      // Refused once per transaction that needs it: the business's row by both, every other row by Tx B alone.
      expect(w.rowLocks.filter((l) => l.outcome === 'busy')).toHaveLength(row(x)[0] === 'companies' ? 2 : 1);
      // Nothing of Tx B: no store, nothing counted or raised, nobody activated, no audit.
      expect([w.request(store).status, w.request(seat).status]).toEqual(['scheduled', 'scheduled']);
      expect(w.branch(b, 'B')).toBeNull();
      expect(w.periods(b)[0].assessedTotal).toBe(500);
      expect(w.user(uma).activatedAt).toBeNull();
      expect(w.audits(b).filter((a) => /\.activate$/.test(a.action))).toEqual([]);
      // Tx A needs only the business's row and the claim: it stands unless the business's row is the one held.
      expect(w.events(b, 'trial_expired')).toHaveLength(row(x)[0] === 'companies' ? 0 : 1);
      expect(warn).not.toHaveBeenCalled();

      release();
      await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('done');
      expect([w.request(store).status, w.request(seat).status]).toEqual(['paid', 'paid']);
      expect(w.periods(b)[0].assessedTotal).toBe(1100);
      expect(w.user(uma).activatedAt).toEqual(T);
      expect(w.events(b, 'trial_expired')).toHaveLength(1);
      expect(w.audits(b).filter((a) => /\.activate$/.test(a.action))).toHaveLength(2);
    });
  }
});

describe('the activation’s gate: a paid period in force, in an open company', () => {
  it('no paid access by the end: the expiry is recorded, the requests wait — paid, counted nowhere', async () => {
    const { w, b, store, seat } = await scheduledWorld({ approve: false });
    w.clock.set(T);
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('done');
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    expect([w.request(store).status, w.request(seat).status]).toEqual(['scheduled', 'scheduled']);
    expect(w.branch(b, 'B')).toBeNull();
    expect(w.periods(b)).toEqual([]);
    // Approved a day later: the period opens then, and the requests join it, stamped at its start.
    w.clock.set(new Date(T.getTime() + DAY));
    await w.lifecycle.approve(w.uuid(b.companyId), { months: 1, reason: 'paid late' }, CTX);
    await w.trialEnd.applyIfDue(b.companyId);
    const [p] = w.periods(b);
    expect(p.periodStart).toEqual(new Date(T.getTime() + DAY));
    expect(p.assessedTotal).toBe(1100);
    expect(w.request(store)).toMatchObject({ status: 'paid', effectiveAt: p.periodStart });
  });

  it('a closed company activates nothing, whatever its period', async () => {
    const { w, b, store } = await scheduledWorld();
    w.company(b).closedAt = new Date(T.getTime() - HOUR);
    w.clock.set(T);
    await w.trialEnd.applyIfDue(b.companyId);
    expect(w.request(store).status).toBe('scheduled');
    expect(w.branch(b, 'B')).toBeNull();
    expect(w.periods(b)[0].assessedTotal).toBe(500);
  });

  it('a suspended business with its period in force activates on schedule (PQ3)', async () => {
    const { w, b, store } = await scheduledWorld();
    await w.lifecycle.suspend(w.uuid(b.companyId), { reason: 'check' }, CTX);
    w.clock.set(T);
    await w.trialEnd.applyIfDue(b.companyId);
    expect(w.request(store).status).toBe('paid');
    expect(w.subscription(b).status).toBe('suspended');
  });
});

describe('a store that cannot open under its name', () => {
  it('waits, flagged once — never thrown, never charged', async () => {
    const { w, b, store, seat } = await scheduledWorld();
    // An archived store still holds its name (the unique key counts every branch): the paid one cannot take it.
    w.t.branch.push({ ...w.branch(b, 'Main')!, id: newUuidV7Bin(), name: 'B', isActive: false });
    w.clock.set(T);
    await w.trialEnd.applyIfDue(b.companyId);
    await w.trialEnd.applyIfDue(b.companyId);
    expect(w.request(store)).toMatchObject({ status: 'scheduled', reason: expect.stringContaining('A store named "B" already exists') });
    expect(w.audits(b, 'store.activation_blocked')).toHaveLength(1);
    // The seat beside it was not held up.
    expect(w.request(seat).status).toBe('paid');
    expect(w.periods(b)[0].assessedTotal).toBe(600);
  });
});

describe('a failed activation never undoes the expiry record', () => {
  it('the store cannot be created: the record stands, the activation is rolled back whole, and the next attempt succeeds', async () => {
    const { w, b, store, seat } = await scheduledWorld();
    w.clock.set(T);
    w.hooks.failBranchCreate = 1;
    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('failed');
    expect(w.claimOf(b)!.expiryRecordedAt).toEqual(T);
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    expect([w.request(store).status, w.request(seat).status]).toEqual(['scheduled', 'scheduled']);
    expect(w.branch(b, 'B')).toBeNull();
    expect(w.periods(b)[0].assessedTotal).toBe(500);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Activation of what was paid for during the free trial failed for company .*: injected/));

    await expect(w.trialEnd.applyIfDue(b.companyId)).resolves.toBe('done');
    expect(w.request(store).status).toBe('paid');
    expect(w.periods(b)[0].assessedTotal).toBe(1100);
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
  });
});

describe('the lazy path: the entitlement check every request passes', () => {
  it('one evaluation at the end puts what was paid for in force, and counts it in the same answer', async () => {
    const { w, b, store } = await scheduledWorld();
    w.clock.set(T);
    const e = await w.entitlement.forCompany(b.companyId);
    expect(w.request(store).status).toBe('paid');
    // The census was read after the record and the activation, so this very answer has both stores and the seat.
    expect(e).toMatchObject({ state: 'active', subscribedBranchCount: 2, activeBranchCount: 2 });
    expect(e.seatsByStore.find((s) => s.name === 'Main')).toMatchObject({ paidSeats: 1, seatLimit: 2 });
    expect(e.seatsByStore.find((s) => s.name === 'B')).toMatchObject({ seatLimit: 1 });
  });

  it('before the end, an evaluation counts nothing scheduled and changes nothing', async () => {
    const { w, b } = await scheduledWorld();
    w.clock.set(new Date(T.getTime() - 1));
    const before = snapshot(w);
    const e = await w.entitlement.forCompany(b.companyId);
    const may = await w.entitlement.maySeat(b.companyId, [b.stores.Main]);
    expect(e).toMatchObject({ state: 'trial_active', activeBranchCount: 1, subscribedBranchCount: 1 });
    expect(e.seatsByStore).toEqual([expect.objectContaining({ name: 'Main', paidSeats: 0, seatLimit: 1 })]);
    expect(may.stores).toEqual([expect.objectContaining({ name: 'Main', paidSeats: 0 })]);
    expect(snapshot(w)).toBe(before);
  });
});

describe('the sweeper: a business nobody looks at gets what it paid for, on time', () => {
  it('one pass records the expiry and activates; the next finds nothing to do', async () => {
    const { w, b, store, seat } = await scheduledWorld();
    w.clock.set(new Date(T.getTime() + 30_000));
    await expect(w.sweeper.sweep()).resolves.toEqual({ companies: 1, outcomes: { busy: 0, nothing_due: 0, done: 1, failed: 0 } });
    expect([w.request(store).status, w.request(seat).status]).toEqual(['paid', 'paid']);
    expect(w.request(store).effectiveAt).toEqual(T);
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    await expect(w.sweeper.sweep()).resolves.toEqual({ companies: 0, outcomes: { busy: 0, nothing_due: 0, done: 0, failed: 0 } });
  });

  it('a business still waiting for paid access: its end is written down once, then it is not visited until it has a period', async () => {
    const { w, b, store } = await scheduledWorld({ approve: false });
    w.clock.set(new Date(T.getTime() + 30_000));
    await w.sweeper.sweep();
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    const waiting = snapshot(w);
    // Nothing it holds can be put in force without a paid period: the sweeper does not come back for it.
    await expect(w.sweeper.sweep()).resolves.toEqual({ companies: 0, outcomes: { busy: 0, nothing_due: 0, done: 0, failed: 0 } });
    expect(snapshot(w)).toBe(waiting);
    expect(w.request(store).status).toBe('scheduled');
  });

  it('two hundred businesses still waiting never crowd out one that is due: it is put in force by the first pass', async () => {
    const w = makeTrialBillingWorld({ now: CLAIMED });
    const waiting: Business[] = [];
    for (let i = 0; i < 201; i += 1) {
      const x = w.business({ name: `Waiting ${i}` });
      await w.claim(x);
      schedule(w, x, { kind: 'store', label: 'B', amount: 500, reference: `BK-W${i}` });
      waiting.push(x);
    }
    // One more, approved during its trial: the one a pass must not miss. Its Owner does not look; its people cannot.
    const due = w.business({ name: 'Due' });
    await w.claim(due);
    w.clock.set(new Date(CLAIMED.getTime() + HOUR));
    await w.lifecycle.approve(w.uuid(due.companyId), { months: 1, reason: 'paid' }, CTX);
    const store = schedule(w, due, { kind: 'store', label: 'B', amount: 500, reference: 'BK-D' });

    w.clock.set(new Date(T.getTime() + 30_000));
    await w.sweeper.sweep();
    expect(w.request(store)).toMatchObject({ status: 'paid', effectiveAt: T });
    expect(w.periods(due)[0].assessedTotal).toBe(1000);
    // The waiting ones keep what they paid for, scheduled, and are not visited again while they wait.
    expect(waiting.every((x) => w.requests(x)[0].status === 'scheduled')).toBe(true);
    await w.sweeper.sweep();
    expect(waiting.every((x) => w.events(x, 'trial_expired').length === 1)).toBe(true);
    await expect(w.sweeper.sweep()).resolves.toMatchObject({ companies: 0 });
  });

  it('a closed business is never visited for what it paid for: its end is written down once, and that is all', async () => {
    const { w, b, store } = await scheduledWorld();
    await w.closeCompany(b);
    w.clock.set(new Date(T.getTime() + 30_000));
    await expect(w.sweeper.sweep()).resolves.toMatchObject({ companies: 1 });
    expect(w.events(b, 'trial_expired')).toHaveLength(1);
    expect(w.request(store).status).toBe('scheduled');
    await expect(w.sweeper.sweep()).resolves.toMatchObject({ companies: 0 });
  });

  it('only companies with something due are visited, and only their rows change', async () => {
    const first = await scheduledWorld();
    const { w } = first;
    const other = w.business({ name: 'Other' });
    w.clock.set(T);
    await w.sweeper.sweep();
    expect(w.requests(other)).toEqual([]);
    expect(w.events(other)).toEqual([]);
  });

  it('one pass at a time in a process: a call during a pass joins it', async () => {
    const { w } = await scheduledWorld();
    w.clock.set(T);
    const [a, b] = [w.sweeper.sweepNow(), w.sweeper.sweepNow()];
    expect(a).toBe(b);
    await expect(a).resolves.toMatchObject({ companies: 1 });
  });
});
