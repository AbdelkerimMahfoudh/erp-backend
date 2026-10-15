import { BillingService, periodRunning } from './billing.service';
import { SubscriptionRenewal, rollDue } from './renewal';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The renewal that falls due at the end of a prepaid period (D154 a, reviewed
 * 2026-10-09): applied once, where the old period ended, with the downgrades
 * scheduled for it — and never early, never twice.
 */

const DAY = 24 * 60 * 60 * 1000;
const COMPANY = newUuidV7Bin();
const SUB = newUuidV7Bin();
const MAIN = newUuidV7Bin();
const OLD_END = new Date('2026-10-31T23:00:00.000Z');
const NEW_END = new Date('2026-11-30T23:00:00.000Z');

describe('is a roll due?', () => {
  const now = new Date(OLD_END.getTime() + DAY);
  it('only for a running subscription whose latest period ended and whose end lies beyond it', () => {
    expect(rollDue({ status: 'activated', currentPeriodEnd: NEW_END }, { periodEnd: OLD_END }, now)).toBe(true);
    // Still running: due later, not now.
    expect(rollDue({ status: 'activated', currentPeriodEnd: NEW_END }, { periodEnd: OLD_END }, new Date(OLD_END.getTime() - DAY))).toBe(false);
    // Lapsed: nothing prepaid beyond the period — the shop renews by an admin action, from that moment.
    expect(rollDue({ status: 'activated', currentPeriodEnd: OLD_END }, { periodEnd: OLD_END }, now)).toBe(false);
    // Suspended, pending, never billed, an open-ended period: never.
    expect(rollDue({ status: 'suspended', currentPeriodEnd: NEW_END }, { periodEnd: OLD_END }, now)).toBe(false);
    expect(rollDue({ status: 'activated', currentPeriodEnd: NEW_END }, null, now)).toBe(false);
    expect(rollDue({ status: 'activated', currentPeriodEnd: NEW_END }, { periodEnd: null }, now)).toBe(false);
    expect(rollDue(null, { periodEnd: OLD_END }, now)).toBe(false);
  });

  it('a period runs until its end, exclusive; an open-ended one runs', () => {
    expect(periodRunning({ periodEnd: OLD_END }, new Date(OLD_END.getTime() - 1))).toBe(true);
    expect(periodRunning({ periodEnd: OLD_END }, OLD_END)).toBe(false);
    expect(periodRunning({ periodEnd: null }, OLD_END)).toBe(true);
    expect(periodRunning(null, OLD_END)).toBe(false);
  });
});

function makeWorld(opts: { now: Date; activityNext?: 'money_agent' | null; currentPeriodEnd?: Date; unbilled?: boolean }) {
  const sub = { id: SUB, companyId: COMPANY, status: 'activated', currentPeriodEnd: opts.currentPeriodEnd ?? NEW_END };
  const periods: { id: Buffer; periodStart: Date; periodEnd: Date | null }[] = opts.unbilled
    ? []
    : [{ id: newUuidV7Bin(), periodStart: new Date(OLD_END.getTime() - 30 * DAY), periodEnd: OLD_END }];
  const branch = { id: MAIN, name: 'Main', activity: 'both', activityNext: opts.activityNext === undefined ? 'money_agent' : opts.activityNext, activityChangedAt: null as Date | null };
  const events: { kind: string; note: string; actor: string }[] = [];
  const allocations = [{ kind: 'activity', status: 'granted', branchId: MAIN, activityTo: 'money_agent', confirmedAt: null as Date | null, confirmedBy: null as string | null, reason: null as string | null }];
  const locks: string[] = [];
  const opened: { startsAt: Date | undefined; end: Date | null }[] = [];
  const closed: Date[] = [];
  const db: Record<string, any> = {
    subscription: { findFirst: async () => ({ ...sub }) },
    branch: {
      findMany: async () => (branch.activityNext ? [{ ...branch }] : []),
      update: async ({ data }: any) => Object.assign(branch, data),
    },
    seatAllocation: {
      updateMany: async ({ where, data }: any) => {
        const hits = allocations.filter((a) => a.status === where.status && a.activityTo === where.activityTo && a.confirmedAt === where.confirmedAt);
        for (const a of hits) Object.assign(a, { confirmedAt: data.confirmedAt, confirmedBy: data.confirmedBy, reason: data.reason });
        return { count: hits.length };
      },
    },
    subscriptionEvent: { create: async ({ data }: any) => void events.push(data) },
    $queryRaw: async (q: { strings?: string[] }) => void locks.push((q.strings ?? []).join('?')),
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  const clock = { now: () => opts.now };
  const billing = {
    latestPeriod: async () => ({ ...periods[periods.length - 1] }),
    openPeriod: async (_c: Buffer, _s: Buffer, end: Date | null, o: { startsAt?: Date }) => {
      opened.push({ startsAt: o.startsAt, end });
      periods.push({ id: newUuidV7Bin(), periodStart: o.startsAt ?? opts.now, periodEnd: end });
    },
    closeCurrentPeriod: async (_c: Buffer, at: Date) => {
      closed.push(at);
      return periods.length > 0;
    },
  } as unknown as BillingService;
  const renewal = new SubscriptionRenewal(db as never, billing, clock);
  return { renewal, branch, events, allocations, locks, opened, closed, periods, db, billing };
}

describe('the roll due at the end of a prepaid period', () => {
  it('before the old end: nothing, not even a lock', async () => {
    const w = makeWorld({ now: new Date(OLD_END.getTime() - DAY) });
    await expect(w.renewal.rollIfDue(COMPANY)).resolves.toBeNull();
    expect(w.locks).toEqual([]);
    expect(w.branch).toMatchObject({ activity: 'both', activityNext: 'money_agent' });
  });

  it('after it: the downgrade applies AT the old end, the next period opens from the old end to the paid end, under the subscription lock, once', async () => {
    const w = makeWorld({ now: new Date(OLD_END.getTime() + 3 * DAY) });
    const rolled = await w.renewal.rollIfDue(COMPANY);
    expect(rolled).toMatchObject({ at: OLD_END.toISOString(), closedPeriod: true, activityChanges: [{ name: 'Main', from: 'both', to: 'money_agent' }] });
    expect(w.branch).toMatchObject({ activity: 'money_agent', activityNext: null });
    expect(w.branch.activityChangedAt).toEqual(OLD_END);
    expect(w.allocations[0]).toMatchObject({ confirmedAt: OLD_END, confirmedBy: 'system', reason: 'Applied at the renewal.' });
    expect(w.opened).toEqual([{ startsAt: OLD_END, end: NEW_END }]);
    expect(w.events.map((e) => e.kind)).toEqual(['activity_changed', 'renewed']);
    expect(w.locks).toHaveLength(1);
    expect(w.locks[0]).toMatch(/FROM subscriptions WHERE company_id = \? FOR UPDATE/);

    // The next look finds the new period running: nothing more.
    await expect(w.renewal.rollIfDue(COMPANY)).resolves.toBeNull();
    expect(w.opened).toHaveLength(1);
  });

  it('a lapsed shop (nothing prepaid beyond the period) is not rolled: it renews by an admin action', async () => {
    const w = makeWorld({ now: new Date(OLD_END.getTime() + DAY), currentPeriodEnd: OLD_END });
    await expect(w.renewal.rollIfDue(COMPANY)).resolves.toBeNull();
    expect(w.opened).toEqual([]);
  });
});

describe('a roll now, at the instant paid access starts (0095)', () => {
  const NOW = new Date('2026-10-14T09:00:00.000Z');
  const TRIAL_END = new Date('2026-10-20T10:00:00.000Z');

  it('without an instant it begins now, and says it opened', async () => {
    const w = makeWorld({ now: NOW, unbilled: true });
    const rolled = await w.renewal.rollNow(COMPANY, SUB, NEW_END, 'ops@example.test');
    expect(rolled).toMatchObject({ at: NOW.toISOString(), closedPeriod: false });
    expect(w.opened).toEqual([{ startsAt: NOW, end: NEW_END }]);
    expect(w.events.map((e) => e.note)).toContain("First billing period opened at today's size and prices.");
  });

  it('at a free trial’s end it begins there — the period at the end, the downgrade applied now and dated now (R1-F3)', async () => {
    const w = makeWorld({ now: NOW, unbilled: true });
    const rolled = await w.renewal.rollNow(COMPANY, SUB, NEW_END, 'ops@example.test', TRIAL_END);
    expect(rolled).toMatchObject({ at: TRIAL_END.toISOString(), closedPeriod: false });
    expect(w.closed).toEqual([TRIAL_END]);
    expect(w.opened).toEqual([{ startsAt: TRIAL_END, end: NEW_END }]);
    // Applied as the roll runs, as before (moving it to the trial's end is the owner's open question, PQ7) — so dated
    // when it took effect, the roll's own instant read after the lock: never a week ahead of the change in force.
    expect(w.branch).toMatchObject({ activity: 'money_agent', activityNext: null });
    expect(w.branch.activityChangedAt).toEqual(NOW);
    expect(w.allocations[0]).toMatchObject({ confirmedAt: NOW, reason: 'Applied at the approval, ahead of the paid period.' });
    expect(w.events.map((e) => e.kind)).toEqual(['activity_changed', 'renewed']);
    expect(w.events[0].note).toBe('Store "Main": both → money_agent at the approval, ahead of the paid period that starts when the free trial ends.');
    expect(w.events[0].note).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(w.events[1].note).toBe(`First billing period opens on ${TRIAL_END.toISOString()}, at today's size and the prices in force then.`);
    expect(w.locks).toHaveLength(1);
  });

  it('a roll that begins now stamps the change with its own instant and says "at the renewal", as before', async () => {
    const w = makeWorld({ now: NOW, unbilled: true });
    await w.renewal.rollNow(COMPANY, SUB, NEW_END, 'ops@example.test', NOW);
    expect(w.branch.activityChangedAt).toEqual(NOW);
    expect(w.allocations[0]).toMatchObject({ confirmedAt: NOW, reason: 'Applied at the renewal.' });
    expect(w.events[0].note).toBe('Store "Main": both → money_agent at the renewal.');
  });

  it('whether the period is deferred is decided by the clock read after the lock', async () => {
    let now = new Date(TRIAL_END.getTime() - 1_000);
    const w = makeWorld({ now, unbilled: true });
    // The clock the renewal reads moves past the trial's end while it waits for the lock.
    const clock = { now: () => now };
    const renewal = new SubscriptionRenewal(
      { ...w.db, $queryRaw: async () => void (now = new Date(TRIAL_END.getTime() + 1_000)), $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...w.db, $queryRaw: async () => void (now = new Date(TRIAL_END.getTime() + 1_000)) }) } as never,
      w.billing,
      clock,
    );
    await renewal.rollNow(COMPANY, SUB, NEW_END, 'ops@example.test', TRIAL_END);
    expect(w.allocations[0]).toMatchObject({ confirmedAt: TRIAL_END, reason: 'Applied at the renewal.' });
    expect(w.events.find((e) => e.kind === 'renewed')!.note).toBe("First billing period opened at today's size and prices.");
  });

  it('a deferred roll over an earlier period closes it at that instant and says the next one opens then', async () => {
    const w = makeWorld({ now: NOW, activityNext: null });
    await w.renewal.rollNow(COMPANY, SUB, NEW_END, 'ops@example.test', TRIAL_END);
    expect(w.closed).toEqual([TRIAL_END]);
    expect(w.events.map((e) => e.note)).toEqual([
      `Renewed: the billing period closes and a new one opens on ${TRIAL_END.toISOString()}, at today's size and the prices in force then.`,
    ]);
  });
});

describe('the period helpers', () => {
  const NOW = new Date('2026-10-15T10:00:00.000Z');
  function billingWith(period: Record<string, unknown> | null) {
    const writes: unknown[] = [];
    const prisma = {
      billingPeriod: {
        findFirst: async () => period,
        update: async (a: unknown) => void writes.push(a),
      },
      planVersion: {
        findMany: async () => [{ id: Buffer.alloc(16, 3), planKey: 'standard', version: 4, branchMonthly: 500, agentMonthly: 350, bothMonthly: 900, includedStaffPerBranch: 1, extraStaffMonthly: 100, effectiveFrom: new Date('2026-10-10T00:00:00Z'), reason: 'v4' }],
      },
    };
    return { billing: new BillingService(prisma as never, { now: () => NOW }), writes };
  }
  const period = (end: Date | null) => ({
    id: Buffer.alloc(16, 1),
    periodStart: new Date('2026-10-01T00:00:00Z'),
    periodEnd: end,
    branchMonthly: 500,
    agentMonthly: 300,
    bothMonthly: 700,
    includedStaffPerBranch: 1,
    extraStaffMonthly: 100,
    assessedBranchFee: 300,
    assessedStaffFee: 0,
    assessedActivityFeeByBranch: {},
  });

  it('a change made while a paid month runs is priced at that period’s own copied prices, whatever plan was scheduled since', async () => {
    const { billing } = billingWith(period(new Date('2026-10-31T00:00:00Z')));
    await expect(billing.chargeablePricing(COMPANY)).resolves.toEqual({
      running: true,
      pricing: { branchMonthly: 500, agentMonthly: 300, bothMonthly: 700, includedStaffPerBranch: 1, extraStaffMonthly: 100 },
    });
  });

  it('with no paid month running, today’s plan prices it — and says so', async () => {
    const { billing } = billingWith(period(new Date('2026-10-01T00:00:00Z')));
    await expect(billing.chargeablePricing(COMPANY)).resolves.toMatchObject({ running: false, pricing: { bothMonthly: 900, agentMonthly: 350 } });
  });

  it('an ended period is never raised: nothing is added to history', async () => {
    const { billing, writes } = billingWith(period(new Date('2026-10-01T00:00:00Z')));
    await billing.assessNow(COMPANY);
    expect(writes).toEqual([]);
  });
});
