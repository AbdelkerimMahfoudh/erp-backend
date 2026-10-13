import { readFileSync } from 'node:fs';
import { BillingService, periodRunning } from './billing.service';
import { rollDue } from './renewal';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';

/**
 * A paid period that waits for a free trial to end (0095).
 *
 * Paid access approved during a trial starts at the trial's end, so its billing period opens there — in the future
 * when it is written. Every reader of a company's periods must take it as the one paid for: the running period for
 * pricing and for growth, never due for a roll before it ends. And when a grant made during the trial closes that
 * period at the instant it starts and opens the next at the same instant, the newer of the two is the latest, for
 * every reader, deterministically.
 */

const BILLING = readFileSync('src/billing/billing.service.ts', 'utf8');
const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c201');
const MAIN = uuidToBin('018f0000-0000-7000-8000-00000000b201');
const SECOND = uuidToBin('018f0000-0000-7000-8000-00000000b202');
const OLD = uuidToBin('018f0000-0000-7000-8000-00000000b203');
const NOW = new Date('2026-10-14T09:00:00.000Z');
const TRIAL_END = new Date('2026-10-20T10:00:00.000Z');
const PAID_END = new Date('2026-11-20T10:00:00.000Z');

/** A UUIDv7 written at `ms`: the time-ordered prefix is what the tie-break reads. */
function idAt(ms: number, tail: number): Buffer {
  const id = Buffer.alloc(16, tail);
  id.writeUIntBE(ms, 0, 6);
  return id;
}

type Row = Record<string, any>;

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return Buffer.compare(a, b);
  return 0;
}

/** Rows in the order Prisma's `orderBy` asks for — every key in turn, as MySQL would apply them. */
function ordered(rows: Row[], orderBy: Row | Row[]): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.entries(o)[0] as [string, 'asc' | 'desc']);
  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      const c = compare(a[key], b[key]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

const prices = (branchMonthly: number) => ({
  branchMonthly,
  agentMonthly: 300,
  bothMonthly: 700,
  includedStaffPerBranch: 1,
  extraStaffMonthly: 100,
});

function makeWorld(periods: Row[], opts: { branches?: Row[]; archived?: Row[]; status?: string } = {}) {
  const orderBys: unknown[] = [];
  const updates: { id: Buffer; data: Row }[] = [];
  const prisma = {
    billingPeriod: {
      findFirst: async ({ orderBy, select }: { orderBy: Row | Row[]; select?: Row }) => {
        orderBys.push(orderBy);
        const row = ordered(periods, orderBy)[0];
        if (!row) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };
      },
      update: async ({ where, data }: { where: { id: Buffer }; data: Row }) => {
        updates.push({ id: where.id, data });
        return {};
      },
    },
    // The census's stores, and — asked with an OR — the archived ones a period billed.
    branch: {
      findMany: async ({ where }: { where: Row }) => (where.OR ? (opts.archived ?? []) : (opts.branches ?? [])),
    },
    planVersion: {
      findMany: async () => [
        { id: Buffer.alloc(16, 3), planKey: 'standard', version: 3, ...prices(500), effectiveFrom: new Date('2026-10-08T00:00:00Z'), reason: 'D154' },
      ],
    },
    subscription: { findFirst: async () => ({ status: opts.status ?? 'activated' }) },
    branchReplacement: { findMany: async () => [] },
    seatAllocation: { findMany: async () => [] },
    $queryRaw: async () => [],
  };
  const billing = new BillingService(prisma as never, { now: () => NOW });
  return { billing, orderBys, updates };
}

const store = (id: Buffer, name: string) => ({ id, name, activity: 'electronics', activityNext: null });

describe('two periods that start at the same instant: the one opened later is the latest (0095)', () => {
  // Approved during the trial (P1 opens at its end), then granted during it too: P1 closed at the instant it starts,
  // P2 opened at that same instant. P1 is listed first — a sort on the start alone would keep it.
  const P1 = { id: idAt(NOW.getTime() - 60_000, 1), periodStart: TRIAL_END, periodEnd: TRIAL_END, ...prices(500), assessedBranchFee: 500, assessedStaffFee: 0, assessedActivityFeeByBranch: {} };
  const P2 = { id: idAt(NOW.getTime(), 2), periodStart: TRIAL_END, periodEnd: PAID_END, ...prices(600), assessedBranchFee: 600, assessedStaffFee: 0, assessedActivityFeeByBranch: {} };

  it('every reader orders newest first, and breaks a tie by the newer id', async () => {
    const w = makeWorld([P1, P2], { branches: [store(MAIN, 'Main')] });
    expect((await w.billing.latestPeriod(COMPANY))?.id).toEqual(P2.id);
    await w.billing.closeCurrentPeriod(COMPANY, new Date(PAID_END.getTime() - 1));
    expect(w.updates.map((u) => u.id)).toEqual([P2.id]);
    await expect(w.billing.chargeablePricing(COMPANY)).resolves.toEqual({ running: true, pricing: prices(600) });
    expect((await w.billing.pricingFor(COMPANY)).currentPeriod.assessedTotal).toBe(600);
    await w.billing.assessNow(COMPANY);
    expect(w.orderBys.length).toBeGreaterThanOrEqual(5);
    for (const orderBy of w.orderBys) expect(orderBy).toEqual([{ periodStart: 'desc' }, { id: 'desc' }]);
  });

  it('no reader of the periods keeps a start-only order', () => {
    expect(BILLING).not.toMatch(/orderBy:\s*\{\s*periodStart:\s*'desc'\s*\}/);
  });
});

describe('a period that starts at the end of a free trial is the one paid for, before it starts (0095)', () => {
  const deferred = (over: Row = {}) => ({
    id: idAt(NOW.getTime(), 3),
    periodStart: TRIAL_END,
    periodEnd: PAID_END,
    ...prices(500),
    assessedBranchFee: 500,
    assessedStaffFee: 0,
    assessedActivityFeeByBranch: { [binToUuid(MAIN)]: 500 },
    ...over,
  });

  it('is running, and no roll is due before it ends', () => {
    expect(periodRunning(deferred(), NOW)).toBe(true);
    expect(rollDue({ status: 'activated', currentPeriodEnd: PAID_END }, deferred(), NOW)).toBe(false);
    expect(rollDue({ status: 'activated', currentPeriodEnd: PAID_END }, deferred(), PAID_END)).toBe(false);
  });

  it('prices a change at its own copied prices, and shows its start as it is', async () => {
    const w = makeWorld([deferred({ ...prices(450) })], { branches: [store(MAIN, 'Main')] });
    await expect(w.billing.chargeablePricing(COMPANY)).resolves.toEqual({ running: true, pricing: prices(450) });
    const pricing = await w.billing.pricingFor(COMPANY);
    expect(pricing.currentPeriod).toMatchObject({ periodStart: TRIAL_END.toISOString(), available: true });
  });

  it('growth while it waits is assessed on it', async () => {
    const w = makeWorld([deferred()], { branches: [store(MAIN, 'Main'), store(SECOND, 'Second')] });
    await w.billing.assessNow(COMPANY);
    expect(w.updates).toHaveLength(1);
    expect(w.updates[0].data).toMatchObject({ activeBranchCount: 2, assessedBranchFee: 1000, assessedTotal: 1000 });
  });

  it('a store archived while it waits leaves a slot in it', async () => {
    const fees = { [binToUuid(MAIN)]: 500, [binToUuid(OLD)]: 500 };
    const w = makeWorld([deferred({ assessedActivityFeeByBranch: fees })], {
      branches: [store(MAIN, 'Main')],
      archived: [{ id: OLD, name: 'Old', activity: 'electronics' }],
    });
    const found = await w.billing.replacementSlots(COMPANY);
    expect(found?.period.id).toEqual(deferred().id);
    expect(found?.slots).toEqual([{ branchId: binToUuid(OLD), name: 'Old', activity: 'electronics', assessedFee: 500, credit: 0, value: 500 }]);
  });
});
