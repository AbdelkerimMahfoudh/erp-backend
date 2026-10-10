import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import {
  ACTIVITIES,
  ACTIVITY_NOT_SUBSCRIBED,
  activityAllows,
  activityLabel,
  isActivity,
  type Activity,
} from './activity';
import { AGENT_PREFIX, ELECTRONICS_WRITE_ROUTES, requiredActivityFor } from './activity-gate';
import { ActivityGateInterceptor, BRANCH_INACTIVE } from './activity-gate.interceptor';
import { ENTITLEMENT_WRITE_BLOCKED } from './entitlement-rules';

/**
 * A branch's activity gates its money routes (D156, docs/73 §2).
 *
 * The classification is pinned by name, like the entitlement allow-list: the
 * default is NOT gated, so every prefix here is a deliberate decision that has
 * to be argued for in this file as well as written in that one. Reads are
 * never gated; the company-level entitlement is untouched and runs first.
 */

describe('what an activity allows', () => {
  it('names the three activities, and nothing else is one', () => {
    expect(ACTIVITIES).toEqual(['electronics', 'money_agent', 'both']);
    for (const a of ACTIVITIES) expect(isActivity(a)).toBe(true);
    expect(isActivity('')).toBe(false);
    expect(isActivity('agent')).toBe(false);
    expect(isActivity(undefined)).toBe(false);
  });

  it('both satisfies either need; the other two satisfy their own', () => {
    expect(activityAllows('both', 'electronics')).toBe(true);
    expect(activityAllows('both', 'money_agent')).toBe(true);
    expect(activityAllows('electronics', 'electronics')).toBe(true);
    expect(activityAllows('electronics', 'money_agent')).toBe(false);
    expect(activityAllows('money_agent', 'money_agent')).toBe(true);
    expect(activityAllows('money_agent', 'electronics')).toBe(false);
  });

  it('a value that is none of the three allows nothing — the empty sql_mode coerces a bad ENUM to "" rather than refusing it', () => {
    expect(activityAllows('' as Activity, 'electronics')).toBe(false);
    expect(activityAllows('' as Activity, 'money_agent')).toBe(false);
  });

  it('speaks of an independent agent as money services, never as a bank employee', () => {
    for (const a of ACTIVITIES) expect(activityLabel(a)).not.toMatch(/bank/i);
    expect(activityLabel('money_agent')).toBe('money services');
  });

  it('the code the client keys on is stable', () => {
    expect(ACTIVITY_NOT_SUBSCRIBED).toBe('activity_not_subscribed');
  });
});

describe('which routes an activity gates', () => {
  it('reads are never gated, whatever the branch does', () => {
    for (const path of ['sales', 'sales/:id', 'agent/positions', 'agent/transactions/:id', 'purchases', 'pricing/products/:productId']) {
      expect(requiredActivityFor('GET', path)).toBeNull();
      expect(requiredActivityFor('HEAD', path)).toBeNull();
    }
  });

  it('every write under agent/ needs the money services counter', () => {
    for (const path of ['agent/transactions', 'agent/transactions/:id/reverse', 'agent/providers', 'agent/positions', 'agent/rebalancings']) {
      expect(requiredActivityFor('POST', path)).toBe('money_agent');
    }
    expect(requiredActivityFor('PATCH', 'agent/providers/:id')).toBe('money_agent');
    // The prefix is a segment, not a substring: an unrelated route that starts with the letters is not the agent ledger.
    expect(requiredActivityFor('POST', 'agents')).toBeNull();
    expect(requiredActivityFor('POST', 'agentless/thing')).toBeNull();
  });

  it('acquiring and selling electronics needs the electronics store: a new sale, receiving stock, a new consignment', () => {
    for (const [method, path] of [
      ['POST', 'sales'],
      ['POST', 'purchases'],
      ['POST', 'purchases/file/parse'],
      ['POST', 'imports'],
      ['POST', 'imports/:id/commit'],
      ['POST', 'consignments'],
    ] as const) {
      expect([method, path, requiredActivityFor(method, path)]).toEqual([method, path, 'electronics']);
    }
  });

  it('money owed on existing records and stock already held stay recordable at a branch that changed activity (reviewed 2026-10-09)', () => {
    /*
     * A branch moved from `both` to `money_agent` at its renewal still has
     * customers paying the balance of last month's sales, returns inside their
     * window, units to correct or send away, and partners to settle with. The
     * drawer is one physical drawer: refusing the record would not stop the
     * cash, only its record. So none of this is gated.
     */
    for (const [method, path] of [
      ['POST', 'sales/:id/payments'],
      ['POST', 'sales/:id/payments/:paymentId/payer-number'],
      ['POST', 'sales/:id/returns'],
      ['POST', 'returns'],
      ['PATCH', 'returns/:id/refund'],
      ['POST', 'returns/:id/refund/confirm'],
      ['DELETE', 'returns/:id/adjustments/:adjustmentId'],
      ['POST', 'units/:id/faulty'],
      ['PATCH', 'units/:id'],
      ['POST', 'transfers'],
      ['POST', 'transfers/:id/receive/confirm'],
      ['PUT', 'transfers/config/prefix'],
      ['POST', 'consignments/:id/sold'],
      ['POST', 'consignments/:id/payment'],
      ['POST', 'consignments/:id/return'],
      ['PUT', 'pricing/products/:productId/branch-price'],
      ['DELETE', 'pricing/units/:identifier/price'],
    ] as const) {
      expect([method, path, requiredActivityFor(method, path)]).toEqual([method, path, null]);
    }
  });

  it('tolerates the shape Nest reports, and a stray slash', () => {
    expect(requiredActivityFor('post', '/sales')).toBe('electronics');
    expect(requiredActivityFor('POST', 'sales/')).toBe('electronics');
    expect(requiredActivityFor('POST', '/agent/transactions/')).toBe('money_agent');
  });

  it('everything a shop of either kind has is left alone: expenses, the closing, money anchors, staff, settings, the catalogue, partners', () => {
    for (const [method, path] of [
      ['POST', 'expenses'],
      ['POST', 'closings'],
      ['POST', 'closings/count'],
      ['POST', 'closings/:date/float-counts'],
      ['POST', 'money/anchors'],
      ['POST', 'corrections'],
      ['POST', 'users'],
      ['PUT', 'settings'],
      ['POST', 'products'],
      ['PATCH', 'products/:id'],
      ['POST', 'categories'],
      ['POST', 'connections'],
      ['POST', 'counterparties'],
      ['POST', 'loans'],
      ['POST', 'goals'],
      ['POST', 'notifications/:id/read'],
      ['POST', 'auth/login'],
      ['POST', 'platform/my-subscription/activity-requests'],
      ['POST', 'some/future/endpoint'],
    ] as const) {
      expect([method, path, requiredActivityFor(method, path)]).toEqual([method, path, null]);
    }
  });

  it('the gated list stays exactly this short, and every prefix explains itself', () => {
    /*
     * The default is NOT gated, which is what keeps a combined shop's ordinary
     * work — expenses, the closing, staff — out of this. Each prefix is a
     * decision, so the list is pinned by name: a new entry has to be argued
     * for here as well as written there.
     */
    expect(AGENT_PREFIX).toBe('agent');
    expect(ELECTRONICS_WRITE_ROUTES.map((r) => `${r.match}:${r.path}`)).toEqual([
      'exact:sales',
      'prefix:purchases',
      'prefix:imports',
      'exact:consignments',
    ]);
    for (const rule of ELECTRONICS_WRITE_ROUTES) expect(rule.why.length).toBeGreaterThan(20);
  });
});

describe('the interceptor', () => {
  const COMPANY = Buffer.alloc(16, 1);
  const BRANCH = Buffer.alloc(16, 2);

  function makeCls(store: Record<string, unknown>) {
    return { get: (k: string) => store[k], set: (k: string, v: unknown) => void (store[k] = v) };
  }
  function makeContext(method: string, path: string, isPublic = false) {
    const req = { method, route: { path } };
    const reflector = { getAllAndOverride: () => isPublic };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => undefined,
      getClass: () => undefined,
    };
    return { context: context as never, reflector: reflector as never };
  }
  const handler = { handle: () => of('ran') };

  /** The branch as the database answers it: open unless the test says it was switched off or deleted. */
  function interceptorWith(activity: Activity | null, store: Record<string, unknown>, reflector: unknown, state: { isActive?: boolean; deletedAt?: Date | null } = {}) {
    const queries: unknown[] = [];
    const prisma = {
      branch: {
        findFirst: async (args: unknown) => {
          queries.push(args);
          return activity === null ? null : { activity, isActive: state.isActive ?? true, deletedAt: state.deletedAt ?? null };
        },
      },
    };
    return { int: new ActivityGateInterceptor(reflector as never, makeCls(store) as never, prisma as never), queries };
  }

  it('lets an electronics store sell, and a money services branch record an exchange', async () => {
    for (const [activity, method, path] of [
      ['electronics', 'POST', '/api/v1/sales'],
      ['money_agent', 'POST', '/api/v1/agent/transactions'],
      ['both', 'POST', '/api/v1/sales'],
      ['both', 'POST', '/api/v1/agent/transactions'],
    ] as const) {
      const { context, reflector } = makeContext(method, path);
      const { int, queries } = interceptorWith(activity, { companyId: COMPANY, branchId: BRANCH }, reflector);
      await expect(lastValueFrom(await int.intercept(context, handler))).resolves.toBe('ran');
      // One indexed query, on the branch in context and the caller's own company: its activity and whether it is open.
      expect(queries).toEqual([{ where: { id: BRANCH, companyId: COMPANY }, select: { activity: true, isActive: true, deletedAt: true } }]);
    }
  });

  it('refuses by name, saying what the branch is and what the route needed', async () => {
    const { context, reflector } = makeContext('POST', '/api/v1/agent/transactions');
    const { int } = interceptorWith('electronics', { companyId: COMPANY, branchId: BRANCH }, reflector);
    const refusal = await int.intercept(context, handler).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({
      code: ACTIVITY_NOT_SUBSCRIBED,
      activity: 'electronics',
      required: 'money_agent',
    });
    expect(JSON.stringify((refusal as ForbiddenException).getResponse())).toMatch(/money services/);

    const sell = makeContext('POST', '/api/v1/sales');
    const { int: agentOnly } = interceptorWith('money_agent', { companyId: COMPANY, branchId: BRANCH }, sell.reflector);
    const refused = await agentOnly.intercept(sell.context, handler).catch((e: unknown) => e);
    expect((refused as ForbiddenException).getResponse()).toMatchObject({
      code: ACTIVITY_NOT_SUBSCRIBED,
      activity: 'money_agent',
      required: 'electronics',
    });
  });

  it('never queries for a read, a public route, or a route no activity gates', async () => {
    for (const [method, path, isPublic] of [
      ['GET', '/api/v1/agent/positions', false],
      ['GET', '/api/v1/sales', false],
      ['POST', '/api/v1/expenses', false],
      ['POST', '/api/v1/closings', false],
      ['POST', '/api/v1/sales', true],
    ] as const) {
      const { context, reflector } = makeContext(method, path, isPublic);
      const { int, queries } = interceptorWith('money_agent', { companyId: COMPANY, branchId: BRANCH }, reflector);
      await expect(lastValueFrom(await int.intercept(context, handler))).resolves.toBe('ran');
      expect(queries).toEqual([]);
    }
  });

  it('a gated write with no branch in context is refused, never passed through (reviewed 2026-10-09)', async () => {
    /*
     * Passing it to the handler assumed every handler reads the header; one
     * that does not would then run with no activity check at all. The answer
     * is the one every branch route gives for a missing header.
     */
    for (const path of ['/api/v1/sales', '/api/v1/agent/transactions']) {
      const { context, reflector } = makeContext('POST', path);
      const { int, queries } = interceptorWith('money_agent', { companyId: COMPANY }, reflector);
      const refusal = await int.intercept(context, handler).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(BadRequestException);
      expect((refusal as BadRequestException).message).toBe('X-Branch-Id header is required for this operation');
      expect(queries).toEqual([]);
    }
  });

  it('fails closed with no company, and on a branch that is not the caller\'s', async () => {
    const { context, reflector } = makeContext('POST', '/api/v1/sales');
    const { int } = interceptorWith('both', { branchId: BRANCH }, reflector);
    const refusal = await int.intercept(context, handler).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({ code: ENTITLEMENT_WRITE_BLOCKED });

    const other = interceptorWith(null, { companyId: COMPANY, branchId: BRANCH }, reflector);
    const notTheirs = await other.int.intercept(context, handler).catch((e: unknown) => e);
    expect(notTheirs).toBeInstanceOf(ForbiddenException);
    // The guard's own refusal, coded (D161): the same sentence, and a code a replaying phone can read.
    expect((notTheirs as ForbiddenException).getResponse()).toEqual({ code: 'branch_access_denied', message: 'No access to the requested branch' });
  });

  it('a branch switched off or deleted takes no gated write, whatever its activity (D161)', async () => {
    /*
     * Nothing else stopped a phone that still held the branch in its header
     * from recording into it. Checked before the activity, so a closed branch
     * is never told it is merely subscribed to something else.
     */
    for (const [path, state] of [
      ['/api/v1/agent/transactions', { isActive: false }],
      ['/api/v1/agent/transactions', { deletedAt: new Date('2026-10-01T00:00:00Z') }],
      ['/api/v1/sales', { isActive: false }],
      ['/api/v1/sales', { isActive: true, deletedAt: new Date('2026-10-01T00:00:00Z') }],
    ] as const) {
      const { context, reflector } = makeContext('POST', path);
      const { int } = interceptorWith('electronics', { companyId: COMPANY, branchId: BRANCH }, reflector, state);
      const refusal = await int.intercept(context, handler).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({ code: 'branch_inactive' });
    }
    // The code the phone keys on is stable.
    expect(BRANCH_INACTIVE).toBe('branch_inactive');
  });

  it('reads at a closed branch stay open: its history is still the shop\'s', async () => {
    const { context, reflector } = makeContext('GET', '/api/v1/agent/transactions');
    const { int, queries } = interceptorWith('money_agent', { companyId: COMPANY, branchId: BRANCH }, reflector, { isActive: false });
    await expect(lastValueFrom(await int.intercept(context, handler))).resolves.toBe('ran');
    expect(queries).toEqual([]);
  });
});
