import { Logger } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The free trial's end, as the entitlement check sees it (0095).
 *
 * Access stops at the exact end because the state is computed from the stored instants; this is the RECORD that it
 * did — the claim marked, a `trial_expired` event and a platform audit — written once, by the first evaluation at or
 * after the end, all three or none, and never at the cost of the request that happened to notice.
 */

const COMPANY = newUuidV7Bin();
const HOUR = 60 * 60 * 1000;
const START = new Date('2026-10-13T10:00:00.123Z');
const END = new Date(START.getTime() + 168 * HOUR);

interface WorldOptions {
  timezone?: string;
  /** The first N reads see the claim as it was before any mark: two requests that loaded it together. */
  staleReads?: number;
  failEventOnce?: boolean;
  trial?: boolean;
  noSubscription?: boolean;
}

function makeWorld(now: { t: Date }, opts: WorldOptions = {}) {
  const claim = { id: newUuidV7Bin(), claimedAt: START, startedAt: START, endsAt: END, expiryRecordedAt: null as Date | null };
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
  const events: Record<string, any>[] = [];
  const audits: Record<string, any>[] = [];
  const order: string[] = [];
  let staleReads = opts.staleReads ?? 0;
  let failEvent = opts.failEventOnce ?? false;

  const prisma: Record<string, any> = {
    subscription: {
      // The renewal check reads the row too (a `select`); only the evaluation's read (an `include`) loads the claim.
      findFirst: async (args: { include?: unknown }) => {
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
    // Never billed: no renewal is due, and the census finds nobody.
    billingPeriod: { findFirst: async () => null },
    branch: { findMany: async () => [] },
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
        if (failEvent) {
          failEvent = false;
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
      if (/FOR UPDATE/.test((q.strings ?? []).join('?'))) order.push('lock');
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
  return { service, claim, sub, events, audits, order };
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
    // Subscription first, audit last — the order every writer here keeps.
    expect(w.order).toEqual(['lock', 'mark', 'event', 'audit']);
    // Every instant from the server clock: the evaluation's own.
    expect(w.claim.expiryRecordedAt).toEqual(END);
    expect(w.events).toEqual([
      expect.objectContaining({
        companyId: COMPANY,
        subscriptionId: w.sub.id,
        kind: 'trial_expired',
        note: 'The 7-day free trial ended at 2026-10-20T10:00:00.123Z. Nothing was charged.',
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

  it('never twice: a later evaluation reads the mark and does nothing, and two that loaded the claim together record once', async () => {
    const now = { t: new Date(END.getTime() + HOUR) };
    const w = makeWorld(now, { staleReads: 2 });
    await w.service.writeRefusal(COMPANY);
    await w.service.writeRefusal(COMPANY);
    // The second evaluation saw no mark, tried, and the conditional update refused it: no event, no audit.
    expect(w.order).toEqual(['lock', 'mark', 'event', 'audit', 'lock', 'mark']);
    now.t = new Date(END.getTime() + 24 * HOUR);
    await w.service.writeRefusal(COMPANY);
    await w.service.current();
    expect(w.events).toHaveLength(1);
    expect(w.audits).toHaveLength(1);
    expect(w.claim.expiryRecordedAt).toEqual(new Date(END.getTime() + HOUR));
  });

  it('a failure never fails the request, leaves nothing half-written, and the next evaluation records it — once', async () => {
    const w = makeWorld({ t: END }, { failEventOnce: true });
    await expect(w.service.writeRefusal(COMPANY)).resolves.toMatchObject({ state: 'trial_expired' });
    expect(w.claim.expiryRecordedAt).toBeNull();
    expect(w.events).toEqual([]);
    expect(w.audits).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Free trial expiry record failed for company .*: connection lost$/));

    await expect(w.service.writeRefusal(COMPANY)).resolves.toMatchObject({ state: 'trial_expired' });
    expect(w.events).toHaveLength(1);
    expect(w.audits).toHaveLength(1);
  });

  it('the audit holds the end and nothing else: no contact, no token, no code', async () => {
    const w = makeWorld({ t: END });
    await w.service.writeRefusal(COMPANY);
    const written = JSON.stringify([w.audits[0].afterJson, w.events[0].note]);
    expect(written).not.toMatch(/@|\+222|token|code/i);
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
