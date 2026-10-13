import { readFileSync } from 'node:fs';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { stateOf } from '../entitlement/entitlement-rules';
import { trialFactsOf } from './trial/trial-rules';

/**
 * Approval, refusal and a corrected period (0075), against a subscription
 * that behaves like the row — including the optimistic `version` check that
 * turns two administrators into one winner and one refusal.
 *
 * And the renewal (D154 a, refined after review on 2026-10-09): the moment the
 * next paid period begins. An approval, a grant, or an extension or correction
 * of a business whose period has ENDED rolls at once — the downgrades scheduled
 * for it applied, the old period closed, the next opened at the new size. An
 * extension of a period still RUNNING only moves the end: the roll is due at the
 * old end (billing/renewal.ts applies it then), so a shop never loses an
 * activity it paid for before its month is over; a correction while running
 * re-dates the running period and renews nothing.
 */

const COMPANY = '018f0000-0000-7000-8000-00000000c001';
const ADMIN = { id: newUuidV7Bin(), email: 'ops@example.test', name: 'Ops' };
const CTX = { admin: ADMIN, ip: '127.0.0.1' };
const DAY = 24 * 60 * 60 * 1000;
const SERVICE = readFileSync('src/platform/subscription-lifecycle.service.ts', 'utf8');

type Status = 'pending_activation' | 'activated' | 'suspended' | 'cancelled' | 'rejected';

interface BranchRow {
  id: Buffer;
  name: string;
  activity: 'electronics' | 'money_agent' | 'both';
  activityNext: 'electronics' | 'money_agent' | 'both' | null;
  activityChangedAt: Date | null;
}

/** The free trial's rows (0095), as the fence reads and closes them, and the clock it reads them by. */
interface TrialWorld {
  eligibility?: { closedAt: Date | null; closedReason: string | null } | null;
  claim?: { claimedAt: Date; startedAt: Date; endsAt: Date } | null;
  now?: Date;
  /** Never billed at all: a pending business suspended during its trial and reinstated is `activated` with no period. */
  unbilled?: boolean;
}

function makeWorld(status: Status, over: Record<string, unknown> = {}, branches: BranchRow[] = [], trial: TrialWorld = {}) {
  const sub: Record<string, any> = {
    id: newUuidV7Bin(),
    companyId: uuidToBin(COMPANY),
    status,
    currentPeriodEnd: null,
    isComplimentary: false,
    complimentaryReason: null,
    complimentaryUntil: null,
    subscribedBranchCount: 1,
    additionalSeats: 0,
    version: 3,
    company: { name: 'Shop', publicStoreId: 'ABCDEF1234' },
    ...over,
  };
  const events: any[] = [];
  const audits: any[] = [];
  const periods: (Date | null)[] = [];
  const closes: Date[] = [];
  const redates: Date[] = [];
  /** What happened in which order: a renewal must apply downgrades, close, then open. */
  const order: string[] = [];
  /** The fence's own steps, in order: every lock taken, the eligibility closed, the claim read, the transition. */
  const steps: string[] = [];
  /** Where each opened period starts (`openPeriod`'s `startsAt`). */
  const starts: (Date | null)[] = [];
  const eligibility = trial.eligibility ? { ...trial.eligibility } : null;
  const claim = trial.claim ? { ...trial.claim } : null;
  const clock = { now: () => trial.now ?? new Date() };
  const allocations: any[] = [];
  // A running business has a period, ending where its subscription ends; a pending one has nothing yet.
  let latest: { periodEnd: Date | null } | null =
    status === 'activated' && !trial.unbilled ? { periodEnd: (sub.currentPeriodEnd as Date | null) ?? null } : null;

  const prisma: Record<string, any> = {
    branch: {
      findMany: async () => branches.filter((b) => b.activityNext !== null).map((b) => ({ ...b })),
      update: async ({ where, data }: any) => {
        const b = branches.find((x) => x.id.equals(where.id))!;
        Object.assign(b, data);
        order.push(`branch.update:${b.name}`);
        return { ...b };
      },
    },
    seatAllocation: {
      updateMany: async ({ where, data }: any) => {
        const hits = allocations.filter(
          (a) =>
            a.kind === where.kind &&
            a.status === where.status &&
            a.branchId.equals(where.branchId) &&
            a.activityTo === where.activityTo &&
            a.confirmedAt === where.confirmedAt,
        );
        for (const a of hits) {
          const { version, ...rest } = data;
          Object.assign(a, rest, { version: a.version + (version?.increment ?? 0) });
        }
        return { count: hits.length };
      },
    },
    subscription: {
      findFirst: async () => ({ ...sub }),
      update: async ({ where, data }: any) => {
        steps.push('transition');
        if (where.version !== undefined && where.version !== sub.version) {
          throw new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' });
        }
        const { version, ...rest } = data;
        void version;
        Object.assign(sub, rest, { version: sub.version + 1 });
        return { ...sub };
      },
    },
    subscriptionEvent: {
      create: async ({ data }: any) => {
        events.push(data);
        return data;
      },
    },
    // The fence closes an open eligibility, once, and reads the claim. Nothing here ever writes a claim.
    trialEligibility: {
      updateMany: async ({ where, data }: any) => {
        steps.push('eligibility');
        if (!eligibility || !where.companyId.equals(sub.companyId) || eligibility.closedAt !== where.closedAt) return { count: 0 };
        Object.assign(eligibility, data);
        return { count: 1 };
      },
    },
    trialClaim: {
      findUnique: async () => {
        steps.push('claim');
        return claim ? { endsAt: claim.endsAt } : null;
      },
    },
  };
  // One transaction at a time, all or nothing for the rows the fence decides on: a refusal inside it — a stale
  // version, an end inside the trial — leaves the subscription and the eligibility as they were.
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const saved = { sub: { ...sub }, eligibility: eligibility ? { ...eligibility } : null };
    try {
      return await fn(prisma);
    } catch (e) {
      Object.assign(sub, saved.sub);
      if (eligibility && saved.eligibility) Object.assign(eligibility, saved.eligibility);
      throw e;
    }
  };
  prisma.$queryRaw = async () => {
    steps.push('lock');
    return [];
  };
  const audit = {
    record: async (e: unknown) => {
      audits.push(e);
    },
  };
  const billing = {
    latestPeriod: async () => (latest ? { ...latest } : null),
    openPeriod: async (_c: Buffer, _s: Buffer, end: Date | null, opts: { startsAt?: Date } = {}) => {
      periods.push(end);
      starts.push(opts.startsAt ?? null);
      order.push('open');
      latest = { periodEnd: end };
    },
    closeCurrentPeriod: async (_c: Buffer, at: Date) => {
      closes.push(at);
      order.push('close');
      const had = latest !== null;
      if (latest && (latest.periodEnd === null || latest.periodEnd.getTime() > at.getTime())) latest.periodEnd = at;
      return had;
    },
    redateRunningPeriod: async (_c: Buffer, end: Date) => {
      redates.push(end);
      order.push('redate');
      if (latest) latest.periodEnd = end;
      return true;
    },
  };
  const service = new SubscriptionLifecycleService(prisma as never, audit as never, billing as never, clock);
  return {
    service,
    sub,
    events,
    audits,
    periods,
    starts,
    closes,
    redates,
    order,
    steps,
    eligibility,
    claim,
    branches,
    allocations,
    latest: () => latest,
  };
}

describe('approving a pending registration', () => {
  it('starts a paid period of the months given, and opens the billing period', async () => {
    const { service, sub, events, audits, periods } = makeWorld('pending_activation');
    const before = Date.now();
    const r = await service.approve(COMPANY, { months: 3, reason: 'Paid by transfer' }, CTX);

    expect(r.applied).toBe(true);
    expect(sub.status).toBe('activated');
    const end = sub.currentPeriodEnd as Date;
    const expected = new Date(before);
    expected.setMonth(expected.getMonth() + 3);
    expect(Math.abs(end.getTime() - expected.getTime())).toBeLessThan(5_000);

    // `renewed` since D154 a: the first period opens through the renewal routine, which says so.
    expect(events.map((e) => e.kind)).toEqual(['approved', 'renewed']);
    expect(events[1].note).toMatch(/First billing period/);
    expect(events[0].periodEndAfter).toBe(end);
    expect(events[0].actor).toBe(ADMIN.email);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'subscription.approve',
      reason: 'Paid by transfer',
      before: { status: 'pending_activation' },
      after: { status: 'activated', months: 3, paymentRecorded: false },
    });
    expect(periods).toEqual([end]);
  });

  it('takes an exact end date instead, when that is what was agreed', async () => {
    const { service, sub } = makeWorld('pending_activation');
    const end = new Date(Date.now() + 45 * DAY);
    await service.approve(COMPANY, { periodEnd: end }, CTX);
    expect((sub.currentPeriodEnd as Date).getTime()).toBe(end.getTime());
  });

  it('wants exactly one of the two ways of saying how long', async () => {
    const { service } = makeWorld('pending_activation');
    await expect(service.approve(COMPANY, {}, CTX)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.approve(COMPANY, { months: 1, periodEnd: new Date(Date.now() + DAY) }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.approve(COMPANY, { months: 0 }, CTX)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.approve(COMPANY, { months: 61 }, CTX)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.approve(COMPANY, { periodEnd: new Date(Date.now() - DAY) }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is a no-op on a retry, once the business is already running', async () => {
    const { service, events } = makeWorld('activated', { currentPeriodEnd: new Date(Date.now() + 30 * DAY) });
    const r = await service.approve(COMPANY, { months: 1 }, CTX);
    expect(r.applied).toBe(false);
    expect(events).toEqual([]);
  });

  it('can reverse a refusal, but never stands in for reinstatement', async () => {
    const refused = makeWorld('rejected');
    await expect(refused.service.approve(COMPANY, { months: 1 }, CTX)).resolves.toMatchObject({ applied: true });
    expect(refused.sub.status).toBe('activated');

    for (const status of ['suspended', 'cancelled'] as const) {
      const { service, events } = makeWorld(status);
      await expect(service.approve(COMPANY, { months: 1 }, CTX)).rejects.toBeInstanceOf(BadRequestException);
      expect(events).toEqual([]);
    }
  });

  it('loses cleanly to a concurrent change', async () => {
    const { service, events } = makeWorld('pending_activation');
    await expect(service.approve(COMPANY, { months: 1, expectedVersion: 2 }, CTX)).rejects.toMatchObject({
      constructor: ConflictException,
      response: { code: 'subscription_changed' },
    });
    expect(events).toEqual([]);
  });
});

describe('refusing a pending registration', () => {
  it('needs a reason, and records it on the event and the audit trail', async () => {
    const { service, sub, events, audits } = makeWorld('pending_activation');
    await expect(service.reject(COMPANY, { reason: '  ' }, CTX)).rejects.toBeInstanceOf(BadRequestException);

    const r = await service.reject(COMPANY, { reason: 'Duplicate of an existing shop' }, CTX);
    expect(r.applied).toBe(true);
    expect(sub.status).toBe('rejected');
    expect(events).toEqual([expect.objectContaining({ kind: 'rejected', note: 'Duplicate of an existing shop' })]);
    expect(audits[0]).toMatchObject({ action: 'subscription.reject', reason: 'Duplicate of an existing shop' });
  });

  it('is a no-op the second time, and refuses to touch a business that ever ran', async () => {
    const again = makeWorld('rejected');
    await expect(again.service.reject(COMPANY, { reason: 'x' }, CTX)).resolves.toMatchObject({ applied: false });

    for (const status of ['activated', 'suspended', 'cancelled'] as const) {
      const { service, sub } = makeWorld(status);
      await expect(service.reject(COMPANY, { reason: 'x' }, CTX)).rejects.toBeInstanceOf(BadRequestException);
      expect(sub.status).toBe(status);
    }
  });
});

describe('correcting the period end', () => {
  const in30 = () => new Date(Date.now() + 30 * DAY);

  it('shortening needs a reason; lengthening does not', async () => {
    const { service, sub, audits, events } = makeWorld('activated', { currentPeriodEnd: in30() });
    const sooner = new Date(Date.now() + 10 * DAY);
    await expect(service.setPeriodEnd(COMPANY, { periodEnd: sooner }, CTX)).rejects.toBeInstanceOf(BadRequestException);

    await service.setPeriodEnd(COMPANY, { periodEnd: sooner, reason: 'Approved for one month by mistake' }, CTX);
    expect((sub.currentPeriodEnd as Date).getTime()).toBe(sooner.getTime());
    expect(audits[0]).toMatchObject({ action: 'subscription.set_period', after: { direction: 'shortened' } });

    const later = new Date(Date.now() + 90 * DAY);
    await service.setPeriodEnd(COMPANY, { periodEnd: later }, CTX);
    expect(audits[1]).toMatchObject({ after: { direction: 'lengthened', redated: true, renewal: null } });
    // A correction of a running period re-dates it, either way; neither renews (reviewed 2026-10-09).
    expect(events.map((e) => e.kind)).toEqual(['period_corrected', 'period_corrected']);
  });

  it('is a no-op when the date is already the one asked for', async () => {
    const end = in30();
    const { service, events } = makeWorld('activated', { currentPeriodEnd: end });
    await expect(service.setPeriodEnd(COMPANY, { periodEnd: new Date(end) }, CTX)).resolves.toMatchObject({
      applied: false,
    });
    expect(events).toEqual([]);
  });

  it('only a running business has a period to correct', async () => {
    for (const status of ['pending_activation', 'rejected', 'suspended', 'cancelled'] as const) {
      const { service } = makeWorld(status);
      await expect(service.setPeriodEnd(COMPANY, { periodEnd: in30(), reason: 'x' }, CTX)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('refuses a nonsense date and a period longer than extend allows', async () => {
    const { service } = makeWorld('activated', { currentPeriodEnd: in30() });
    await expect(service.setPeriodEnd(COMPANY, { periodEnd: new Date('nope') }, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const farFuture = new Date();
    farFuture.setMonth(farFuture.getMonth() + 61);
    await expect(service.setPeriodEnd(COMPANY, { periodEnd: farFuture }, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('a renewal: the period end moves forward (D154 a)', () => {
  const in30 = () => new Date(Date.now() + 30 * DAY);
  const MAIN = uuidToBin('018f0000-0000-7000-8000-00000000b001');
  const scheduledDowngrade = (): BranchRow => ({
    id: MAIN,
    name: 'Main',
    activity: 'both',
    activityNext: 'money_agent',
    activityChangedAt: null,
  });
  const scheduledRow = () => ({
    kind: 'activity',
    status: 'granted',
    branchId: MAIN,
    activityTo: 'money_agent',
    confirmedAt: null,
    confirmedBy: null,
    reason: null,
    version: 0,
  });

  const ago20 = () => new Date(Date.now() - 20 * DAY);

  it('extending a period still RUNNING moves the end and nothing else: the paid activity is kept to the end of its month (reviewed 2026-10-09)', async () => {
    const oldEnd = in30();
    const w = makeWorld('activated', { currentPeriodEnd: oldEnd }, [scheduledDowngrade()]);
    w.allocations.push(scheduledRow());
    const r = await w.service.extend(COMPANY, { months: 1, reason: 'Paid November early' }, CTX);
    expect(r.applied).toBe(true);
    expect((w.sub.currentPeriodEnd as Date).getTime()).toBeGreaterThan(oldEnd.getTime());
    // Nothing applied, closed or opened: the shop keeps `both` until the period it paid for ends.
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: 'money_agent' });
    expect(w.allocations[0]).toMatchObject({ confirmedAt: null });
    expect(w.order).toEqual([]);
    expect(w.events.map((e) => e.kind)).toEqual(['extended']);
    // The audit says when the renewal falls due: at the running period's end.
    expect(w.audits[0]).toMatchObject({ action: 'subscription.extend', after: { renewal: null, renewalDueAt: oldEnd.toISOString() } });
  });

  it('extending a period that has ENDED renews now: the downgrade applies, the old period is kept as it was, the next opens — in that order', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: ago20() }, [scheduledDowngrade()]);
    w.allocations.push(scheduledRow());
    const before = Date.now();
    await w.service.extend(COMPANY, { months: 1, reason: 'Paid for October' }, CTX);

    expect(w.branches[0]).toMatchObject({ activity: 'money_agent', activityNext: null });
    expect(w.branches[0].activityChangedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(w.allocations[0]).toMatchObject({ status: 'granted', confirmedBy: ADMIN.email, reason: 'Applied at the renewal.', version: 1 });
    expect(w.allocations[0].confirmedAt).toBeInstanceOf(Date);

    // Downgrades first, then the close, then the new period — so the new period is sized after the change.
    expect(w.order).toEqual(['branch.update:Main', 'close', 'open']);
    expect(w.periods).toEqual([w.sub.currentPeriodEnd]);
    expect(w.events.map((e) => e.kind)).toEqual(['extended', 'activity_changed', 'renewed']);
    expect(w.events[1].note).toMatch(/Main.*both → money_agent/);
    expect(w.events[2].note).toMatch(/Renewed/);
    expect(w.audits[0]).toMatchObject({
      action: 'subscription.extend',
      after: { renewal: { closedPeriod: true, activityChanges: [{ name: 'Main', from: 'both', to: 'money_agent' }] } },
    });
  });

  it('a renewal with nothing scheduled still opens the next period, and says it applied nothing', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: ago20() }, [{ ...scheduledDowngrade(), activityNext: null }]);
    await w.service.extend(COMPANY, { months: 2 }, CTX);
    expect(w.order).toEqual(['close', 'open']);
    expect(w.events.map((e) => e.kind)).toEqual(['extended', 'renewed']);
    expect(w.audits[0].after.renewal).toMatchObject({ closedPeriod: true, activityChanges: [] });
  });

  it('shortening is a correction, never a renewal: the running period is re-dated, nothing applied, nothing opened', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: in30() }, [scheduledDowngrade()]);
    const sooner = new Date(Date.now() + 10 * DAY);
    await w.service.setPeriodEnd(COMPANY, { periodEnd: sooner, reason: 'Mistyped' }, CTX);
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: 'money_agent' });
    expect(w.order).toEqual(['redate']);
    expect(w.redates).toEqual([sooner]);
    expect(w.events.map((e) => e.kind)).toEqual(['period_corrected']);
    expect(w.audits[0].after.renewal).toBeNull();
  });

  it('a correction that lengthens a running period re-dates it — a typo fix never opens a one-day period or applies a downgrade early', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: in30() }, [scheduledDowngrade()]);
    const later = new Date(Date.now() + 31 * DAY);
    await w.service.setPeriodEnd(COMPANY, { periodEnd: later }, CTX);
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: 'money_agent' });
    expect(w.order).toEqual(['redate']);
    expect(w.latest()).toEqual({ periodEnd: later });
    expect(w.events.map((e) => e.kind)).toEqual(['period_corrected']);
  });

  it('a new end in the future for a business whose period ENDED renews now', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: ago20() }, [scheduledDowngrade()]);
    const later = new Date(Date.now() + 90 * DAY);
    await w.service.setPeriodEnd(COMPANY, { periodEnd: later }, CTX);
    expect(w.branches[0]).toMatchObject({ activity: 'money_agent', activityNext: null });
    expect(w.order).toEqual(['branch.update:Main', 'close', 'open']);
    expect(w.periods).toEqual([later]);
    expect(w.events.map((e) => e.kind)).toEqual(['period_corrected', 'activity_changed', 'renewed']);
  });

  it('a grant is a renewal: the running period closes at the grant, the scheduled downgrade applies, the grant period opens — never two overlapping periods', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: in30() }, [scheduledDowngrade()]);
    await w.service.activateByGrant(COMPANY, { days: 30, reason: 'Pilot partner' }, CTX);
    expect(w.order).toEqual(['branch.update:Main', 'close', 'open']);
    expect(w.closes).toHaveLength(1);
    expect(w.periods).toEqual([w.sub.complimentaryUntil]);
    expect(w.events.map((e) => e.kind)).toEqual(['administrative_grant', 'activity_changed', 'renewed']);
  });

  it('a lapsed shop that renews opens its new period from now, for the new end', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: ago20() });
    const before = Date.now();
    await w.service.extend(COMPANY, { months: 1 }, CTX);
    const end = w.sub.currentPeriodEnd as Date;
    const expected = new Date(before);
    expected.setMonth(expected.getMonth() + 1);
    expect(Math.abs(end.getTime() - expected.getTime())).toBeLessThan(5_000);
    expect(w.periods).toEqual([end]);
    expect(w.closes).toHaveLength(1);
  });

  it('the version guard still decides first: a lost race applies nothing, renews nothing', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: in30() }, [scheduledDowngrade()]);
    await expect(w.service.extend(COMPANY, { months: 1, expectedVersion: 2 }, CTX)).rejects.toMatchObject({
      constructor: ConflictException,
      response: { code: 'subscription_changed' },
    });
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: 'money_agent' });
    expect(w.order).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('a first approval opens the first period through the same routine and says so; a retry still opens nothing', async () => {
    const w = makeWorld('pending_activation', {}, [scheduledDowngrade()]);
    await w.service.approve(COMPANY, { months: 1 }, CTX);
    // A downgrade scheduled before approval is applied: the first period opens at the size the shop asked for.
    expect(w.branches[0]).toMatchObject({ activity: 'money_agent', activityNext: null });
    expect(w.order).toEqual(['branch.update:Main', 'close', 'open']);
    expect(w.events.map((e) => e.kind)).toEqual(['approved', 'activity_changed', 'renewed']);
    expect(w.audits[0].after.renewal).toMatchObject({ closedPeriod: false });
    const again = await w.service.approve(COMPANY, { months: 1 }, CTX);
    expect(again.applied).toBe(false);
    expect(w.periods).toHaveLength(1);
  });
});

/**
 * The free trial's fence and the deferred paid start (0095; the owner's decision of 2026-10-13).
 *
 * Every Super Admin decision that makes a business paid, granted, refused or cancelled closes its trial eligibility
 * under the subscription lock; paid access given while the trial runs starts when it ends — the trial is never
 * shortened, extended or rewritten, and nothing paid runs beside it.
 */
describe('the free trial’s fence, and paid access that waits for the trial’s end (0095)', () => {
  const NOW = new Date('2026-10-14T09:00:00.000Z');
  const START = new Date('2026-10-13T10:00:00.000Z');
  const END = new Date(START.getTime() + 168 * 60 * 60 * 1000);
  const running = { claimedAt: START, startedAt: START, endsAt: END };
  const open = () => ({ closedAt: null, closedReason: null });
  const months = (from: Date, n: number) => {
    const d = new Date(from);
    d.setMonth(d.getMonth() + n);
    return d;
  };

  it('approved before any claim: the eligibility closes and paid access starts now', async () => {
    const w = makeWorld('pending_activation', {}, [], { eligibility: open(), now: NOW });
    await w.service.approve(COMPANY, { months: 1, reason: 'Paid by transfer' }, CTX);

    expect(w.eligibility).toEqual({ closedAt: NOW, closedReason: 'approved' });
    // Subscription first, then the eligibility, then the claim, then the decision — one transaction.
    expect(w.steps.slice(0, 4)).toEqual(['lock', 'eligibility', 'claim', 'transition']);
    expect(w.sub.currentPeriodEnd).toEqual(months(NOW, 1));
    expect(w.starts).toEqual([NOW]);
    expect(w.closes).toEqual([NOW]);
    expect(w.events[0]).toMatchObject({ kind: 'approved', note: 'Paid by transfer' });
    expect(w.audits[0].after).toMatchObject({ paidFrom: NOW.toISOString(), trialEndsAt: null });
  });

  it('approved during a running trial: paid access starts at its end — the months counted from there, the first period opened there', async () => {
    const w = makeWorld('pending_activation', {}, [], { eligibility: open(), claim: running, now: NOW });
    await w.service.approve(COMPANY, { months: 1, reason: 'Paid by transfer' }, CTX);

    expect(w.sub).toMatchObject({ status: 'activated', currentPeriodEnd: months(END, 1) });
    expect(w.closes).toEqual([END]);
    expect(w.starts).toEqual([END]);
    expect(w.periods).toEqual([months(END, 1)]);
    expect(w.events.map((e) => e.kind)).toEqual(['approved', 'renewed']);
    expect(w.events[0].note).toBe(`Paid by transfer Paid access starts when the free trial ends at ${END.toISOString()}.`);
    expect(w.events[1].note).toBe(`First billing period opens on ${END.toISOString()}, at today's size and the prices in force then.`);
    expect(w.audits[0]).toMatchObject({
      action: 'subscription.approve',
      after: { paidFrom: END.toISOString(), trialEndsAt: END.toISOString(), paymentRecorded: false },
    });
    expect(w.eligibility).toEqual({ closedAt: NOW, closedReason: 'approved' });
    // The trial is untouched: the same three instants, and the state is the trial's until its last millisecond.
    expect(w.claim).toEqual(running);
    const record = { ...w.sub, trial: trialFactsOf(w.eligibility, w.claim) } as never;
    expect(stateOf(record, new Date(END.getTime() - 1))).toBe('trial_active');
    expect(stateOf(record, END)).toBe('active');
  });

  it('an exact end date inside the trial is refused, and the refusal leaves the eligibility as it was', async () => {
    const w = makeWorld('pending_activation', {}, [], { eligibility: open(), claim: running, now: NOW });
    const refused = await w.service.approve(COMPANY, { periodEnd: new Date(END) }, CTX).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BadRequestException);
    expect((refused as BadRequestException).getResponse()).toEqual({
      code: 'period_ends_before_trial_end',
      message: `The end date must be after the free trial ends on ${END.toISOString()}.`,
    });
    expect(w.eligibility).toEqual(open());
    expect(w.sub.status).toBe('pending_activation');
    expect(w.events).toEqual([]);

    // One millisecond past the trial's end is a period: it opens at the end and runs that millisecond.
    await w.service.approve(COMPANY, { periodEnd: new Date(END.getTime() + 1) }, CTX);
    expect(w.starts).toEqual([END]);
    expect(w.periods).toEqual([new Date(END.getTime() + 1)]);
  });

  it('granted during a running trial: the grant’s days start at the trial’s end', async () => {
    const w = makeWorld('pending_activation', {}, [], { eligibility: open(), claim: running, now: NOW });
    await w.service.activateByGrant(COMPANY, { days: 30, reason: 'Pilot partner' }, CTX);

    const until = new Date(END.getTime() + 30 * DAY);
    expect(w.sub).toMatchObject({ status: 'activated', isComplimentary: true, complimentaryUntil: until });
    expect(w.starts).toEqual([END]);
    expect(w.periods).toEqual([until]);
    expect(w.eligibility).toEqual({ closedAt: NOW, closedReason: 'granted' });
    expect(w.audits[0].after).toMatchObject({ grantDays: 30, grantFrom: END.toISOString(), trialEndsAt: END.toISOString() });
    const record = { ...w.sub, trial: trialFactsOf(w.eligibility, w.claim) } as never;
    expect(stateOf(record, new Date(END.getTime() - 1))).toBe('trial_active');
    expect(stateOf(record, END)).toBe('complimentary');
  });

  it('a grant’s retry is recognised by the same deferred end, and stacks nothing', async () => {
    const w = makeWorld('pending_activation', {}, [], { eligibility: open(), claim: running, now: NOW });
    await w.service.activateByGrant(COMPANY, { days: 30, reason: 'Pilot partner' }, CTX);
    const again = await w.service.activateByGrant(COMPANY, { days: 30, reason: 'Pilot partner' }, CTX);
    expect(again.applied).toBe(false);
    expect(w.periods).toHaveLength(1);
  });

  it('extended during a running trial with nothing paid yet: the new period starts at the trial’s end', async () => {
    const w = makeWorld('pending_activation', {}, [], { eligibility: open(), claim: running, now: NOW });
    await w.service.extend(COMPANY, { months: 2 }, CTX);
    expect(w.sub).toMatchObject({ status: 'activated', currentPeriodEnd: months(END, 2) });
    expect(w.starts).toEqual([END]);
    expect(w.eligibility).toEqual({ closedAt: NOW, closedReason: 'paid_period' });
    expect(w.audits[0].after).toMatchObject({ trialEndsAt: END.toISOString() });
  });

  it('extended after an approval deferred to the trial’s end: only the end moves — the deferred period is the one running', async () => {
    const paidEnd = months(END, 1);
    const closed = { closedAt: START, closedReason: 'approved' };
    const w = makeWorld('activated', { currentPeriodEnd: paidEnd }, [], { eligibility: closed, claim: running, now: NOW });
    await w.service.extend(COMPANY, { months: 1 }, CTX);
    expect(w.sub.currentPeriodEnd).toEqual(months(paidEnd, 1));
    expect(w.order).toEqual([]);
    // Closed once, by the approval: the extension changes nothing about it.
    expect(w.eligibility).toEqual(closed);
  });

  it('a period set while a reinstated business’s trial still runs must end after it, and opens at its end', async () => {
    // Suspended mid-trial and reinstated: `activated` with no period, the trial clock still running.
    const w = makeWorld('activated', { currentPeriodEnd: null }, [], { eligibility: open(), claim: running, now: NOW, unbilled: true });
    await expect(w.service.setPeriodEnd(COMPANY, { periodEnd: new Date(END) }, CTX)).rejects.toMatchObject({
      response: { code: 'period_ends_before_trial_end' },
    });
    expect(w.eligibility).toEqual(open());

    const end = new Date(END.getTime() + 10 * DAY);
    await w.service.setPeriodEnd(COMPANY, { periodEnd: end }, CTX);
    expect(w.starts).toEqual([END]);
    expect(w.periods).toEqual([end]);
    expect(w.eligibility).toEqual({ closedAt: NOW, closedReason: 'paid_period' });
  });

  it('refusing and cancelling close the eligibility; suspending and reinstating close nothing', async () => {
    const refused = makeWorld('pending_activation', {}, [], { eligibility: open(), now: NOW });
    await refused.service.reject(COMPANY, { reason: 'Duplicate of an existing shop' }, CTX);
    expect(refused.eligibility).toEqual({ closedAt: NOW, closedReason: 'refused' });

    const cancelled = makeWorld('pending_activation', {}, [], { eligibility: open(), now: NOW });
    await cancelled.service.cancel(COMPANY, { reason: 'Asked to stop' }, CTX);
    expect(cancelled.eligibility).toEqual({ closedAt: NOW, closedReason: 'cancelled' });

    const paused = makeWorld('pending_activation', {}, [], { eligibility: open(), claim: running, now: NOW });
    await paused.service.suspend(COMPANY, { reason: 'Checking the documents' }, CTX);
    await paused.service.reinstate(COMPANY, {}, CTX);
    expect(paused.eligibility).toEqual(open());
    expect(paused.steps).not.toContain('eligibility');
    // Reinstated mid-trial: the same trial resumes, to the same end.
    const record = { ...paused.sub, trial: trialFactsOf(paused.eligibility, paused.claim) } as never;
    expect(stateOf(record, new Date(END.getTime() - 1))).toBe('trial_active');
    expect(stateOf(record, END)).toBe('trial_expired');
  });

  it('a closed eligibility stays closed: a refused business approved later gets no second reason, and never a trial', async () => {
    const w = makeWorld('pending_activation', {}, [], { eligibility: open(), now: NOW });
    await w.service.reject(COMPANY, { reason: 'Incomplete' }, CTX);
    await w.service.approve(COMPANY, { months: 1 }, CTX);
    expect(w.eligibility).toEqual({ closedAt: NOW, closedReason: 'refused' });
  });

  it('no claim can start after the fence: the business is no longer trial_available once the decision is made', async () => {
    const w = makeWorld('pending_activation', {}, [], { eligibility: open(), now: NOW });
    expect(stateOf({ ...w.sub, trial: trialFactsOf(w.eligibility, null) } as never, NOW)).toBe('trial_available');
    await w.service.cancel(COMPANY, { reason: 'Asked to stop' }, CTX);
    // The claim re-checks the eligibility under the same lock; closed, it finds nothing to claim.
    expect(trialFactsOf(w.eligibility, null).eligible).toBe(false);
    expect(w.steps.indexOf('lock')).toBeLessThan(w.steps.indexOf('eligibility'));
  });

  it('an approval racing a claim: whichever holds the lock first decides — the claim that won defers the paid start', async () => {
    // The claim committed first: the fence reads it under the lock and paid access waits for its end.
    const claimFirst = makeWorld('pending_activation', {}, [], { eligibility: open(), claim: running, now: NOW });
    await claimFirst.service.approve(COMPANY, { months: 1 }, CTX);
    expect(claimFirst.starts).toEqual([END]);

    // The approval committed first: the eligibility is closed, so the claim that follows has nothing to claim.
    const approvalFirst = makeWorld('pending_activation', {}, [], { eligibility: open(), now: NOW });
    await approvalFirst.service.approve(COMPANY, { months: 1 }, CTX);
    expect(approvalFirst.starts).toEqual([NOW]);
    expect(trialFactsOf(approvalFirst.eligibility, null).eligible).toBe(false);
  });

  it('an action prepared before a claim — the claim bumped the version — is refused, and changes nothing', async () => {
    // Version 3 when the page loaded; the claim made it 4.
    const w = makeWorld('pending_activation', { version: 4 }, [], { eligibility: open(), claim: running, now: NOW });
    for (const attempt of [
      () => w.service.approve(COMPANY, { months: 1, expectedVersion: 3 }, CTX),
      () => w.service.activateByGrant(COMPANY, { days: 30, reason: 'Pilot', expectedVersion: 3 }, CTX),
      () => w.service.extend(COMPANY, { months: 1, expectedVersion: 3 }, CTX),
      () => w.service.reject(COMPANY, { reason: 'x', expectedVersion: 3 }, CTX),
      () => w.service.cancel(COMPANY, { reason: 'x', expectedVersion: 3 }, CTX),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ constructor: ConflictException, response: { code: 'subscription_changed' } });
    }
    expect(w.eligibility).toEqual(open());
    expect(w.sub).toMatchObject({ status: 'pending_activation', version: 4, currentPeriodEnd: null });
    expect(w.events).toEqual([]);
    expect(w.periods).toEqual([]);
  });
});

describe('what the lifecycle never does', () => {
  it('deletes nothing — every ending is a status and an event', () => {
    expect(SERVICE).not.toMatch(/\.delete(Many)?\(/);
  });

  it('never writes a trial claim, and reads no clock but the injected one (0095)', () => {
    expect(SERVICE).not.toMatch(/trialClaim\.(create|update|upsert|delete)/);
    expect(SERVICE).not.toMatch(/new Date\(\)|Date\.now\(|systemClock/);
  });

  it('stores no grace: it is derived from the period end, so a corrected period carries its grace', () => {
    expect(SERVICE).not.toMatch(/grace(End|Until|Hours)?\s*:/i);
  });
});
