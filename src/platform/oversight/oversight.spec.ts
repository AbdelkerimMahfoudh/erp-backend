import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { BadRequestException, NotFoundException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import { PlatformAdminGuard } from '../platform-admin.guard';
import { PlatformOversightController } from './oversight.controller';
import { PlatformOversightService, pageOf } from './oversight.service';

/**
 * The console's oversight of the lifecycle (0099; docs/101 §7): administrator reads only, behind the platform guard,
 * and what they return — a message's state, channel, masked destination and reasons; the grace decisions and which run
 * now; the trials claimed — told from the records, never recomputed into something else.
 */

const NOW = new Date('2026-11-02T12:00:00.000Z');
const COMPANY = newUuidV7Bin();
const OTHER = newUuidV7Bin();
const business = (id: Buffer, name: string) => ({ id, name, publicStoreId: `ST-${name.slice(0, 4).toUpperCase()}`, timezone: 'Africa/Nouakchott' });

function notice(over: Record<string, unknown> = {}) {
  return {
    id: newUuidV7Bin(),
    kind: 'paid_reminder',
    threshold: 'h72',
    variant: null,
    state: 'accepted',
    channel: 'whatsapp',
    destinationMasked: '+222••••1234',
    fallbackReason: null,
    failureReason: null,
    cancelReason: null,
    attempts: 1,
    requestedByUserId: null,
    dueAt: new Date('2026-10-29T09:30:00.000Z'),
    acceptedAt: new Date('2026-10-29T09:30:05.000Z'),
    completedAt: new Date('2026-10-29T09:30:05.000Z'),
    createdAt: new Date('2026-10-29T09:30:00.000Z'),
    ...over,
  };
}

function episode(over: Record<string, unknown> = {}) {
  const periodEnd = new Date('2026-11-01T09:30:00.000Z');
  return {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    periodEnd,
    decision: 'granted',
    startedAt: periodEnd,
    endsAt: new Date(periodEnd.getTime() + 72 * 3_600_000),
    usesBefore: 0,
    recordedBy: 'evaluation',
    recordedAt: periodEnd,
    subscription: { currentPeriodEnd: periodEnd, status: 'activated' },
    company: business(COMPANY, 'Boutique Aicha'),
    ...over,
  };
}

function world(seed: { notices?: ReturnType<typeof notice>[]; episodes?: ReturnType<typeof episode>[]; companies?: Buffer[] } = {}) {
  const calls: { model: string; args: unknown }[] = [];
  const notices = (seed.notices ?? []).map((n) => ({ ...n, company: business(COMPANY, 'Boutique Aicha') }));
  const episodes = seed.episodes ?? [];
  const prisma = {
    subscriptionNotice: {
      findMany: jest.fn(async (args: unknown) => (calls.push({ model: 'notice.findMany', args }), notices)),
      count: jest.fn(async () => notices.length),
      groupBy: jest.fn(async () => [
        { state: 'accepted', _count: { _all: 4 } },
        { state: 'failed', _count: { _all: 1 } },
      ]),
    },
    company: { findUnique: jest.fn(async ({ where }: { where: { id: Buffer } }) => ((seed.companies ?? [COMPANY]).some((c) => c.equals(where.id)) ? { id: where.id } : null)) },
    graceEpisode: {
      findMany: jest.fn(async (args: { where?: { decision?: string } }) => (args.where?.decision ? episodes.filter((e) => e.decision === 'granted' && e.startedAt <= NOW && NOW < e.endsAt) : episodes)),
      count: jest.fn(async () => episodes.length),
      groupBy: jest.fn(async () => [
        { companyId: COMPANY, _count: { _all: 3 } },
        { companyId: OTHER, _count: { _all: 1 } },
      ]),
    },
    trialClaim: {
      findMany: jest.fn(async (args: unknown) => (calls.push({ model: 'trial.findMany', args }), [
        { id: newUuidV7Bin(), claimedAt: new Date('2026-10-30T08:00:00.000Z'), endsAt: new Date('2026-11-06T08:00:00.000Z'), expiryRecordedAt: null, termsVersion: '2026-10-18', company: { ...business(COMPANY, 'Boutique Aicha'), trialEligibility: { registrationMethod: 'phone' } } },
        { id: newUuidV7Bin(), claimedAt: new Date('2026-10-01T08:00:00.000Z'), endsAt: new Date('2026-10-08T08:00:00.000Z'), expiryRecordedAt: new Date('2026-10-08T08:01:00.000Z'), termsVersion: '2026-10-13', company: { ...business(OTHER, 'Agence Ksar'), trialEligibility: null } },
      ])),
      count: jest.fn(async ({ where }: { where: { endsAt?: { gt?: Date; lte?: Date } } }) => (where.endsAt?.gt ? 1 : where.endsAt?.lte ? 1 : 2)),
    },
    trialEligibility: { count: jest.fn(async () => 5) },
  };
  const entitlement = { trialZone: (_: Buffer, zone: string) => zone };
  const timeline = { next: { kind: 'grace_reminder', threshold: 'h24', dueAt: '2026-11-03T09:30:00.000Z' }, last: null };
  const noticeService = { timelineOf: jest.fn(async () => timeline) };
  const service = new PlatformOversightService(prisma as never, entitlement as never, noticeService as never, { now: () => NOW } as never);
  return { service, prisma, calls, timeline };
}

describe('the oversight routes, from the platform’s side', () => {
  const proto = PlatformOversightController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const handlers = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[name]));
  /** The code alone: what a comment says is not what a query selects. */
  const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const SOURCE = code('src/platform/oversight/oversight.controller.ts');
  const SERVICE = code('src/platform/oversight/oversight.service.ts');

  it('are administrator reads only: each stands down the tenant guard and stands behind the platform guard, none changes anything', () => {
    expect(handlers.sort()).toEqual(['businessNotices', 'graceUsage', 'noticeLog', 'trialClaims']);
    for (const name of handlers) {
      expect({ name, isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, proto[name]) }).toEqual({ name, isPublic: true });
      expect({ name, guarded: (Reflect.getMetadata(GUARDS_METADATA, proto[name]) ?? []).includes(PlatformAdminGuard) }).toEqual({ name, guarded: true });
      expect({ name, method: Reflect.getMetadata(METHOD_METADATA, proto[name]) }).toEqual({ name, method: RequestMethod.GET });
    }
  });

  it('read no tenant context or header, and select no shop’s trade, no whole contact and no message body', () => {
    for (const src of [SOURCE, SERVICE]) {
      expect(src).not.toMatch(/this\.tenant\b|x-company-id|x-branch-id/i);
      expect(src).not.toMatch(/\b(sale|saleItem|expense|costPrice|margin)\b\s*[:.]/);
    }
    expect(SERVICE).not.toMatch(/destinationHash|\bphone: true|\bemail: true|\bbody\b/);
    expect(SERVICE).not.toMatch(/\.(create|update|upsert|delete)(Many)?\(/);
  });

  it('a page is a positive whole number, 1 otherwise', () => {
    expect([pageOf(undefined), pageOf('0'), pageOf('-2'), pageOf('2.5'), pageOf('abc'), pageOf('3')]).toEqual([1, 1, 1, 1, 1, 3]);
  });
});

describe('the subscription messages', () => {
  it('lists each with its business, state, channel, masked destination and reasons; a resend is told apart; every state counted', async () => {
    const w = world({
      notices: [
        notice({ kind: 'portal_instructions', threshold: 'resend:x', requestedByUserId: newUuidV7Bin(), channel: 'email', destinationMasked: 'o•••@example.test', fallbackReason: 'number_undeliverable' }),
        notice({ state: 'failed', channel: null, destinationMasked: null, failureReason: 'opted_out', acceptedAt: null }),
      ],
    });
    const log = await w.service.noticeLog({ page: 1 });
    expect(log.rows.map((r) => [r.kind, r.state, r.channel, r.destination, r.fallbackReason, r.failureReason, r.resend])).toEqual([
      ['portal_instructions', 'accepted', 'email', 'o•••@example.test', 'number_undeliverable', null, true],
      ['paid_reminder', 'failed', null, null, null, 'opted_out', false],
    ]);
    expect(log.rows[0]!.business).toEqual({ id: binToUuid(COMPANY), name: 'Boutique Aicha', publicStoreId: 'ST-BOUT' });
    expect(log.byState).toEqual({ pending: 0, sending: 0, accepted: 4, delivered: 0, failed: 1, cancelled: 0, superseded: 0 });
    expect([log.total, log.page, log.pageSize]).toEqual([2, 1, 50]);
  });

  it('narrows by state and kind — and refuses one it does not know, before reading anything', async () => {
    const w = world();
    await w.service.noticeLog({ state: 'failed', kind: 'grace_ended', page: 2 });
    expect(w.calls[0]!.args).toMatchObject({ where: { state: 'failed', kind: 'grace_ended' }, skip: 50, take: 50 });
    for (const bad of [{ state: 'lost' }, { kind: 'marketing' }]) {
      await expect(w.service.noticeLog({ ...bad, page: 1 })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(w.calls).toHaveLength(1);
  });

  it('one business’s: its timeline as things stand and its last fifty; an unknown business is not found', async () => {
    const w = world({ notices: [notice()] });
    const mine = await w.service.businessNotices(COMPANY);
    expect(mine.timeline).toBe(w.timeline);
    expect(mine.messages).toHaveLength(1);
    expect(mine.messages[0]).not.toHaveProperty('business');
    await expect(w.service.businessNotices(OTHER)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the grace decisions', () => {
  it('tells which run now: granted, within its 72 hours, still the period’s — not renewed past it, not suspended', async () => {
    const renewed = episode({ subscription: { currentPeriodEnd: new Date('2026-12-01T09:30:00.000Z'), status: 'activated' } });
    const suspended = episode({ subscription: { currentPeriodEnd: new Date('2026-11-01T09:30:00.000Z'), status: 'suspended' } });
    const refused = episode({ decision: 'refused', endsAt: new Date('2026-11-01T09:30:00.000Z'), usesBefore: 3 });
    const ended = episode({ periodEnd: new Date('2026-06-01T09:30:00.000Z'), startedAt: new Date('2026-06-01T09:30:00.000Z'), endsAt: new Date('2026-06-04T09:30:00.000Z'), subscription: { currentPeriodEnd: new Date('2026-06-01T09:30:00.000Z'), status: 'activated' } });
    const w = world({ episodes: [episode(), renewed, suspended, refused, ended] });
    const usage = await w.service.graceUsage(1);
    expect(usage.rows.map((r) => [r.decision, r.running])).toEqual([
      ['granted', true],
      ['granted', false],
      ['granted', false],
      ['refused', false],
      ['granted', false],
    ]);
    expect(usage.summary).toEqual({ running: 1, atAllowance: 1, withUse: 2 });
    expect(usage.rules).toEqual({ allowance: 3, windowMonths: 12, durationHours: 72 });
    expect(usage.rows[3]).toMatchObject({ usesBefore: 3, business: { name: 'Boutique Aicha' }, timeZone: 'Africa/Nouakchott' });
  });
});

describe('the trials claimed', () => {
  it('lists each, running or ended, with how many eligible businesses have not claimed', async () => {
    const w = world();
    const claims = await w.service.trialClaims({ page: 1 });
    expect(claims.rows.map((r) => [r.business.name, r.status, r.registrationMethod, r.termsVersion])).toEqual([
      ['Boutique Aicha', 'active', 'phone', '2026-10-18'],
      ['Agence Ksar', 'expired', null, '2026-10-13'],
    ]);
    expect(claims.summary).toEqual({ active: 1, expired: 1, eligibleUnclaimed: 5 });
  });

  it('narrows to the running or the ended, by the server’s clock — and refuses any other status', async () => {
    const w = world();
    await w.service.trialClaims({ status: 'active', page: 1 });
    expect(w.calls[0]!.args).toMatchObject({ where: { endsAt: { gt: NOW } } });
    await expect(w.service.trialClaims({ status: 'paused', page: 1 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
