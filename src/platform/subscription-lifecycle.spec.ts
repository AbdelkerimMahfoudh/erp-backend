import { readFileSync } from 'node:fs';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * Approval, refusal and a corrected period (0075), against a subscription
 * that behaves like the row — including the optimistic `version` check that
 * turns two administrators into one winner and one refusal.
 */

const COMPANY = '018f0000-0000-7000-8000-00000000c001';
const ADMIN = { id: newUuidV7Bin(), email: 'ops@example.test', name: 'Ops' };
const CTX = { admin: ADMIN, ip: '127.0.0.1' };
const DAY = 24 * 60 * 60 * 1000;
const SERVICE = readFileSync('src/platform/subscription-lifecycle.service.ts', 'utf8');

type Status = 'pending_activation' | 'activated' | 'suspended' | 'cancelled' | 'rejected';

function makeWorld(status: Status, over: Record<string, unknown> = {}) {
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

  const prisma = {
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
    },
  };
  const service = new SubscriptionLifecycleService(prisma as never, audit as never, billing as never);
  return { service, sub, events, audits, periods };
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

    expect(events.map((e) => e.kind)).toEqual(['approved']);
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

describe('what the lifecycle never does', () => {
  it('deletes nothing — every ending is a status and an event', () => {
    expect(SERVICE).not.toMatch(/\.delete(Many)?\(/);
  });

  it('stores no grace: it is derived from the period end, so a corrected period carries its grace', () => {
    expect(SERVICE).not.toMatch(/grace(End|Until|Hours)?\s*:/i);
  });
});
