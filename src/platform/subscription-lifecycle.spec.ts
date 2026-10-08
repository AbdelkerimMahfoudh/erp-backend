import { readFileSync } from 'node:fs';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * Approval, refusal and a corrected period (0075), against a subscription
 * that behaves like the row — including the optimistic `version` check that
 * turns two administrators into one winner and one refusal.
 *
 * And the renewal (D154 a, 2026-10-08): whenever the period end moves forward,
 * the downgrades scheduled for it are applied, the billing period is closed
 * and the next one opened at the new size — so the event lists below carry a
 * `renewed` entry after every approval, extension and lengthening.
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

function makeWorld(status: Status, over: Record<string, unknown> = {}, branches: BranchRow[] = []) {
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
  /** What happened in which order: a renewal must apply downgrades, close, then open. */
  const order: string[] = [];
  const allocations: any[] = [];
  // A running business has a period to close; a pending one has nothing yet.
  let hasPeriod = status === 'activated';

  const prisma = {
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
  };
  const audit = {
    record: async (e: unknown) => {
      audits.push(e);
    },
  };
  const billing = {
    openPeriod: async (_c: Buffer, _s: Buffer, end: Date | null) => {
      periods.push(end);
      order.push('open');
      hasPeriod = true;
    },
    closeCurrentPeriod: async (_c: Buffer, at: Date) => {
      closes.push(at);
      order.push('close');
      const had = hasPeriod;
      return had;
    },
  };
  const service = new SubscriptionLifecycleService(prisma as never, audit as never, billing as never);
  return { service, sub, events, audits, periods, closes, order, branches, allocations };
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
    expect(audits[1]).toMatchObject({ after: { direction: 'lengthened' } });
    // Lengthening renews (D154 a); shortening is a correction and does not — hence one `renewed`, after the second.
    expect(events.map((e) => e.kind)).toEqual(['period_corrected', 'period_corrected', 'renewed']);
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

  it('extending applies the downgrade scheduled for it, closes the period and opens the next — in that order', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: in30() }, [scheduledDowngrade()]);
    w.allocations.push(scheduledRow());
    const before = Date.now();
    const r = await w.service.extend(COMPANY, { months: 1, reason: 'Paid for October' }, CTX);
    expect(r.applied).toBe(true);

    // The branch takes what it asked for, and the request that scheduled it is marked applied.
    expect(w.branches[0]).toMatchObject({ activity: 'money_agent', activityNext: null });
    expect(w.branches[0].activityChangedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(w.allocations[0]).toMatchObject({ status: 'granted', confirmedBy: ADMIN.email, reason: 'Applied at the renewal.', version: 1 });
    expect(w.allocations[0].confirmedAt).toBeInstanceOf(Date);

    // Downgrades first, then the close, then the new period — so the new period is sized after the change.
    expect(w.order).toEqual(['branch.update:Main', 'close', 'open']);
    expect(w.closes).toHaveLength(1);
    expect(w.closes[0].getTime()).toBeGreaterThanOrEqual(before);
    expect(w.periods).toEqual([w.sub.currentPeriodEnd]);

    expect(w.events.map((e) => e.kind)).toEqual(['extended', 'activity_changed', 'renewed']);
    expect(w.events[1].note).toMatch(/Main.*both → money_agent/);
    expect(w.events[2].note).toMatch(/Renewed/);
    expect(w.audits[0]).toMatchObject({
      action: 'subscription.extend',
      after: { renewal: { closedPeriod: true, activityChanges: [{ name: 'Main', from: 'both', to: 'money_agent' }] } },
    });
  });

  it('a renewal with nothing scheduled still closes and reopens the period, and says it applied nothing', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: in30() }, [{ ...scheduledDowngrade(), activityNext: null }]);
    await w.service.extend(COMPANY, { months: 2 }, CTX);
    expect(w.order).toEqual(['close', 'open']);
    expect(w.events.map((e) => e.kind)).toEqual(['extended', 'renewed']);
    expect(w.audits[0].after.renewal).toEqual({ closedPeriod: true, activityChanges: [] });
  });

  it('shortening is a correction, never a renewal: nothing applied, nothing closed, nothing opened', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: in30() }, [scheduledDowngrade()]);
    await w.service.setPeriodEnd(COMPANY, { periodEnd: new Date(Date.now() + 10 * DAY), reason: 'Mistyped' }, CTX);
    expect(w.branches[0]).toMatchObject({ activity: 'both', activityNext: 'money_agent' });
    expect(w.order).toEqual([]);
    expect(w.events.map((e) => e.kind)).toEqual(['period_corrected']);
    expect(w.audits[0].after.renewal).toBeNull();
  });

  it('lengthening by a direct correction renews exactly as an extension does', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: in30() }, [scheduledDowngrade()]);
    const later = new Date(Date.now() + 90 * DAY);
    await w.service.setPeriodEnd(COMPANY, { periodEnd: later }, CTX);
    expect(w.branches[0]).toMatchObject({ activity: 'money_agent', activityNext: null });
    expect(w.order).toEqual(['branch.update:Main', 'close', 'open']);
    expect(w.periods).toEqual([later]);
    expect(w.events.map((e) => e.kind)).toEqual(['period_corrected', 'activity_changed', 'renewed']);
  });

  it('a lapsed shop that renews opens its new period from now, for the new end', async () => {
    const w = makeWorld('activated', { currentPeriodEnd: new Date(Date.now() - 20 * DAY) });
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

describe('what the lifecycle never does', () => {
  it('deletes nothing — every ending is a status and an event', () => {
    expect(SERVICE).not.toMatch(/\.delete(Many)?\(/);
  });

  it('stores no grace: it is derived from the period end, so a corrected period carries its grace', () => {
    expect(SERVICE).not.toMatch(/grace(End|Until|Hours)?\s*:/i);
  });
});
