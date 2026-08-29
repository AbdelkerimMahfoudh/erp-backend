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
  SEATS_PER_BRANCH,
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

describe('seats', () => {
  it('gives two included seats per subscribed branch', () => {
    expect(SEATS_PER_BRANCH).toBe(2);
    expect(seatMath(sub({ subscribedBranchCount: 3 }), { seatsUsed: 0, activeBranchCount: 3 }).includedSeats).toBe(6);
  });

  it('pools them across the company rather than pinning them to a branch', () => {
    /*
      Three subscribed branches give six seats, and all six may sit in one shop.
      A company that hires its second person at the quieter branch has not
      changed what it owes.
    */
    const m = seatMath(sub({ subscribedBranchCount: 3 }), { seatsUsed: 6, activeBranchCount: 3 });
    expect(m.overLimit).toBe(false);
    expect(m.seatsAvailable).toBe(0);
  });

  it('adds bought seats on top', () => {
    const m = seatMath(sub({ subscribedBranchCount: 1, additionalSeats: 3 }), { seatsUsed: 0, activeBranchCount: 1 });
    expect(m.seatLimit).toBe(5);
  });

  it('allows one more while there is room', () => {
    expect(mayConsumeSeat(seatMath(sub(), { seatsUsed: 1, activeBranchCount: 1 }))).toBe(true);
  });

  it('refuses the one that would exceed the limit', () => {
    expect(mayConsumeSeat(seatMath(sub(), { seatsUsed: 2, activeBranchCount: 1 }))).toBe(false);
  });

  it('reports being over the limit without proposing to fix it', () => {
    /*
      A plan reduction can leave a company above its limit. Nobody is deactivated
      automatically: the Owner is told, further activations are blocked, and the
      decision about who stays belongs to the shop. An app that fires somebody to
      balance an invoice is not a tool anybody should trust.
    */
    const m = seatMath(sub({ subscribedBranchCount: 1 }), { seatsUsed: 5, activeBranchCount: 1 });
    expect(m.overLimit).toBe(true);
    expect(m.seatLimit).toBe(2);
    expect(m.seatsUsed).toBe(5);
    expect(mayConsumeSeat(m)).toBe(false);
  });
});

describe('the whole answer is calculated on the server', () => {
  it('carries every figure the client would otherwise derive', () => {
    const e = buildEntitlement(sub(), { seatsUsed: 1, activeBranchCount: 1 }, AUG_18);
    expect(e).toMatchObject({
      state: 'active',
      subscribedBranchCount: 1,
      activeBranchCount: 1,
      includedSeats: 2,
      seatLimit: 2,
      seatsUsed: 1,
      overLimit: false,
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
      ['DELETE', 'devices/:deviceId'],
    ] as const) {
      expect(isAllowedWhenExpired(m, p)).toBe(false);
    }
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
      'POST auth/login',
      'POST auth/logout',
      'POST auth/logout-all',
      'POST auth/refresh',
      'POST notifications/:id/read',
      'POST platform/portal-handoff',
    ]);
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
    expect(platform.map((r) => r.path)).toEqual(['platform/portal-handoff']);
    // Minting a ticket is not spending one, and neither moves money.
    expect(platform[0].method).toBe('POST');
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
      const accountish = /^(entitlement|health|auth\/|platform\/(my-subscription|payment-instructions))/;
      expect([path, accountish.test(path)]).toEqual([path, true]);
    }
  });
});
