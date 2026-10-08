import {
  buildEntitlement,
  canWrite,
  daysRemaining,
  ENTITLEMENT_WRITE_BLOCKED,
  GRACE_MS,
  graceEndsAt,
  graceHoursRemaining,
  mayConsumeSeat,
  seatMath,
  INCLUDED_SEATS_PER_STORE,
  mayConsumeSeatIn,
  stateOf,
  type SubscriptionRecord,
} from './entitlement-rules';
import {
  isAllowedWhenExpired,
  isMutation,
  ALWAYS_ALLOWED,
  ALWAYS_READABLE,
  isAlwaysReadable,
} from './route-classification';

/**
 * Subscription entitlement (Milestone K).
 *
 * Every boundary is tested with an injected clock rather than by waiting: the
 * instant before a period ends, the instant after, and both ends of the 72-hour
 * grace. A billing boundary that is only ever tested in the middle of a period
 * is a billing boundary nobody has actually tested.
 */

const AUG_18 = new Date('2026-08-18T12:00:00.000Z');

const sub = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  subscribedBranchCount: 1,
  additionalSeats: 0,
  currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
  isComplimentary: false,
  complimentaryUntil: null,
  ...over,
});

describe('the state comes from the server clock', () => {
  it('is active while the period is running', () => {
    expect(stateOf(sub(), AUG_18)).toBe('active');
  });

  it('is still active in the last millisecond of the period', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    expect(stateOf(sub(), new Date(end.getTime() - 1))).toBe('active');
  });

  it('enters grace the instant the period ends', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    expect(stateOf(sub(), end)).toBe('grace');
  });

  it('is still in grace one millisecond before 72 hours are up', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    expect(stateOf(sub(), new Date(end.getTime() + GRACE_MS - 1))).toBe('grace');
  });

  it('expires exactly 72 hours after the period ended', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    expect(stateOf(sub(), new Date(end.getTime() + GRACE_MS))).toBe('expired');
  });

  it('treats a company that never subscribed as expired', () => {
    // Reads still work. It simply cannot write business truth.
    expect(stateOf(sub({ currentPeriodEnd: null }), AUG_18)).toBe('expired');
  });
});

describe('grace keeps the till open', () => {
  it('writes are accepted during grace', () => {
    /*
      A shop three hours past renewal is still open and still selling. Refusing
      its sales over an administrative boundary would cost it real money, so the
      warning is loud and the till keeps working.
    */
    expect(canWrite('grace')).toBe(true);
  });

  it('and refused once grace is over', () => {
    expect(canWrite('expired')).toBe(false);
  });

  it('active and complimentary both write', () => {
    expect(canWrite('active')).toBe(true);
    expect(canWrite('complimentary')).toBe(true);
  });

  it('counts down the grace hours', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    const s = sub();
    expect(graceHoursRemaining(s, end)).toBe(72);
    expect(graceHoursRemaining(s, new Date(end.getTime() + 71 * 3600_000))).toBe(1);
    // Never negative: "expired 40 hours ago" is not a countdown.
    expect(graceHoursRemaining(s, new Date(end.getTime() + 200 * 3600_000))).toBe(0);
  });

  it('derives the grace end from the period rather than storing it', () => {
    const s = sub();
    expect(graceEndsAt(s)!.getTime()).toBe(s.currentPeriodEnd!.getTime() + GRACE_MS);
  });
});

describe('a complimentary grant outranks the paid period', () => {
  it('is complimentary while the grant is live, even with no paid period', () => {
    const s = sub({
      currentPeriodEnd: null,
      isComplimentary: true,
      complimentaryUntil: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(stateOf(s, AUG_18)).toBe('complimentary');
    expect(canWrite(stateOf(s, AUG_18))).toBe(true);
  });

  it('falls back to the paid period once the grant runs out', () => {
    // The two are separate facts. An ended grant does not expire a paid shop.
    const s = sub({
      isComplimentary: true,
      complimentaryUntil: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(stateOf(s, AUG_18)).toBe('active');
  });

  it('an ended grant with no paid period is expired', () => {
    const s = sub({
      currentPeriodEnd: null,
      isComplimentary: true,
      complimentaryUntil: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(stateOf(s, AUG_18)).toBe('expired');
  });
});

describe('seats belong to a store (docs/21, 2026-10-05)', () => {
  const stores = (...lines: { name: string; used: number; paid?: number; granted?: number }[]) =>
    lines.map((l, i) => ({ branchId: `b${i}`, name: l.name, seatsUsed: l.used, paidSeats: l.paid ?? 0, grantedSeats: l.granted ?? 0 }));

  it('gives one included seat per store, and the Owner never counts', () => {
    expect(INCLUDED_SEATS_PER_STORE).toBe(1);
    const m = seatMath(sub({ subscribedBranchCount: 3 }), { seatsUsed: 0, activeBranchCount: 3, branches: stores({ name: 'A', used: 0 }, { name: 'B', used: 0 }, { name: 'C', used: 0 }) });
    expect(m.includedSeats).toBe(3);
    expect(m.seatLimit).toBe(3);
  });

  it('does NOT pool across stores: a free seat at the quiet store seats nobody at the busy one', () => {
    const m = seatMath(sub({ subscribedBranchCount: 2 }), { seatsUsed: 1, activeBranchCount: 2, branches: stores({ name: 'Busy', used: 1 }, { name: 'Quiet', used: 0 }) });
    expect(mayConsumeSeatIn(m, 'b0')).toBe(false);
    expect(mayConsumeSeatIn(m, 'b1')).toBe(true);
    expect(m.seatsAvailable).toBe(1);
  });

  it('a paid or granted seat opens one more place at THAT store only', () => {
    const m = seatMath(sub({ subscribedBranchCount: 2 }), { seatsUsed: 2, activeBranchCount: 2, branches: stores({ name: 'A', used: 1, paid: 1 }, { name: 'B', used: 1, granted: 0 }) });
    expect(m.branches[0].seatLimit).toBe(2);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(true);
    expect(mayConsumeSeatIn(m, 'b1')).toBe(false);
    expect(m.additionalSeats).toBe(1);
  });

  it('a person at two stores holds a seat at each', () => {
    // The same person appears in both stores' head-counts.
    const m = seatMath(sub({ subscribedBranchCount: 2 }), { seatsUsed: 2, activeBranchCount: 2, branches: stores({ name: 'A', used: 1 }, { name: 'B', used: 1 }) });
    expect(m.seatsUsed).toBe(2);
    expect(m.seatsAvailable).toBe(0);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(false);
  });

  it('an unknown store seats nobody — the boundary fails closed', () => {
    const m = seatMath(sub(), { seatsUsed: 0, activeBranchCount: 1, branches: stores({ name: 'A', used: 0 }) });
    expect(mayConsumeSeatIn(m, 'nowhere')).toBe(false);
  });

  it('seats bought under the pooled rule and not yet assigned stay usable anywhere', () => {
    const m = seatMath(sub({ subscribedBranchCount: 1, additionalSeats: 1 }), { seatsUsed: 1, activeBranchCount: 1, branches: stores({ name: 'A', used: 1 }) });
    expect(m.pooledSeats).toBe(1);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(true);
    const full = seatMath(sub({ subscribedBranchCount: 1, additionalSeats: 1 }), { seatsUsed: 2, activeBranchCount: 1, branches: stores({ name: 'A', used: 2 }) });
    expect(mayConsumeSeatIn(full, 'b0')).toBe(false);
    expect(full.overLimit).toBe(false);
  });

  it('reports a store over its seats without proposing to fix it', () => {
    /*
      Staff who predate the rule may outnumber a store's seats. Nobody is
      deactivated automatically: the Owner is told, further activations at that
      store are blocked, and the decision about who stays belongs to the shop.
    */
    const m = seatMath(sub({ subscribedBranchCount: 1 }), { seatsUsed: 3, activeBranchCount: 1, branches: stores({ name: 'A', used: 3 }) });
    expect(m.branches[0].overLimit).toBe(true);
    expect(m.overLimit).toBe(true);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(false);
  });

  it('granted seats from the transition bring a store back within its seats, uncharged', () => {
    const m = seatMath(sub(), { seatsUsed: 3, activeBranchCount: 1, branches: stores({ name: 'A', used: 3, granted: 2 }) });
    expect(m.branches[0].overLimit).toBe(false);
    expect(m.overLimit).toBe(false);
    expect(mayConsumeSeatIn(m, 'b0')).toBe(false);
  });

  it('carries each store\'s activity and the change scheduled for the renewal; a store that says nothing is an electronics store (D156)', () => {
    /*
     * The app learns from `seatsByStore[].activity` which money routes a branch
     * may write — a flag, never a price. An older server omits it, and the app
     * reads that as electronics, which keeps today's app exactly as it is.
     */
    const lines = stores({ name: 'Shop', used: 0 }, { name: 'Counter', used: 0 });
    const m = seatMath(sub({ subscribedBranchCount: 2 }), {
      seatsUsed: 0,
      activeBranchCount: 2,
      branches: [lines[0], { ...lines[1], activity: 'money_agent', activityNext: 'electronics' }],
    });
    expect(m.branches.map((b) => [b.name, b.activity, b.activityNext])).toEqual([
      ['Shop', 'electronics', null],
      ['Counter', 'money_agent', 'electronics'],
    ]);
    const e = buildEntitlement(sub({ subscribedBranchCount: 2 }), { seatsUsed: 0, activeBranchCount: 2, branches: [{ ...lines[0], activity: 'both' }] }, AUG_18);
    expect(e.seatsByStore[0]).toMatchObject({ name: 'Shop', activity: 'both', activityNext: null });
  });

  it('without per-store detail it reads company-wide, one seat per subscribed store', () => {
    const m = seatMath(sub({ subscribedBranchCount: 2, additionalSeats: 1 }), { seatsUsed: 2, activeBranchCount: 2 });
    expect(m.includedSeats).toBe(2);
    expect(m.seatLimit).toBe(3);
    expect(mayConsumeSeat(m)).toBe(true);
    expect(mayConsumeSeat(seatMath(sub({ subscribedBranchCount: 1 }), { seatsUsed: 1, activeBranchCount: 1 }))).toBe(false);
  });
});

describe('the whole answer is calculated on the server', () => {
  it('carries every figure the client would otherwise derive', () => {
    const e = buildEntitlement(sub(), { seatsUsed: 1, activeBranchCount: 1 }, AUG_18);
    expect(e).toMatchObject({
      state: 'active',
      subscribedBranchCount: 1,
      activeBranchCount: 1,
      includedSeats: 1,
      seatLimit: 1,
      seatsUsed: 1,
      overLimit: false,
      seatsByStore: [],
      canRead: true,
      canWrite: true,
      isComplimentary: false,
    });
    expect(e.periodEnd).toBe('2026-09-01T00:00:00.000Z');
    expect(e.graceEnd).toBe('2026-09-04T00:00:00.000Z');
    expect(e.daysRemaining).toBe(13);
    // So a cached copy can be shown as stale rather than as current.
    expect(e.calculatedAt).toBe(AUG_18.toISOString());
  });

  it('reads are never blocked, in any state', () => {
    for (const end of [null, new Date('2020-01-01T00:00:00.000Z')]) {
      const e = buildEntitlement(sub({ currentPeriodEnd: end }), { seatsUsed: 0, activeBranchCount: 1 }, AUG_18);
      expect(e.canRead).toBe(true);
    }
  });

  it('reports no grace countdown when not in grace', () => {
    const e = buildEntitlement(sub(), { seatsUsed: 0, activeBranchCount: 1 }, AUG_18);
    expect(e.graceHoursRemaining).toBe(0);
  });

  it('counts remaining days without rounding up a part-day', () => {
    expect(daysRemaining(sub(), new Date('2026-08-31T23:00:00.000Z'))).toBe(0);
  });
});

describe('route classification fails closed', () => {
  it('a mutation nobody classified is blocked when expired', () => {
    // The realistic failure: a later milestone adds an endpoint and forgets
    // this file. Blocking is the safe answer; allowing would let a lapsed shop
    // write whatever the newest feature writes.
    expect(isAllowedWhenExpired('POST', 'some/future/endpoint')).toBe(false);
  });

  it('reads are always allowed', () => {
    expect(isAllowedWhenExpired('GET', 'sales')).toBe(true);
    expect(isAllowedWhenExpired('GET', 'analytics/daily')).toBe(true);
  });

  it('signing in and out survive expiry', () => {
    expect(isAllowedWhenExpired('POST', 'auth/login')).toBe(true);
    expect(isAllowedWhenExpired('POST', 'auth/refresh')).toBe(true);
    expect(isAllowedWhenExpired('POST', 'auth/logout')).toBe(true);
    expect(isAllowedWhenExpired('POST', 'auth/logout-all')).toBe(true);
  });

  it('marking a notification read survives, because it changes no business truth', () => {
    expect(isAllowedWhenExpired('POST', 'notifications/:id/read')).toBe(true);
  });

  it('but everything that moves stock, money or staff does not', () => {
    for (const [m, p] of [
      ['POST', 'sales'],
      ['POST', 'units'],
      ['POST', 'purchases'],
      ['POST', 'transfers'],
      ['POST', 'consignments'],
      ['POST', 'loans'],
      ['POST', 'returns'],
      ['POST', 'expenses'],
      ['POST', 'closings'],
      ['POST', 'corrections'],
      ['POST', 'goals'],
      ['POST', 'users'],
      ['PUT', 'settings'],
      ['POST', 'devices/adopt'],
    ] as const) {
      expect(isAllowedWhenExpired(m, p)).toBe(false);
    }
  });

  it('a device may be revoked, never adopted, once the subscription lapsed (2026-10-05)', () => {
    /*
     * Revoking removes authority, the way `logout-all` does: a stolen phone is
     * signed out whatever the shop owes. Adopting GRANTS authority, and a
     * lapsed shop enrolling new phones is exactly the case the block exists for.
     */
    expect(isAllowedWhenExpired('DELETE', 'devices/:deviceId')).toBe(true);
    expect(isAllowedWhenExpired('DELETE', 'devices/users/:userId/:deviceId')).toBe(true);
    expect(isAllowedWhenExpired('POST', 'devices/adopt')).toBe(false);
    // Nothing else under devices/ — a future route is blocked by default.
    expect(isAllowedWhenExpired('POST', 'devices/:deviceId')).toBe(false);
  });

  it('knows which methods can change something', () => {
    expect(isMutation('GET')).toBe(false);
    expect(isMutation('POST')).toBe(true);
    expect(isMutation('patch')).toBe(true);
    expect(isMutation('DELETE')).toBe(true);
  });

  it('every allowance explains itself', () => {
    for (const rule of ALWAYS_ALLOWED) {
      expect(rule.why.length).toBeGreaterThan(20);
    }
  });

  it('the allow-list stays exactly this short', () => {
    /*
     * The default is to BLOCK, and that is what protects a lapsed shop. Each
     * addition is a deliberate decision, so the list is pinned by name: a new
     * entry has to be argued for here as well as written there.
     */
    expect(ALWAYS_ALLOWED.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE devices/:deviceId',
      'DELETE devices/users/:userId/:deviceId',
      'POST account/deletion/cancel',
      'POST account/deletion/confirm',
      'POST account/deletion/request',
      'POST account/deletion/resend',
      'POST account/whatsapp/verify/confirm',
      'POST account/whatsapp/verify/start',
      'POST auth/login',
      'POST auth/logout',
      'POST auth/logout-all',
      'POST auth/refresh',
      'POST notifications/:id/read',
      // D154 (2026-10-08): asking for another activity for a branch is asking to pay (an
      // upgrade) or to pay less from the renewal (a downgrade); nothing changes by asking.
      'POST platform/my-subscription/activity-requests',
      'POST platform/my-subscription/seat-requests',
      'POST platform/my-subscription/seat-requests/:rid/withdraw',
      'POST platform/my-subscription/store-requests',
      'POST platform/portal-handoff',
    ]);
  });

  it('a person may leave, whatever the shop owes (docs/64)', () => {
    /*
     * The App Store requires that the way out is in the app, and the product
     * decision is that a pending, suspended or lapsed subscription never
     * traps a person: deleting their own account, and proving the WhatsApp
     * number the deletion code needs, survive every state.
     */
    for (const path of [
      'account/deletion/request',
      'account/deletion/resend',
      'account/deletion/confirm',
      'account/deletion/cancel',
      'account/whatsapp/verify/start',
      'account/whatsapp/verify/confirm',
    ]) {
      expect(isAllowedWhenExpired('POST', path)).toBe(true);
    }
    // But nothing under `account/` that is not listed — a future route is blocked by default.
    expect(isAllowedWhenExpired('POST', 'account/anything-else')).toBe(false);
    expect(isAllowedWhenExpired('DELETE', 'account')).toBe(false);
  });

  it('no OPERATIONAL route survives a lapsed subscription', () => {
    /*
     * The portal handoff was added because every newly registered shop is
     * pending by definition and that route leads to the page which ends the
     * pending state. That argument covers exactly one route and must not
     * quietly extend to the shop's actual work.
     */
    const operational = [
      'sales', 'units', 'inventory', 'purchases', 'transfers', 'returns',
      'refunds', 'expenses', 'closing', 'suppliers', 'loans', 'consignments',
      'products', 'pricing', 'goals', 'imports',
    ];
    for (const rule of ALWAYS_ALLOWED) {
      for (const word of operational) {
        expect(rule.path.startsWith(`${word}/`) || rule.path === word).toBe(false);
      }
    }
  });

  it('and the handoff is the only platform route allowed through', () => {
    const platform = ALWAYS_ALLOWED.filter((r) => r.path.startsWith('platform/'));
    // The handoff, and asking to pay for a seat, a store or another activity for a
    // branch (docs/21, 2026-10-05; D154, 2026-10-08): nothing is granted by asking,
    // and a lapsed shop must be able to ask.
    expect(platform.map((r) => r.path)).toEqual([
      'platform/my-subscription/seat-requests',
      'platform/my-subscription/store-requests',
      'platform/my-subscription/seat-requests/:rid/withdraw',
      'platform/my-subscription/activity-requests',
      'platform/portal-handoff',
    ]);
    // Minting a ticket is not spending one, and neither moves money.
    for (const r of platform) expect(r.method).toBe('POST');
  });

  it('the code the client keys on is stable', () => {
    // The mobile app must never parse English to know what happened.
    expect(ENTITLEMENT_WRITE_BLOCKED).toBe('ENTITLEMENT_WRITE_BLOCKED');
  });
});

/**
 * The account surface a shop keeps in every state.
 *
 * Pinned by name for the same reason as the mutation allow-list: the default
 * refuses, and each exception is a decision somebody has to argue for twice.
 */
describe('what a pending or suspended shop may still read', () => {
  it('the readable list stays exactly this short', () => {
    expect([...ALWAYS_READABLE].sort()).toEqual([
      'account',
      'account/deletion',
      'auth/logout',
      'auth/me',
      'auth/refresh',
      'entitlement',
      'health',
      'platform/my-subscription',
      'platform/payment-instructions',
    ]);
  });

  it('lets a pending shop read how to pay', () => {
    /*
     * The CP8 acceptance walked the handoff as a genuinely pending shop and the
     * payment dialog never opened: `payment-instructions` answered
     * ENTITLEMENT_PENDING, and the page treats an instructions failure as
     * non-fatal, so it failed silently — for the only kind of shop that needs
     * it. The portal is where a pending shop finds out what to pay; refusing it
     * the instructions makes the whole handoff pointless.
     */
    expect(isAlwaysReadable('platform/payment-instructions')).toBe(true);
    expect(isAlwaysReadable('platform/my-subscription')).toBe(true);
  });

  it('opens no operational read to a pending shop', () => {
    for (const path of [
      'sales', 'products', 'units', 'inventory/summary', 'purchases', 'transfers',
      'returns', 'expenses', 'suppliers', 'analytics/dashboard', 'closing', 'goals',
      'consignments', 'loans', 'pricing', 'categories', 'users', 'settings',
    ]) {
      expect(isAlwaysReadable(path)).toBe(false);
    }
  });

  it('names only account routes, never a business one', () => {
    for (const path of ALWAYS_READABLE) {
      const accountish = /^(entitlement|health|auth\/|account(\/deletion)?$|platform\/(my-subscription|payment-instructions))/;
      expect([path, accountish.test(path)]).toEqual([path, true]);
    }
  });
});
