import 'reflect-metadata';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { PlatformController } from './platform.controller';

/**
 * The free trial as the Super Admin's console and the Owner's account page see it (0095; docs/76).
 *
 * The dashboard and the list compute each business's state with its trial facts, by the rules the shop itself is
 * judged by — never a second reading of the dates, so a business in its trial is not counted as pending or expired.
 * The business page shows the recorded eligibility and claim, with the business's own zone, and nothing to act on:
 * no console action creates, extends or shortens a trial. The Owner's account page carries the trial with the
 * entitlement — the same view the app reads.
 */

const stub = {} as never;

const platformWith = (over: Partial<Record<string, unknown>> = {}) =>
  new PlatformController(
    (over.prisma ?? stub) as never,
    stub,
    stub,
    (over.lifecycle ?? stub) as never,
    stub,
    (over.billing ?? stub) as never,
    stub,
    (over.entitlement ?? stub) as never,
    (over.tenant ?? stub) as never,
    stub,
    stub,
    stub,
  );

describe('the console sees each business’s trial by the shop’s own rules', () => {
  const HOUR = 3600_000;
  const now = Date.now();
  const running = { claimedAt: new Date(now - HOUR), startedAt: new Date(now - HOUR), endsAt: new Date(now + 167 * HOUR) };
  const ended = { claimedAt: new Date(now - 200 * HOUR), startedAt: new Date(now - 200 * HOUR), endsAt: new Date(now - 32 * HOUR) };
  const base = {
    status: 'pending_activation',
    currentPeriodEnd: null,
    isComplimentary: false,
    complimentaryUntil: null,
    subscribedBranchCount: 1,
    additionalSeats: 0,
  };
  const facts = (eligibility: { closedAt: Date | null } | null, claim: typeof running | null) => ({ trialEligibility: eligibility, trialClaim: claim });
  const SUBS = [
    { ...base, company: facts({ closedAt: null }, null) },
    { ...base, company: facts({ closedAt: null }, running) },
    { ...base, company: facts({ closedAt: null }, ended) },
    { ...base, company: facts(null, null) },
    { ...base, status: 'activated', currentPeriodEnd: new Date(now + 30 * 24 * HOUR), company: facts({ closedAt: new Date(now - HOUR) }, null) },
  ];

  it('the dashboard counts the three trial states, never as pending or expired', async () => {
    const counts = { company: 5, branch: 5, user: 9, seatAllocation: 0 };
    const prisma = {
      subscription: { findMany: async () => SUBS },
      company: { count: async () => counts.company },
      branch: { count: async () => counts.branch },
      user: { count: async () => counts.user },
      seatAllocation: { count: async () => counts.seatAllocation },
    };
    const board = await platformWith({ prisma }).dashboard();
    expect(board.byState).toMatchObject({ trial_available: 1, trial_active: 1, trial_expired: 1, pending: 1, active: 1, expired: 0 });
  });

  it('the list gives each row its computed state, and filters on a trial state', async () => {
    const rows = SUBS.map(({ company, ...sub }, i) => ({
      id: newUuidV7Bin(),
      name: `Shop ${i}`,
      publicStoreId: `P${i}`,
      city: null,
      createdAt: new Date(now - i * HOUR),
      subscription: { ...sub, version: 1 },
      ...company,
      _count: { branches: 1, users: 1 },
    }));
    const prisma = { company: { findMany: async () => rows, count: async () => rows.length } };
    const platform = platformWith({ prisma });
    const all = await platform.businesses();
    expect(all.rows.map((r) => r.state)).toEqual(['trial_available', 'trial_active', 'trial_expired', 'pending', 'active']);
    const active = await platform.businesses(undefined, 'trial_active');
    expect(active.rows.map((r) => r.name)).toEqual(['Shop 1']);
  });

  it('the business page shows the recorded eligibility and claim, in UTC, with the business’s own zone', async () => {
    const companyId = newUuidV7Bin();
    const company = {
      id: companyId,
      name: 'Shop',
      publicStoreId: 'P',
      city: null,
      createdAt: new Date(now - 300 * HOUR),
      timezone: 'Asia/Dubai',
      subscription: { ...base, version: 7 },
      branches: [],
      users: [],
      trialEligibility: { registrationMethod: 'both', createdAt: new Date(now - 300 * HOUR), closedAt: new Date(now - HOUR), closedReason: 'approved' },
      trialClaim: { ...running, expiryRecordedAt: null },
    };
    const zones: string[] = [];
    const platform = platformWith({
      prisma: { company: { findUniqueOrThrow: async () => company } },
      entitlement: {
        forCompany: async () => ({ state: 'trial_active' }),
        trialZone: (_id: Buffer, stored: string) => (zones.push(stored), stored),
      },
      billing: { pricingFor: async () => null },
      lifecycle: { timeline: async () => ({ events: [], payments: [] }) },
    });
    const page = await platform.business(binToUuid(companyId));
    expect(page).toMatchObject({
      trial: {
        eligibility: {
          registrationMethod: 'both',
          createdAt: company.trialEligibility.createdAt.toISOString(),
          closedAt: company.trialEligibility.closedAt.toISOString(),
          closedReason: 'approved',
        },
        claim: {
          claimedAt: running.claimedAt.toISOString(),
          startedAt: running.startedAt.toISOString(),
          endsAt: running.endsAt.toISOString(),
          expiryRecordedAt: null,
        },
        timeZone: 'Asia/Dubai',
      },
    });
    expect(zones).toEqual(['Asia/Dubai']);
  });

  it('a business the console created shows no trial at all', async () => {
    const companyId = newUuidV7Bin();
    const platform = platformWith({
      prisma: {
        company: {
          findUniqueOrThrow: async () => ({
            id: companyId,
            name: 'Shop',
            publicStoreId: 'P',
            city: null,
            createdAt: new Date(),
            timezone: 'Africa/Nouakchott',
            subscription: null,
            branches: [],
            users: [],
            trialEligibility: null,
            trialClaim: null,
          }),
        },
      },
      entitlement: { trialZone: (_id: Buffer, stored: string) => stored },
      lifecycle: { timeline: async () => ({ events: [], payments: [] }) },
    });
    expect(await platform.business(binToUuid(companyId))).toMatchObject({ trial: { eligibility: null, claim: null, timeZone: 'Africa/Nouakchott' } });
  });

  it('the Owner’s account page carries the trial with the entitlement — the same view the app reads', async () => {
    const trial = { status: 'active', durationHours: 168, durationDays: 7, claimedAt: 'c', startedAt: 's', endsAt: 'e', timeZone: 'Africa/Nouakchott' };
    const companyId = newUuidV7Bin();
    const platform = platformWith({
      tenant: { companyId: () => companyId },
      prisma: {
        company: { findUniqueOrThrow: async () => ({ name: 'Shop', city: null, createdAt: new Date(), branches: [] }) },
        user: { findFirst: async () => null },
      },
      entitlement: { forCompany: async () => ({ state: 'trial_active', trial }) },
      billing: { pricingFor: async () => null },
      lifecycle: { timeline: async () => ({ events: [], payments: [] }) },
    });
    expect((await platform.mySubscription()).entitlement).toMatchObject({ state: 'trial_active', trial });
  });
});
