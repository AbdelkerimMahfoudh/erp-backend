import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { EntitlementService } from '../entitlement/entitlement.service';
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
  /** The real zone rule — an unknown zone reads UTC and is reported once — over no database at all. */
  const zones = new EntitlementService({} as never, {} as never, { now: () => new Date(now) });
  afterEach(() => jest.restoreAllMocks());
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
      timezone: 'Africa/Casablanca',
      subscription: { ...sub, version: 1 },
      ...company,
      _count: { branches: 1, users: 1 },
    }));
    const prisma = { company: { findMany: async () => rows, count: async () => rows.length } };
    const platform = platformWith({ prisma, entitlement: zones });
    const all = await platform.businesses();
    expect(all.rows.map((r) => r.state)).toEqual(['trial_available', 'trial_active', 'trial_expired', 'pending', 'active']);
    const active = await platform.businesses(undefined, 'trial_active');
    expect(active.rows.map((r) => r.name)).toEqual(['Shop 1']);
  });

  it('each row with a trial carries it as the pending queue does — its end and the business’s zone (C18)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const zonesOf = ['Asia/Dubai', 'Africa/Casablanca', 'Europe/Paris', 'Africa/Nouakchott', 'Mars/Olympus'];
    const rows = SUBS.map(({ company, ...sub }, i) => ({
      id: newUuidV7Bin(),
      name: `Shop ${i}`,
      publicStoreId: `P${i}`,
      city: null,
      createdAt: new Date(now - i * HOUR),
      timezone: zonesOf[i],
      subscription: { ...sub, version: 1 },
      ...company,
      _count: { branches: 1, users: 1 },
    }));
    // The last row's trial is in its zone nobody knows: shown in UTC, as its own trial view shows it.
    rows[4] = { ...rows[4], trialEligibility: { closedAt: null }, trialClaim: running };
    const prisma = { company: { findMany: async () => rows, count: async () => rows.length } };
    const list = await platformWith({ prisma, entitlement: zones }).businesses();
    expect(list.rows.map((r) => r.trial)).toEqual([
      { status: 'available', endsAt: null, timeZone: 'Asia/Dubai' },
      { status: 'active', endsAt: running.endsAt.toISOString(), timeZone: 'Africa/Casablanca' },
      { status: 'expired', endsAt: ended.endsAt.toISOString(), timeZone: 'Europe/Paris' },
      // Never eligible: no trial, whatever the zone.
      null,
      { status: 'active', endsAt: running.endsAt.toISOString(), timeZone: 'UTC' },
    ]);
    expect(warn.mock.calls.filter(([m]) => /unknown time zone "Mars\/Olympus"/.test(String(m)))).toHaveLength(1);
  });

  describe('the pending queue says what each application became (C8; review finding R4-13)', () => {
    const attempt = (n: number, companyId: Buffer | null) => ({
      id: newUuidV7Bin(),
      companyId,
      businessName: `Shop ${n}`,
      ownerName: `Owner ${n}`,
      city: null,
      email: `o${n}@shop.test`,
      phone: null,
      language: 'fr',
      createdAt: new Date(now - n * HOUR),
    });
    const business = (timezone: string, sub: Record<string, unknown> | null, eligibility: { closedAt: Date | null } | null, claim: typeof running | null) => ({
      id: newUuidV7Bin(),
      timezone,
      subscription: sub,
      trialEligibility: eligibility,
      trialClaim: claim,
    });

    it('a business in its trial reads as one — with its end and its own zone — and every other application as it stands', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const available = business('Asia/Dubai', base, { closedAt: null }, null);
      const inTrial = business('Africa/Casablanca', base, { closedAt: null }, running);
      const endedTrial = business('Europe/Paris', base, { closedAt: null }, ended);
      const approvedDuring = business('Africa/Nouakchott', { ...base, status: 'activated', currentPeriodEnd: new Date(running.endsAt.getTime() + 30 * 24 * HOUR) }, { closedAt: new Date(now - HOUR / 2) }, running);
      const consoleMade = business('Africa/Nouakchott', base, null, null);
      const oddZone = business('Mars/Olympus', base, { closedAt: null }, running);
      const noRow = business('Africa/Nouakchott', null, null, null);
      const all = [available, inTrial, endedTrial, approvedDuring, consoleMade, oddZone, noRow];
      const attempts = [...all.map((b, i) => attempt(i + 1, b.id)), attempt(9, null)];
      const asked: unknown[] = [];
      const prisma = {
        registrationAttempt: { findMany: async () => attempts },
        company: {
          findMany: async (args: { where: { id: { in: Buffer[] } } }) => {
            asked.push(args);
            return all.filter((b) => args.where.id.in.some((id) => id.equals(b.id)));
          },
        },
      };
      const rows = await platformWith({ prisma, entitlement: zones }).pending();

      expect(rows.map((r) => [r.businessName, r.status, r.state, r.trial])).toEqual([
        ['Shop 1', 'pending_activation', 'trial_available', { status: 'available', endsAt: null, timeZone: 'Asia/Dubai' }],
        ['Shop 2', 'pending_activation', 'trial_active', { status: 'active', endsAt: running.endsAt.toISOString(), timeZone: 'Africa/Casablanca' }],
        ['Shop 3', 'pending_activation', 'trial_expired', { status: 'expired', endsAt: ended.endsAt.toISOString(), timeZone: 'Europe/Paris' }],
        // Approved while its trial runs: still in its trial, and the console says so — paid access waits for the end.
        ['Shop 4', 'activated', 'trial_active', { status: 'active', endsAt: running.endsAt.toISOString(), timeZone: 'Africa/Nouakchott' }],
        // Created from the console: never eligible — pending, no trial.
        ['Shop 5', 'pending_activation', 'pending', null],
        // A zone nobody knows reads UTC, as the trial's own view reads it — never a zone guessed for the country.
        ['Shop 6', 'pending_activation', 'trial_active', { status: 'active', endsAt: running.endsAt.toISOString(), timeZone: 'UTC' }],
        // A business without a subscription row reads as the entitlement reads it.
        ['Shop 7', 'unknown', 'expired', null],
        ['Shop 9', 'incomplete', null, null],
      ]);
      // One read for the businesses behind the page, by their ids.
      expect(asked).toHaveLength(1);
      // The unknown zone is reported, once — as the trial's own view reports it.
      expect(warn.mock.calls.filter(([m]) => /unknown time zone "Mars\/Olympus"/.test(String(m)))).toHaveLength(1);
    });
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
      // Evaluated before the page is read (D176) — and, with no subscription row, shown as no entitlement at all.
      entitlement: { forCompany: async () => ({ state: 'expired' }), trialZone: (_id: Buffer, stored: string) => stored },
      lifecycle: { timeline: async () => ({ events: [], payments: [] }) },
    });
    expect(await platform.business(binToUuid(companyId))).toMatchObject({
      entitlement: null,
      pricing: null,
      trial: { eligibility: null, claim: null, timeZone: 'Africa/Nouakchott' },
    });
  });

  it('the Owner’s account page carries the trial with the entitlement — the same view the app reads', async () => {
    const trial = { status: 'active', durationHours: 168, durationDays: 7, claimedAt: 'c', startedAt: 's', endsAt: 'e', timeZone: 'Africa/Nouakchott' };
    const companyId = newUuidV7Bin();
    const platform = platformWith({
      tenant: { companyId: () => companyId },
      prisma: {
        company: { findUniqueOrThrow: async () => ({ name: 'Shop', city: null, createdAt: new Date(), timezone: 'Africa/Nouakchott', branches: [] }) },
        user: { findFirst: async () => null },
      },
      entitlement: { forCompany: async () => ({ state: 'trial_active', trial }), trialZone: zones.trialZone.bind(zones) },
      billing: { pricingFor: async () => null },
      lifecycle: { timeline: async () => ({ events: [], payments: [] }) },
    });
    expect((await platform.mySubscription()).entitlement).toMatchObject({ state: 'trial_active', trial });
  });

  it('the Owner’s account page names the business’s zone at the top, normalised as the trial’s view is (C18)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pageIn = async (timezone: string) => {
      const companyId = newUuidV7Bin();
      const platform = platformWith({
        tenant: { companyId: () => companyId },
        prisma: {
          company: { findUniqueOrThrow: async () => ({ name: 'Shop', city: null, createdAt: new Date(), timezone, branches: [] }) },
          user: { findFirst: async () => null },
        },
        // No trial at all: the zone is said for every business, not only one with a trial view.
        entitlement: { forCompany: async () => ({ state: 'active', trial: null }), trialZone: zones.trialZone.bind(zones) },
        billing: { pricingFor: async () => null },
        lifecycle: { timeline: async () => ({ events: [], payments: [] }) },
      });
      return platform.mySubscription();
    };
    expect((await pageIn('Europe/Paris')).timeZone).toBe('Europe/Paris');
    expect((await pageIn('America/New_York')).timeZone).toBe('America/New_York');
    // An unknown zone reads UTC — never a zone guessed for the country — and is reported.
    expect((await pageIn('Mars/Olympus_Mons')).timeZone).toBe('UTC');
    expect(warn.mock.calls.filter(([m]) => /unknown time zone "Mars\/Olympus_Mons"; its dates are shown in UTC/.test(String(m)))).toHaveLength(1);
  });
});
