import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EntitlementService } from './entitlement.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The free trial's end, as the entitlement check sees it (0095; R1-F2, D176).
 *
 * Access stops at the exact end because the state is computed from the stored instants; this is the RECORD that it
 * did — the claim marked, a `trial_expired` event and a platform audit — written once, by the first evaluation at or
 * after the end, all three or none, and never at the cost of the request that happened to notice: the row is taken
 * with NOWAIT, a held row is left for a later evaluation, one attempt runs per company, and a failure backs off.
 */

const COMPANY = newUuidV7Bin();
const HOUR = 60 * 60 * 1000;
const START = new Date('2026-10-13T10:00:00.123Z');
const END = new Date(START.getTime() + 168 * HOUR);

interface WorldOptions {
  timezone?: string;
  /** The first N reads see the claim as it was before any mark: two requests that loaded it together. */
  staleReads?: number;
  /** The event insert fails this many times (a lost connection). */
  failEvents?: number;
  trial?: boolean;
  noSubscription?: boolean;
  /** A request paid for during the trial still scheduled, waiting for paid access (none is in force here). */
  scheduled?: boolean;
  /** Share another world's rows: a second API instance, its own process, the same database. */
  shared?: ReturnType<typeof makeWorld>;
}

function makeWorld(now: { t: Date }, opts: WorldOptions = {}): {
  service: EntitlementService;
  claim: { id: Buffer; claimedAt: Date; startedAt: Date; endsAt: Date; expiryRecordedAt: Date | null };
  sub: Record<string, any>;
  events: Record<string, any>[];
  audits: Record<string, any>[];
  order: string[];
  queries: string[];
  lock: { held: boolean; stall: Promise<void> | null };
} {
  const claim = opts.shared?.claim ?? { id: newUuidV7Bin(), claimedAt: START, startedAt: START, endsAt: END, expiryRecordedAt: null as Date | null };
  const sub = {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    status: 'pending_activation',
    currentPeriodEnd: null,
    isComplimentary: false,
    complimentaryUntil: null,
    subscribedBranchCount: 1,
    additionalSeats: 0,
  };
  const withTrial = opts.trial ?? true;
  const events: Record<string, any>[] = opts.shared?.events ?? [];
  const audits: Record<string, any>[] = opts.shared?.audits ?? [];
  const order: string[] = opts.shared?.order ?? [];
  /** Every read this world answered, by kind: what an evaluation costs. */
  const queries: string[] = [];
  /** Another connection holds the row (NOWAIT fails at once), or the lock statement takes its time (`stall`). */
  const lock: { held: boolean; stall: Promise<void> | null } = opts.shared?.lock ?? { held: false, stall: null };
  let staleReads = opts.staleReads ?? 0;
  let failEvents = opts.failEvents ?? 0;

  const prisma: Record<string, any> = {
    subscription: {
      // The renewal check reads the row too (a `select`); only the evaluation's read (an `include`) loads the claim.
      findFirst: async (args: { include?: unknown }) => {
        queries.push('subscription');
        if (opts.noSubscription) return null;
        const stale = !!args.include && staleReads > 0;
        if (stale) staleReads -= 1;
        const seen = stale ? { ...claim, expiryRecordedAt: null } : { ...claim };
        return {
          ...sub,
          company: {
            name: 'Shop',
            timezone: opts.timezone ?? 'Africa/Nouakchott',
            trialEligibility: withTrial ? { closedAt: null } : null,
            trialClaim: withTrial ? seen : null,
          },
        };
      },
    },
    // Never billed: no renewal is due, no paid period is in force, and the census finds nobody.
    billingPeriod: { findFirst: async () => null },
    branch: { findMany: async () => [] },
    company: { findUnique: async () => ({ name: 'Shop', closedAt: null }) },
    subscriptionPayment: {},
    // A request paid for during the trial, when the world has one: due since the trial's end, waiting for paid access.
    seatAllocation: {
      findFirst: async () => {
        queries.push('scheduled?');
        return opts.scheduled ? { id: Buffer.alloc(16, 5) } : null;
      },
    },
    trialClaim: {
      updateMany: async ({ where, data }: any) => {
        order.push('mark');
        if (!claim.id.equals(where.id) || claim.expiryRecordedAt !== where.expiryRecordedAt) return { count: 0 };
        claim.expiryRecordedAt = data.expiryRecordedAt;
        return { count: 1 };
      },
    },
    subscriptionEvent: {
      create: async ({ data }: any) => {
        order.push('event');
        if (failEvents > 0) {
          failEvents -= 1;
          throw new Error('connection lost');
        }
        events.push(data);
      },
    },
    platformAuditEvent: {
      create: async ({ data }: any) => {
        order.push('audit');
        audits.push(data);
      },
    },
    $queryRaw: async (q: { strings?: readonly string[] }) => {
      const text = (q.strings ?? []).join('?');
      if (/FOR UPDATE NOWAIT/.test(text)) {
        order.push('lock nowait');
        if (lock.stall) await lock.stall;
        // What Prisma gives on MySQL when another connection holds the row (3572), at once.
        if (lock.held) {
          throw new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `3572`.', { code: 'P2010', clientVersion: 'test', meta: { code: '3572' } });
        }
      } else if (/FOR UPDATE/.test(text)) {
        order.push('lock');
      }
      return [];
    },
  };
  // All or nothing, as MySQL would: a throw leaves the claim, the events and the audit as they were.
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const saved = { mark: claim.expiryRecordedAt, events: events.length, audits: audits.length };
    try {
      return await fn(prisma);
    } catch (e) {
      claim.expiryRecordedAt = saved.mark;
      events.length = saved.events;
      audits.length = saved.audits;
      throw e;
    }
  };
  const service = new EntitlementService(prisma as never, { companyId: () => COMPANY } as never, { now: () => now.t });
  return { service, claim, sub, events, audits, order, queries, lock };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the end of a free trial, written down once', () => {
  it('until its last millisecond the trial writes, and nothing is recorded — not even a lock', async () => {
    const w = makeWorld({ t: new Date(END.getTime() - 1) });
    await expect(w.service.writeRefusal(COMPANY)).resolves.toBeNull();
    expect(w.order).toEqual([]);
    expect(w.claim.expiryRecordedAt).toBeNull();
  });

  it('at the exact end: read-only, and the claim, the event and the audit are written together, under the subscription lock', async () => {
    const w = makeWorld({ t: END });
    await expect(w.service.writeRefusal(COMPANY)).resolves.toEqual({
      code: 'ENTITLEMENT_WRITE_BLOCKED',
      message: 'The free trial has ended. You can still read and export everything.',
      state: 'trial_expired',
    });
    // Subscription first — never waited for — audit last: the order every writer here keeps.
    expect(w.order).toEqual(['lock nowait', 'mark', 'event', 'audit']);
    // Every instant from the server clock: the evaluation's own.
    expect(w.claim.expiryRecordedAt).toEqual(END);
    expect(w.events).toEqual([
      expect.objectContaining({
        companyId: COMPANY,
        subscriptionId: w.sub.id,
        kind: 'trial_expired',
        // No instant in the note (C7): the end is the claim's, kept as data in the audit below.
        note: 'The 7-day free trial ended. Nothing was charged.',
        actor: 'system',
        createdAt: END,
      }),
    ]);
    expect(w.audits).toEqual([
      expect.objectContaining({
        adminId: null,
        actor: 'system',
        action: 'trial.expired',
        targetType: 'Company',
        targetId: COMPANY,
        targetLabel: 'Shop',
        afterJson: { endsAt: '2026-10-20T10:00:00.123Z' },
        createdAt: END,
      }),
    ]);
  });

  it('never twice: once recorded, with nothing scheduled, the business is settled — a later evaluation asks nothing more', async () => {
    const now = { t: new Date(END.getTime() + HOUR) };
    const w = makeWorld(now);
    await w.service.writeRefusal(COMPANY);
    expect(w.order).toEqual(['lock nowait', 'mark', 'event', 'audit']);
    const asked = w.queries.length;
    now.t = new Date(END.getTime() + 24 * HOUR);
    await w.service.writeRefusal(COMPANY);
    await w.service.current();
    // Two evaluations: the row read (and the renewal check's), and nothing else — no lock, no "anything due?".
    expect(w.queries.slice(asked).filter((q) => q !== 'subscription')).toEqual([]);
    expect(w.order).toEqual(['lock nowait', 'mark', 'event', 'audit']);
    expect(w.events).toHaveLength(1);
    expect(w.audits).toHaveLength(1);
    expect(w.claim.expiryRecordedAt).toEqual(new Date(END.getTime() + HOUR));
  });

  it('two API instances that loaded the claim together record once: the conditional mark refuses the second', async () => {
    const now = { t: new Date(END.getTime() + HOUR) };
    const first = makeWorld(now);
    const second = makeWorld(now, { shared: first, staleReads: 1 });
    await first.service.writeRefusal(COMPANY);
    await second.service.writeRefusal(COMPANY);
    // The second saw no mark, tried under the lock, and the update matched nothing: no event, no audit.
    expect(first.order).toEqual(['lock nowait', 'mark', 'event', 'audit', 'lock nowait', 'mark']);
    expect(first.events).toHaveLength(1);
    expect(first.audits).toHaveLength(1);
  });

  it('a failure never fails the request and leaves nothing half-written; it is retried after a back-off, then recorded once', async () => {
    const now = { t: END };
    const w = makeWorld(now, { failEvents: 2 });
    await expect(w.service.writeRefusal(COMPANY)).resolves.toMatchObject({ state: 'trial_expired' });
    expect(w.claim.expiryRecordedAt).toBeNull();
    expect(w.events).toEqual([]);
    expect(w.audits).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Free trial expiry record failed for company .*: connection lost$/));

    // Within the back-off nothing is attempted: the request is answered from the row alone.
    now.t = new Date(END.getTime() + 999);
    const locks = w.order.filter((o) => o === 'lock nowait').length;
    await expect(w.service.writeRefusal(COMPANY)).resolves.toMatchObject({ state: 'trial_expired' });
    expect(w.order.filter((o) => o === 'lock nowait')).toHaveLength(locks);

    // A second failure doubles the wait: one second, then two.
    now.t = new Date(END.getTime() + 1_000);
    await w.service.writeRefusal(COMPANY);
    expect(w.events).toEqual([]);
    now.t = new Date(END.getTime() + 2_999);
    await w.service.writeRefusal(COMPANY);
    expect(w.order.filter((o) => o === 'lock nowait')).toHaveLength(locks + 1);

    now.t = new Date(END.getTime() + 3_000);
    await expect(w.service.writeRefusal(COMPANY)).resolves.toMatchObject({ state: 'trial_expired' });
    expect(w.events).toHaveLength(1);
    expect(w.audits).toHaveLength(1);
    expect(w.claim.expiryRecordedAt).toEqual(new Date(END.getTime() + 3_000));
  });

  it('the audit holds the end and nothing else: no contact, no token, no code', async () => {
    const w = makeWorld({ t: END });
    await w.service.writeRefusal(COMPANY);
    const written = JSON.stringify([w.audits[0].afterJson, w.events[0].note]);
    expect(written).not.toMatch(/@|\+222|token|code/i);
  });
});

describe('never waiting on the subscription row (R1-F2)', () => {
  it('another writer holds the row: every evaluation returns at once, read-only — and after the back-off one records it, once', async () => {
    const now = { t: new Date(END.getTime() + 60_000) };
    const w = makeWorld(now);
    w.lock.held = true;
    const answers = await Promise.all(Array.from({ length: 12 }, () => w.service.writeRefusal(COMPANY)));
    expect(answers.every((a) => a?.state === 'trial_expired')).toBe(true);
    // One attempt for the twelve: it found the row busy and left; the others skipped it.
    expect(w.order).toEqual(['lock nowait']);
    expect(w.events).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    // Released; within the second's back-off nothing is tried, after it one evaluation records it.
    w.lock.held = false;
    now.t = new Date(now.t.getTime() + 500);
    await w.service.writeRefusal(COMPANY);
    expect(w.order).toEqual(['lock nowait']);
    now.t = new Date(now.t.getTime() + 500);
    await Promise.all(Array.from({ length: 12 }, () => w.service.writeRefusal(COMPANY)));
    expect(w.order).toEqual(['lock nowait', 'lock nowait', 'mark', 'event', 'audit']);
    expect(w.events).toHaveLength(1);
    expect(w.audits).toHaveLength(1);
  });

  it('one attempt in flight per company: concurrent evaluations skip it rather than wait for it', async () => {
    const now = { t: END };
    const w = makeWorld(now);
    let go!: () => void;
    w.lock.stall = new Promise<void>((r) => (go = r));
    const first = w.service.writeRefusal(COMPANY);
    // Let the first reach its lock statement.
    await new Promise((r) => setImmediate(r));
    const others = await Promise.all(Array.from({ length: 11 }, () => w.service.writeRefusal(COMPANY)));
    expect(others.every((a) => a?.state === 'trial_expired')).toBe(true);
    expect(w.order).toEqual(['lock nowait']);
    w.lock.stall = null;
    go();
    await first;
    expect(w.order).toEqual(['lock nowait', 'mark', 'event', 'audit']);
    expect(w.events).toHaveLength(1);
  });

  it('a request paid for during the trial and waiting for paid access is asked about at most once a minute', async () => {
    const now = { t: new Date(END.getTime() + HOUR) };
    const w = makeWorld(now, { scheduled: true });
    await w.service.writeRefusal(COMPANY);
    expect(w.queries.filter((q) => q === 'scheduled?')).toHaveLength(1);
    now.t = new Date(now.t.getTime() + 59_999);
    await w.service.writeRefusal(COMPANY);
    expect(w.queries.filter((q) => q === 'scheduled?')).toHaveLength(1);
    now.t = new Date(now.t.getTime() + 1);
    await w.service.writeRefusal(COMPANY);
    expect(w.queries.filter((q) => q === 'scheduled?')).toHaveLength(2);
    // Never settled while something waits: the record is written once, the question keeps being asked.
    expect(w.events).toHaveLength(1);
  });
});

describe('the trial as the entitlement tells it', () => {
  it('its instants in UTC, as stored, and the business’s own zone beside them', async () => {
    const w = makeWorld({ t: new Date(END.getTime() - 1) });
    const e = await w.service.current();
    expect(e.state).toBe('trial_active');
    expect(e.trial).toEqual({
      status: 'active',
      durationHours: 168,
      durationDays: 7,
      claimedAt: '2026-10-13T10:00:00.123Z',
      startedAt: '2026-10-13T10:00:00.123Z',
      endsAt: '2026-10-20T10:00:00.123Z',
      timeZone: 'Africa/Nouakchott',
    });
  });

  it('a zone the business configured is used whatever it is — nothing assumes Mauritania', async () => {
    const e = await makeWorld({ t: START }, { timezone: 'Europe/Paris' }).service.current();
    expect(e.trial?.timeZone).toBe('Europe/Paris');
  });

  it('an invalid stored zone is shown as UTC and reported once per company — never replaced by a guessed zone', async () => {
    const w = makeWorld({ t: START }, { timezone: 'Mars/Olympus_Mons' });
    expect((await w.service.current()).trial?.timeZone).toBe('UTC');
    expect((await w.service.current()).trial?.timeZone).toBe('UTC');
    const zoneWarnings = warn.mock.calls.filter(([m]) => /unknown time zone/.test(String(m)));
    expect(zoneWarnings).toEqual([[expect.stringContaining('unknown time zone "Mars/Olympus_Mons"; its trial dates are shown in UTC')]]);
  });

  it('a business with no trial shows none, and its zone is not even checked', async () => {
    const w = makeWorld({ t: START }, { trial: false, timezone: 'Mars/Olympus_Mons' });
    const e = await w.service.current();
    expect(e.state).toBe('pending');
    expect(e.trial).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a company with no subscription row has no trial, and reads as before', async () => {
    const e = await makeWorld({ t: START }, { noSubscription: true }).service.current();
    expect(e).toMatchObject({ state: 'expired', trial: null, canRead: true, canWrite: false });
  });
});
