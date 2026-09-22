import {
  buildEntitlement,
  canRead,
  canWrite,
  stateOf,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from './entitlement-rules';

/**
 * The lifecycle states a platform administrator can put a subscription in.
 *
 * The existing 32 date-driven tests are untouched and still pass; these cover
 * only what the explicit statuses add, and — more importantly — that adding
 * them changed nothing for a subscription that has one of them unset.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-06-15T12:00:00.000Z');

function sub(over: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    subscribedBranchCount: 1,
    additionalSeats: 0,
    currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY),
    isComplimentary: false,
    complimentaryUntil: null,
    ...over,
  };
}

describe('the lifecycle changes nothing for subscriptions that predate it', () => {
  it('an absent status behaves exactly as before', () => {
    // The single most important test here. Every row in the database took the
    // `activated` default, and every one of them must behave identically.
    expect(stateOf(sub(), NOW)).toBe('active');
    expect(stateOf(sub({ currentPeriodEnd: new Date(NOW.getTime() - HOUR) }), NOW)).toBe('grace');
    expect(stateOf(sub({ currentPeriodEnd: new Date(NOW.getTime() - 5 * DAY) }), NOW)).toBe(
      'expired',
    );
    expect(stateOf(sub({ currentPeriodEnd: null }), NOW)).toBe('expired');
  });

  it('and an explicit `activated` is the same thing said out loud', () => {
    for (const end of [new Date(NOW.getTime() + DAY), new Date(NOW.getTime() - HOUR), null]) {
      expect(stateOf(sub({ currentPeriodEnd: end }), NOW)).toBe(
        stateOf(sub({ currentPeriodEnd: end, status: 'activated' }), NOW),
      );
    }
  });
});

describe('a decision outranks the calendar', () => {
  it('a business that never activated is pending, not expired', () => {
    /*
      The reason this state exists at all. With only the date rules, a shop
      that registered five minutes ago would be told its subscription had
      EXPIRED — confusing, and untrue.
    */
    expect(stateOf(sub({ status: 'pending_activation', currentPeriodEnd: null }), NOW)).toBe(
      'pending',
    );
  });

  it('suspension beats a live paid period', () => {
    expect(stateOf(sub({ status: 'suspended' }), NOW)).toBe('suspended');
  });

  it('suspension beats a complimentary grant too', () => {
    /*
      Otherwise suspending a shop that happens to hold a grant would silently
      do nothing — and a grant is exactly what a shop being tested would have.
    */
    const granted = sub({
      status: 'suspended',
      isComplimentary: true,
      complimentaryUntil: new Date(NOW.getTime() + 30 * DAY),
    });
    expect(stateOf(granted, NOW)).toBe('suspended');
  });

  it('cancellation beats everything', () => {
    expect(stateOf(sub({ status: 'cancelled' }), NOW)).toBe('cancelled');
  });

  it('a refused registration is rejected, not expired and not cancelled', () => {
    /*
      A shop told "no" was never a customer. `cancelled` would read as a
      subscription that once ran; `expired` as one that ran out. Neither is
      true, and the state says which one it is — whatever the dates or a
      stray grant might say.
    */
    expect(stateOf(sub({ status: 'rejected', currentPeriodEnd: null }), NOW)).toBe('rejected');
    expect(stateOf(sub({ status: 'rejected' }), NOW)).toBe('rejected');
    expect(
      stateOf(
        sub({ status: 'rejected', isComplimentary: true, complimentaryUntil: new Date(NOW.getTime() + 30 * DAY) }),
        NOW,
      ),
    ).toBe('rejected');
  });

  it('a status nobody recognises fails to `expired`, not to open', () => {
    /*
      This MySQL server runs with an EMPTY sql_mode, so a bad ENUM written
      outside Prisma is coerced to '' rather than refused. Falling through to
      the date logic would make a corrupted row behave as `activated` — the
      most permissive state there is, reached by accident.
    */
    const corrupt = sub({ status: '' as unknown as SubscriptionStatus });
    expect(stateOf(corrupt, NOW)).toBe('expired');
    expect(canWrite(stateOf(corrupt, NOW))).toBe(false);
  });
});

describe('what each state may do', () => {
  it('writes are accepted only while the shop is genuinely live', () => {
    expect(canWrite('active')).toBe(true);
    expect(canWrite('grace')).toBe(true);
    expect(canWrite('complimentary')).toBe(true);

    expect(canWrite('expired')).toBe(false);
    expect(canWrite('pending')).toBe(false);
    expect(canWrite('suspended')).toBe(false);
    expect(canWrite('cancelled')).toBe(false);
    expect(canWrite('rejected')).toBe(false);
  });

  it('EXPIRY still hides nothing', () => {
    // The rule that must survive this whole change.
    expect(canRead('expired')).toBe(true);
    expect(canRead('active')).toBe(true);
    expect(canRead('grace')).toBe(true);
    expect(canRead('complimentary')).toBe(true);
  });

  it('but the deliberate states close the operational app', () => {
    expect(canRead('pending')).toBe(false);
    expect(canRead('suspended')).toBe(false);
    expect(canRead('cancelled')).toBe(false);
    expect(canRead('rejected')).toBe(false);
  });
});

describe('a refused registration, as the client is told', () => {
  it('travels as its own state and status, and is never complimentary', () => {
    const e = buildEntitlement(
      sub({ status: 'rejected', currentPeriodEnd: null }),
      { seatsUsed: 0, activeBranchCount: 1 },
      NOW,
    );
    expect(e.state).toBe('rejected');
    expect(e.status).toBe('rejected');
    expect(e.canRead).toBe(false);
    expect(e.canWrite).toBe(false);
    expect(e.isComplimentary).toBe(false);
  });
});

describe('what the client is told', () => {
  it('the state and the status both travel, because they answer different questions', () => {
    const e = buildEntitlement(
      sub({ status: 'pending_activation', currentPeriodEnd: null }),
      { seatsUsed: 0, activeBranchCount: 1 },
      NOW,
    );
    expect(e.state).toBe('pending');
    expect(e.status).toBe('pending_activation');
    expect(e.canWrite).toBe(false);
    expect(e.canRead).toBe(false);
  });

  it('a pending business is never described as complimentary', () => {
    // It has been given nothing. Saying otherwise would read as a free trial.
    const e = buildEntitlement(
      sub({ status: 'pending_activation', currentPeriodEnd: null }),
      { seatsUsed: 0, activeBranchCount: 1 },
      NOW,
    );
    expect(e.isComplimentary).toBe(false);
  });

  it('an administrative grant reads as complimentary and can write', () => {
    const e = buildEntitlement(
      sub({
        status: 'activated',
        currentPeriodEnd: null,
        isComplimentary: true,
        complimentaryUntil: new Date(NOW.getTime() + 14 * DAY),
      }),
      { seatsUsed: 0, activeBranchCount: 1 },
      NOW,
    );
    expect(e.state).toBe('complimentary');
    expect(e.canWrite).toBe(true);
    expect(e.canRead).toBe(true);
  });

  it('a grant that has run out falls back to the paid period, not to pending', () => {
    // The two are separate facts, and an expired grant must not erase a period
    // the shop actually paid for.
    const e = buildEntitlement(
      sub({
        status: 'activated',
        currentPeriodEnd: new Date(NOW.getTime() + 3 * DAY),
        isComplimentary: true,
        complimentaryUntil: new Date(NOW.getTime() - DAY),
      }),
      { seatsUsed: 0, activeBranchCount: 1 },
      NOW,
    );
    expect(e.state).toBe('active');
  });
});
