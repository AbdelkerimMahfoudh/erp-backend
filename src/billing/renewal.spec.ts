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

function makeWorld(opts: { now: Date; activityNext?: 'money_agent' | null; currentPeriodEnd?: Date }) {
  const sub = { id: SUB, companyId: COMPANY, status: 'activated', currentPeriodEnd: opts.currentPeriodEnd ?? NEW_END };
  const periods: { id: Buffer; periodStart: Date; periodEnd: Date | null }[] = [
    { id: newUuidV7Bin(), periodStart: new Date(OLD_END.getTime() - 30 * DAY), periodEnd: OLD_END },
  ];
  const branch = { id: MAIN, name: 'Main', activity: 'both', activityNext: opts.activityNext === undefined ? 'money_agent' : opts.activityNext, activityChangedAt: null as Date | null };
  const events: { kind: string; note: string; actor: string }[] = [];
  const allocations = [{ kind: 'activity', status: 'granted', branchId: MAIN, activityTo: 'money_agent', confirmedAt: null as Date | null, confirmedBy: null as string | null, reason: null as string | null }];
  const locks: string[] = [];
  const opened: { startsAt: Date | undefined; end: Date | null }[] = [];
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
  } as unknown as BillingService;
  const renewal = new SubscriptionRenewal(db as never, billing, clock);
  return { renewal, branch, events, allocations, locks, opened, periods };
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
