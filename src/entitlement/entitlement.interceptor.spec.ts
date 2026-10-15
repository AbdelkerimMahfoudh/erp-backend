import { ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { EntitlementInterceptor } from './entitlement.interceptor';
import { EntitlementService } from './entitlement.service';
import { ENTITLEMENT_SUSPENDED, ENTITLEMENT_TRIAL_AVAILABLE, ENTITLEMENT_WRITE_BLOCKED } from './entitlement-rules';

/**
 * The one place a lapsed or stopped subscription refuses a write (Milestone K),
 * and what that refusal says (D161).
 *
 * Driven through the real entitlement service over a subscription row, so the
 * state and the sentence are the ones a phone actually receives. A suspended
 * business was told its subscription "has ended" — untrue, and a phone
 * replaying a queued write could not tell "send it again after renewing" from
 * "this business is stopped".
 */

const COMPANY = Buffer.alloc(16, 7);
const NOW = new Date('2026-10-10T12:00:00.000Z');

/** The company the evaluation reads with the row (0095): its zone and, when given, its free trial. */
interface TrialRows {
  trialEligibility?: { closedAt: Date | null } | null;
  trialClaim?: { id: Buffer; claimedAt: Date; startedAt: Date; endsAt: Date; expiryRecordedAt: Date | null } | null;
}

function interceptorFor(subscription: { status: string; currentPeriodEnd: Date | null }, trial: TrialRows = {}) {
  const company = { name: 'Shop', timezone: 'UTC', trialEligibility: trial.trialEligibility ?? null, trialClaim: trial.trialClaim ?? null };
  const prisma = {
    subscription: {
      findFirst: async () => ({ ...subscription, isComplimentary: false, complimentaryUntil: null, subscribedBranchCount: 1, additionalSeats: 0, company }),
    },
    // No billing period: the renewal check finds nothing due.
    billingPeriod: { findFirst: async () => null },
    // Nothing was paid for during a trial: once one ends, nothing is due to be put in force (D176).
    seatAllocation: { findFirst: async () => null },
    branch: { count: async () => 1 },
    $queryRaw: async () => [{ n: 0n }],
  };
  const entitlement = new EntitlementService(prisma as never, {} as never, { now: () => NOW });
  const reflector = { getAllAndOverride: () => false };
  const cls = { get: (key: string) => (key === 'companyId' ? COMPANY : undefined) };
  return new EntitlementInterceptor(reflector as never, entitlement, cls as never);
}

function request(method: string, path: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, route: { path } }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as never;
}

const handler = { handle: () => of('ran') };

async function refusalOf(subscription: { status: string; currentPeriodEnd: Date | null }, method = 'POST', path = '/api/v1/agent/transactions') {
  const e = await interceptorFor(subscription)
    .intercept(request(method, path), handler)
    .catch((err: unknown) => err);
  expect(e).toBeInstanceOf(ForbiddenException);
  return (e as ForbiddenException).getResponse() as Record<string, unknown>;
}

describe('a refused write names the subscription state (D161)', () => {
  it('expired: the subscription ended, and everything can still be read', async () => {
    const body = await refusalOf({ status: 'activated', currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z') });
    expect(body).toEqual({ code: ENTITLEMENT_WRITE_BLOCKED, state: 'expired', message: 'Your subscription has ended. You can still read and export everything.' });
  });

  it('suspended, cancelled, pending, rejected: each says what it is, and none says the subscription ended', async () => {
    for (const [status, state] of [
      ['suspended', 'suspended'],
      ['cancelled', 'cancelled'],
      ['pending_activation', 'pending'],
      ['rejected', 'rejected'],
    ]) {
      const body = await refusalOf({ status, currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z') });
      expect([status, body.code, body.state]).toEqual([status, ENTITLEMENT_WRITE_BLOCKED, state]);
      expect(body.message).not.toMatch(/\bended\b/);
    }
    expect((await refusalOf({ status: 'suspended', currentPeriodEnd: null })).message).toMatch(/suspended/);
  });

  it('a running subscription writes', async () => {
    const live = interceptorFor({ status: 'activated', currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z') });
    await expect(lastValueFrom(await live.intercept(request('POST', '/api/v1/agent/transactions'), handler))).resolves.toBe('ran');
  });

  it('reads keep their own refusal, which carried the state already', async () => {
    const body = await refusalOf({ status: 'suspended', currentPeriodEnd: null }, 'GET', '/api/v1/agent/transactions');
    expect(body).toMatchObject({ code: ENTITLEMENT_SUSPENDED, state: 'suspended' });
  });

  it('but a phone may still ask what became of its own money record, in every closed state (D161)', async () => {
    for (const status of ['suspended', 'cancelled', 'pending_activation', 'rejected']) {
      const closed = interceptorFor({ status, currentPeriodEnd: null });
      await expect(lastValueFrom(await closed.intercept(request('GET', '/api/v1/agent/transactions/client/:clientUuid'), handler))).resolves.toBe('ran');
    }
  });
});

describe('the free trial at the gate (0095)', () => {
  const HOUR = 60 * 60 * 1000;
  const pending = { status: 'pending_activation', currentPeriodEnd: null };
  const claimed = (start: Date) => ({
    id: Buffer.alloc(16, 9),
    claimedAt: start,
    startedAt: start,
    endsAt: new Date(start.getTime() + 168 * HOUR),
    // An ended trial's expiry already recorded: this spec is about the gate, not the record (trial-expiry.spec).
    expiryRecordedAt: start.getTime() + 168 * HOUR <= NOW.getTime() ? NOW : null,
  });

  it('not started: writes and reads are refused as "not started" — never "ended", never "waiting to be activated"', async () => {
    const open = { trialEligibility: { closedAt: null } };
    const e = await interceptorFor(pending, open)
      .intercept(request('POST', '/api/v1/sales'), handler)
      .catch((err: unknown) => err);
    expect((e as ForbiddenException).getResponse()).toEqual({
      code: ENTITLEMENT_WRITE_BLOCKED,
      state: 'trial_available',
      message: 'This business has not started yet, so nothing can be changed.',
    });
    const r = await interceptorFor(pending, open)
      .intercept(request('GET', '/api/v1/sales'), handler)
      .catch((err: unknown) => err);
    expect((r as ForbiddenException).getResponse()).toEqual({
      code: ENTITLEMENT_TRIAL_AVAILABLE,
      state: 'trial_available',
      message: 'This business has not started yet.',
    });
  });

  it('running: the business writes and reads like a paid month', async () => {
    const running = interceptorFor(pending, { trialEligibility: { closedAt: null }, trialClaim: claimed(new Date(NOW.getTime() - 24 * HOUR)) });
    await expect(lastValueFrom(await running.intercept(request('POST', '/api/v1/sales'), handler))).resolves.toBe('ran');
    await expect(lastValueFrom(await running.intercept(request('GET', '/api/v1/sales'), handler))).resolves.toBe('ran');
  });

  it('ended: read-only from the exact end — every read, no write, and the refusal says the trial ended', async () => {
    const ended = { trialEligibility: { closedAt: null }, trialClaim: claimed(new Date(NOW.getTime() - 168 * HOUR)) };
    const e = await interceptorFor(pending, ended)
      .intercept(request('POST', '/api/v1/sales'), handler)
      .catch((err: unknown) => err);
    expect((e as ForbiddenException).getResponse()).toEqual({
      code: ENTITLEMENT_WRITE_BLOCKED,
      state: 'trial_expired',
      message: 'The free trial has ended. You can still read and export everything.',
    });
    await expect(lastValueFrom(await interceptorFor(pending, ended).intercept(request('GET', '/api/v1/sales'), handler))).resolves.toBe('ran');
  });
});
