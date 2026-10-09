import { EntitlementService } from './entitlement.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * Every authenticated request asks the entitlement service about its company,
 * so that is where a renewal that fell due at the end of a prepaid period is
 * applied (D154 a, reviewed 2026-10-09): before the state is read, at most one
 * cheap check a minute per company, and never at the cost of the request.
 */

const COMPANY = newUuidV7Bin();
const OLD_END = new Date('2026-10-31T23:00:00.000Z');
const PAID_TO = new Date('2026-11-30T23:00:00.000Z');

function makeWorld(now: { t: Date }, opts: { failRead?: boolean } = {}) {
  let reads = 0;
  let rolls = 0;
  const sub = { id: newUuidV7Bin(), companyId: COMPANY, status: 'activated', currentPeriodEnd: PAID_TO, isComplimentary: false, complimentaryUntil: null, subscribedBranchCount: 1, additionalSeats: 0 };
  let latestEnd = OLD_END;
  const prisma: Record<string, any> = {
    subscription: { findFirst: async () => ({ ...sub }) },
    billingPeriod: {
      findFirst: async () => {
        reads += 1;
        if (opts.failRead) throw new Error('database unavailable');
        return { id: Buffer.alloc(16, 1), periodStart: new Date('2026-10-01T00:00:00Z'), periodEnd: latestEnd, branchMonthly: 500, agentMonthly: 300, bothMonthly: 700, includedStaffPerBranch: 1, extraStaffMonthly: 100 };
      },
      create: async ({ data }: any) => {
        rolls += 1;
        latestEnd = data.periodEnd;
      },
    },
    planVersion: { findMany: async () => [{ id: Buffer.alloc(16, 3), planKey: 'standard', version: 3, branchMonthly: 500, agentMonthly: 300, bothMonthly: 700, includedStaffPerBranch: 1, extraStaffMonthly: 100, effectiveFrom: new Date('2026-01-01T00:00:00Z'), reason: 'v3' }] },
    branch: { findMany: async () => [] },
    subscriptionEvent: { create: async () => undefined },
    // The census's two raw queries, and the subscription lock.
    $queryRaw: async () => [],
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  const service = new EntitlementService(prisma as never, { companyId: () => COMPANY } as never, { now: () => now.t });
  return { service, reads: () => reads, rolls: () => rolls };
}

describe('the entitlement check applies a renewal that fell due', () => {
  it('rolls once after the old end, and checks again only after a minute', async () => {
    const now = { t: new Date(OLD_END.getTime() + 60 * 60_000) };
    const w = makeWorld(now);
    await w.service.mayWrite(COMPANY);
    expect(w.rolls()).toBe(1);
    const readsAfterFirst = w.reads();
    await w.service.mayWrite(COMPANY);
    await w.service.current();
    // Within the minute: not even the cheap read again.
    expect(w.reads()).toBe(readsAfterFirst);
    now.t = new Date(now.t.getTime() + 61_000);
    await w.service.mayWrite(COMPANY);
    // A minute later it looks again, finds the new period running, and rolls nothing.
    expect(w.reads()).toBeGreaterThan(readsAfterFirst);
    expect(w.rolls()).toBe(1);
  });

  it('before the old end, nothing rolls', async () => {
    const w = makeWorld({ t: new Date(OLD_END.getTime() - 60_000) });
    await w.service.mayWrite(COMPANY);
    expect(w.rolls()).toBe(0);
  });

  it('a failing check never fails the request: the state is still answered', async () => {
    const w = makeWorld({ t: new Date(OLD_END.getTime() + 60_000) }, { failRead: true });
    await expect(w.service.mayWrite(COMPANY)).resolves.toBe(true);
    expect(w.rolls()).toBe(0);
  });
});
