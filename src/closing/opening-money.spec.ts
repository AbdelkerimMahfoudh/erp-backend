import {
  isValidCashAmount,
  openingDecisionFor,
  openingFingerprint,
  openingFromSet,
  openingMethods,
  openingStateOf,
  reviewDecisionFor,
  setAdjustment,
  reviewableOpening,
  withDrawerKnown,
} from './opening-money';

/**
 * The money a shop opens with (docs/63): who decides, what a decision records,
 * and the arithmetic that makes a set amount true from its own instant — the
 * scenarios of the user's brief of 2026-09-28, as figures.
 */

const methods = (cash: number | null, accounts: (number | null)[] = [2000, 1600]) => [
  { key: 'cash', channel: 'cash' as const, accountId: null, label: '', scope: 'branch' as const, position: cash },
  ...accounts.map((position, i) => ({
    key: `account:a${i + 1}`,
    channel: 'account' as const,
    accountId: `a${i + 1}`,
    label: i === 0 ? 'Bankily' : 'Masrvi',
    scope: 'company' as const,
    position,
  })),
];

describe('who decides the money a shop opens with', () => {
  it('the Owner must choose — nothing is kept or zeroed on the Owner’s behalf', () => {
    expect(openingDecisionFor(undefined, true)).toEqual({ ok: false, status: 400, code: 'opening_amounts_required' });
    expect(openingDecisionFor({}, true)).toEqual({ ok: false, status: 400, code: 'opening_amounts_required' });
    expect(openingDecisionFor({ cashAmount: 0 }, true)).toEqual({ ok: false, status: 400, code: 'opening_amounts_required' });
  });

  it('keep takes no amount; set takes one, zero included when chosen', () => {
    expect(openingDecisionFor({ decision: 'keep' }, true)).toEqual({ ok: true, decision: 'keep', cashAmount: null });
    expect(openingDecisionFor({ decision: 'keep', cashAmount: 5 }, true)).toMatchObject({ ok: false, code: 'amount_not_expected' });
    expect(openingDecisionFor({ decision: 'set', cashAmount: 0 }, true)).toEqual({ ok: true, decision: 'set', cashAmount: 0 });
    expect(openingDecisionFor({ decision: 'set', cashAmount: 3400.5 }, true)).toEqual({ ok: true, decision: 'set', cashAmount: 3400.5 });
  });

  it.each([[undefined], [null], [-1], [1.234], [Number.NaN], [Number.POSITIVE_INFINITY]])('set with %s is refused as amount_invalid', (amount) => {
    expect(openingDecisionFor({ decision: 'set', cashAmount: amount as number }, true)).toMatchObject({ ok: false, status: 400, code: 'amount_invalid' });
  });

  it('anybody else who may open carries the tracked amounts, and may not set one', () => {
    expect(openingDecisionFor(undefined, false)).toEqual({ ok: true, decision: 'carried', cashAmount: null });
    expect(openingDecisionFor({ decision: 'keep' }, false)).toEqual({ ok: true, decision: 'carried', cashAmount: null });
    expect(openingDecisionFor({ decision: 'set', cashAmount: 10 }, false)).toEqual({ ok: false, status: 403, code: 'opening_amounts_owner_only' });
  });

  it('the Owner’s review takes the same two choices, always explicit', () => {
    expect(reviewDecisionFor(undefined)).toMatchObject({ ok: false, code: 'opening_amounts_required' });
    expect(reviewDecisionFor({ decision: 'keep' })).toEqual({ ok: true, decision: 'keep', cashAmount: null });
    expect(reviewDecisionFor({ decision: 'set', cashAmount: 250 })).toEqual({ ok: true, decision: 'set', cashAmount: 250 });
  });

  it('an amount is money: zero or more, two decimals at most', () => {
    expect(isValidCashAmount(0)).toBe(true);
    expect(isValidCashAmount(12_345_678.9)).toBe(true);
    expect(isValidCashAmount(-0.01)).toBe(false);
    expect(isValidCashAmount(0.001)).toBe(false);
    expect(isValidCashAmount('10')).toBe(false);
  });
});

describe('keep needs something to keep (2026-10-06)', () => {
  const keep = { ok: true as const, decision: 'keep' as const, cashAmount: null };
  const set = { ok: true as const, decision: 'set' as const, cashAmount: 0 };
  const carried = { ok: true as const, decision: 'carried' as const, cashAmount: null };

  it('an unknown drawer refuses keep by name; set and carried pass; a known drawer changes nothing', () => {
    expect(withDrawerKnown(keep, false)).toEqual({ ok: false, status: 400, code: 'opening_cash_unknown' });
    expect(withDrawerKnown(set, false)).toBe(set);
    expect(withDrawerKnown(carried, false)).toBe(carried);
    expect(withDrawerKnown(keep, true)).toBe(keep);
    const refusal = { ok: false as const, status: 400 as const, code: 'amount_invalid' as const };
    expect(withDrawerKnown(refusal, false)).toBe(refusal);
  });

  it('what the Owner may review: a carried opening, an opening that left the drawer unknown, or an open day with no decision and an unknown drawer', () => {
    const day = { opened: true, drawerKnown: true };
    expect(reviewableOpening({ decision: 'carried', cashKnown: true, reviewed: false }, day)).toBe('opening');
    expect(reviewableOpening({ decision: 'carried', cashKnown: false, reviewed: false }, day)).toBe('opening');
    expect(reviewableOpening({ decision: 'keep', cashKnown: false, reviewed: false }, day)).toBe('opening');
    expect(reviewableOpening({ decision: 'keep', cashKnown: true, reviewed: false }, day)).toBeNull();
    expect(reviewableOpening({ decision: 'set', cashKnown: true, reviewed: false }, day)).toBeNull();
    expect(reviewableOpening({ decision: 'carried', cashKnown: false, reviewed: true }, day)).toBeNull();
    expect(reviewableOpening(null, { opened: true, drawerKnown: false })).toBe('day');
    expect(reviewableOpening(null, { opened: false, drawerKnown: false })).toBeNull();
    expect(reviewableOpening(null, { opened: true, drawerKnown: true })).toBeNull();
  });
});

describe('what an opening records: every method as it was seen, the total when all are known', () => {
  it('3 400 cash + 3 600 across the accounts = 7 000, kept as shown', () => {
    const r = openingMethods(methods(3400), { decision: 'keep', amount: 3400 });
    expect(r.total).toBe(7000);
    expect(r.methods.map((m) => [m.key, m.previous, m.amount, m.set, m.scope])).toEqual([
      ['cash', 3400, 3400, false, 'branch'],
      ['account:a1', 2000, 2000, false, 'company'],
      ['account:a2', 1600, 1600, false, 'company'],
    ]);
  });

  it('set: only the shop’s cash changes; the company’s accounts carry forward', () => {
    const r = openingMethods(methods(3400), { decision: 'set', amount: 1000 });
    expect(r.methods[0]).toMatchObject({ previous: 3400, amount: 1000, set: true });
    expect(r.methods.slice(1).every((m) => !m.set && m.amount === m.previous)).toBe(true);
    expect(r.total).toBe(4600);
  });

  it('cash set to 0 is a chosen zero, and the total still counts the accounts', () => {
    expect(openingMethods(methods(3400), { decision: 'set', amount: 0 }).total).toBe(3600);
    // Every method at zero — the cash here, the accounts by the Owner's company-wide action — is 0.
    expect(openingMethods(methods(3400, [0, 0]), { decision: 'set', amount: 0 }).total).toBe(0);
  });

  it('an unknown method leaves no total; keep leaves unknown cash unknown', () => {
    const r = openingMethods(methods(null), { decision: 'keep', amount: null });
    expect(r.methods[0]).toMatchObject({ previous: null, amount: null, set: false });
    expect(r.total).toBeNull();
    expect(openingMethods(methods(3400, [2000, null]), { decision: 'keep', amount: 3400 }).total).toBeNull();
    // Setting the cash makes it known; an unknown account still leaves no total.
    expect(openingMethods(methods(null, [2000, null]), { decision: 'set', amount: 500 }).total).toBeNull();
    expect(openingMethods(methods(null), { decision: 'set', amount: 500 }).total).toBe(4100);
  });
});

describe('a set amount is true from its own instant — never backdated, nothing counted twice', () => {
  /** The Daily closing's expected cash for a day: opening + the day's net + the set term. */
  const expected = (opening: number, dayNet: number, set?: { amount: number; dayNetAt: number }) =>
    Math.round((opening + dayNet + (set ? setAdjustment(set, opening) : 0)) * 100) / 100;

  it('carried with no movement: 3 400 stays 3 400 — kept as shown changes nothing', () => {
    expect(expected(3400, 0, { amount: 3400, dayNetAt: 0 })).toBe(3400);
    expect(expected(3400, 0)).toBe(3400);
  });

  it('set at the morning opening, then movement after it: the amount plus what came after', () => {
    // 3 000 set at 08:05 with nothing recorded yet; a 500 cash sale and a 120 cash expense afterwards.
    expect(expected(3400, 380, { amount: 3000, dayNetAt: 0 })).toBe(3380);
  });

  it('a sale recorded before the opening is never added twice (the rollout day)', () => {
    // 200 in cash sold at 07:30, before anybody opened; the drawer counted and set to 3 200 at 08:05; +500 after.
    expect(expected(3000, 700, { amount: 3200, dayNetAt: 200 })).toBe(3700);
  });

  it('a reopen after a counted close continues from the count, not from the day’s earlier expected figure', () => {
    // Expected 3 450 at the close, counted 3 400 (a 50 shortage already recorded); reopened keeping the count; +300 after.
    const openingOfDay = 1000;
    const dayNetAtReopen = 2450;
    expect(expected(openingOfDay, dayNetAtReopen + 300, { amount: 3400, dayNetAt: dayNetAtReopen })).toBe(3700);
  });

  it('the opening cancels out: however the day was carried in, the figure starts from the amount set', () => {
    for (const opening of [0, 1234.5, 99_999]) {
      expect(expected(opening, 250, { amount: 1000, dayNetAt: 0 })).toBe(1250);
    }
  });

  it('carried to later days: the amount, what its day recorded after it, and every whole day between', () => {
    // Set to 2 000 on the 27th when the day had moved 300; the 27th ended at +800; the 28th moved −150.
    expect(openingFromSet({ amount: 2000, dayNetAt: 300 }, 800 - 150)).toBe(2350);
    expect(openingFromSet({ amount: 0, dayNetAt: 0 }, 0)).toBe(0);
  });
});

describe('where the day’s opening stands', () => {
  it('none, the Owner’s, awaiting the Owner’s review, or reviewed', () => {
    expect(openingStateOf(null)).toBe('none');
    expect(openingStateOf({ decision: 'keep', reviewed: false })).toBe('owner_decided');
    expect(openingStateOf({ decision: 'set', reviewed: false })).toBe('owner_decided');
    expect(openingStateOf({ decision: 'carried', reviewed: false })).toBe('awaiting_owner_review');
    expect(openingStateOf({ decision: 'carried', reviewed: true })).toBe('reviewed');
  });
});

describe('a request key is bound to its request', () => {
  const base = { op: 'opening' as const, date: null, mode: 'continue', decision: 'set' as const, cashAmount: 2500 };

  it('the same request is the same fingerprint; any other field is another request', () => {
    expect(openingFingerprint(base)).toBe(openingFingerprint({ ...base }));
    expect(openingFingerprint({ ...base, cashAmount: 2500.004 })).toBe(openingFingerprint(base));
    expect(openingFingerprint({ ...base, cashAmount: 2600 })).not.toBe(openingFingerprint(base));
    expect(openingFingerprint({ ...base, decision: 'keep', cashAmount: null })).not.toBe(openingFingerprint(base));
    expect(openingFingerprint({ ...base, mode: 'start_new' })).not.toBe(openingFingerprint(base));
    expect(openingFingerprint({ ...base, op: 'review' })).not.toBe(openingFingerprint(base));
  });
});
