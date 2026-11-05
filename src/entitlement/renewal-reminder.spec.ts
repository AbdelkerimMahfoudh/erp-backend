import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { reminderDaysLeft, reminderDedupeKey, renewableEnd } from './renewal-reminder';
import { RENEWAL_REMINDER_TYPE, RenewalReminderService } from './renewal-reminder.service';

/*
 * The in-app 3/2/1-day renewal reminder (owner's brief, 2026-11-05): the Owner only; the server computes the days; at
 * most once per business, Owner and milestone on every device; nothing while renewed, while a proof waits for review,
 * in grace or after expiry.
 */
const HOUR = 3_600_000;
const END = new Date('2026-11-20T10:00:00.000Z');
const at = (hoursBefore: number) => new Date(END.getTime() - hoursBefore * HOUR);

describe('the days left, computed by the server', () => {
  it('3, 2 and 1 at the WhatsApp message’s milestones; nothing before 72 hours, at the end or after it', () => {
    expect([80, 72, 60, 48.5, 48, 30, 24, 1, 0.01].map((h) => reminderDaysLeft(END, at(h)))).toEqual([null, 3, 3, 3, 2, 2, 1, 1, 1]);
    expect(reminderDaysLeft(END, END)).toBeNull();
    expect(reminderDaysLeft(END, at(-1))).toBeNull();
  });
});

describe('what may be renewed', () => {
  const trial = (accessAfterTrial: unknown = null) => ({ status: 'active', endsAt: END.toISOString(), accessAfterTrial }) as never;
  it('a running trial with nothing paid to follow it, and a paid period', () => {
    expect(renewableEnd({ state: 'trial_active', isComplimentary: false, periodEnd: null, trial: trial() })).toEqual({ kind: 'trial', end: END });
    expect(renewableEnd({ state: 'active', isComplimentary: false, periodEnd: END.toISOString(), trial: null })).toEqual({ kind: 'paid', end: END });
  });
  it('not a trial already renewed, a grant, grace, expiry, suspension, a pending business or a refused one', () => {
    expect(renewableEnd({ state: 'trial_active', isComplimentary: false, periodEnd: null, trial: trial({ kind: 'paid' }) })).toBeNull();
    for (const state of ['complimentary', 'grace', 'expired', 'trial_expired', 'suspended', 'cancelled', 'rejected', 'pending', 'trial_available'] as const) {
      expect(renewableEnd({ state, isComplimentary: state === 'complimentary', periodEnd: END.toISOString(), trial: null })).toBeNull();
    }
    expect(renewableEnd({ state: 'active', isComplimentary: true, periodEnd: END.toISOString(), trial: null })).toBeNull();
  });
});

/** A small world: one business, its Owners and staff, its notifications and reads. */
function world(opts: { now: Date; state?: string; periodEnd?: Date | null; pendingProofs?: number }) {
  const company = Buffer.alloc(16, 1);
  const owner1 = Buffer.alloc(16, 2);
  const owner2 = Buffer.alloc(16, 3);
  const manager = Buffer.alloc(16, 4);
  const owners = new Set([owner1.toString('hex'), owner2.toString('hex')]);
  const notifications: { id: Buffer; companyId: Buffer; targetUserId: Buffer; dedupeKey: string; type: string; payload: unknown; actionLink: string | null }[] = [];
  const reads: { notificationId: Buffer; userId: Buffer }[] = [];
  let user: Buffer = owner1;
  let seq = 0;
  const key = (n: { companyId: Buffer; targetUserId: Buffer; dedupeKey: string }) => `${n.companyId.toString('hex')}|${n.targetUserId.toString('hex')}|${n.dedupeKey}`;
  const prisma = {
    userBranch: { count: async ({ where }: { where: { userId: Buffer } }) => (owners.has(where.userId.toString('hex')) ? 1 : 0) },
    paymentProof: { count: async () => opts.pendingProofs ?? 0 },
    notification: {
      findFirst: async ({ where }: { where: { companyId: Buffer; targetUserId: Buffer; dedupeKey: string } }) => notifications.find((n) => key(n) === key(where)) ?? null,
      findFirstOrThrow: async ({ where }: { where: { companyId: Buffer; targetUserId: Buffer; dedupeKey: string } }) => notifications.find((n) => key(n) === key(where))!,
      create: async ({ data }: { data: (typeof notifications)[number] }) => {
        if (notifications.some((n) => key(n) === key(data))) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        notifications.push({ ...data, id: Buffer.alloc(16, 100 + seq++) });
        return { id: notifications[notifications.length - 1].id };
      },
    },
    notificationRead: {
      count: async ({ where }: { where: { notificationId: Buffer; userId: Buffer } }) =>
        reads.filter((r) => r.notificationId.equals(where.notificationId) && r.userId.equals(where.userId)).length,
    },
  };
  const tenant = { companyId: () => company, requireUserId: () => user };
  const entitlement = {
    forCompany: async () => ({
      state: opts.state ?? 'active',
      isComplimentary: false,
      periodEnd: opts.periodEnd === undefined ? END.toISOString() : opts.periodEnd?.toISOString() ?? null,
      trial: null,
      timeZone: 'Africa/Nouakchott',
    }),
  };
  const config = { portalSubscriptionUrl: 'https://dukan.tsxmr.com/subscription' };
  const clock = { now: () => opts.now };
  const service = new RenewalReminderService(prisma as never, tenant as never, entitlement as never, config as never, clock as never);
  return {
    service, notifications, owner1, owner2, manager,
    as(u: Buffer) { user = u; return this; },
    read(id: string, u: Buffer) { reads.push({ notificationId: notifications.find((n) => n.id.toString('hex') === id.replace(/-/g, ''))!.id, userId: u }); },
  };
}

describe('the Owner’s reminder', () => {
  it('3, 2 and 1 days before a paid end: the days, the end, the zone and the portal’s subscription page', async () => {
    for (const [hours, days] of [[70, 3], [40, 2], [5, 1]] as const) {
      const w = world({ now: at(hours) });
      const { reminder } = await w.service.current();
      expect(reminder).toMatchObject({ kind: 'paid', days, endsAt: END.toISOString(), timeZone: 'Africa/Nouakchott', link: 'https://dukan.tsxmr.com/subscription', seen: false });
      expect(w.notifications).toHaveLength(1);
      expect(w.notifications[0]).toMatchObject({ type: RENEWAL_REMINDER_TYPE, payload: { kind: 'paid', days, endsAt: END.toISOString() }, actionLink: 'https://dukan.tsxmr.com/subscription' });
    }
  });

  it('nothing more than 3 days before the end, once renewed, in grace or after expiry', async () => {
    expect((await world({ now: at(100) }).service.current()).reminder).toBeNull();
    expect((await world({ now: at(10), periodEnd: new Date(END.getTime() + 30 * 24 * HOUR) }).service.current()).reminder).toBeNull();
    for (const state of ['grace', 'expired']) expect((await world({ now: at(10), state }).service.current()).reminder).toBeNull();
  });

  it('nothing while a payment proof waits for review: the Owner has acted', async () => {
    expect((await world({ now: at(10), pendingProofs: 1 }).service.current()).reminder).toBeNull();
  });

  it('once per milestone on every device: a second device gets the same reminder, and seen once it was shown on one', async () => {
    const w = world({ now: at(10) });
    const first = (await w.service.current()).reminder!;
    const second = (await w.service.current()).reminder!;
    expect(second.id).toBe(first.id);
    expect(w.notifications).toHaveLength(1);
    w.read(first.id, w.owner1);
    expect((await w.service.current()).reminder!.seen).toBe(true);
  });

  it('two devices asking at the same instant still make one reminder', async () => {
    const w = world({ now: at(10) });
    const [a, b] = await Promise.all([w.service.current(), w.service.current()]);
    expect(a.reminder!.id).toBe(b.reminder!.id);
    expect(w.notifications).toHaveLength(1);
  });

  it('a new milestone is a new reminder, even after the last one was seen', async () => {
    const w = world({ now: at(60) });
    const three = (await w.service.current()).reminder!;
    w.read(three.id, w.owner1);
    const w2 = world({ now: at(30) });
    expect((await w2.service.current()).reminder).toMatchObject({ days: 2, seen: false });
    expect(reminderDedupeKey('a', 'b', END, 3)).not.toBe(reminderDedupeKey('a', 'b', END, 2));
  });

  it('each Owner has their own: one Owner seeing it does not hide it from the other', async () => {
    const w = world({ now: at(10) });
    const mine = (await w.as(w.owner1).service.current()).reminder!;
    w.read(mine.id, w.owner1);
    const theirs = (await w.as(w.owner2).service.current()).reminder!;
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.seen).toBe(false);
  });

  it('a Manager or an Employee is refused: only the Owner renews', async () => {
    const w = world({ now: at(10) });
    await expect(w.as(w.manager).service.current()).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.notifications).toHaveLength(0);
  });
});
