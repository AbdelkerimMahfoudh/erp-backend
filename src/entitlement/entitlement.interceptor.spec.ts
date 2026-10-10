import { ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { EntitlementInterceptor } from './entitlement.interceptor';
import { EntitlementService } from './entitlement.service';
import { ENTITLEMENT_SUSPENDED, ENTITLEMENT_WRITE_BLOCKED } from './entitlement-rules';

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

function interceptorFor(subscription: { status: string; currentPeriodEnd: Date | null }) {
  const prisma = {
    subscription: {
      findFirst: async () => ({ ...subscription, isComplimentary: false, complimentaryUntil: null, subscribedBranchCount: 1, additionalSeats: 0 }),
    },
    // No billing period: the renewal check finds nothing due.
    billingPeriod: { findFirst: async () => null },
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
});
