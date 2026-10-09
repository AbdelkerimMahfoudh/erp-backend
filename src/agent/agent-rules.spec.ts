import { BadRequestException } from '@nestjs/common';
import { PAYER_NUMBER_MAX_DIGITS } from '../sales/payer-number';
import {
  assertFloatAmount,
  commissionOf,
  configRefusal,
  customerNumberFor,
  dayMovementOf,
  exchangeLegs,
  floatPosition,
  maskedCustomerNumber,
  missingConfigFields,
  negativesAfter,
  parseCustomerNumber,
  rateFor,
  readyForTransactions,
  rebalancingLegs,
  reversalLegs,
  sumLegs,
  withSameRate,
  type FloatAnchor,
  type Leg,
  type ProviderConfig,
} from './agent-rules';
import { aggregateAgentReport, type ReportRebalancingLeg, type ReportTransaction } from './agent-report-rules';

/**
 * The agent ledger's rules (docs/73 §4), pure. The worked example of §4.7 is
 * replayed at the end, event by event, through these same functions.
 */

const BANKILY = 'b0000000-0000-7000-8000-000000000001';
const SEDAD = 'b0000000-0000-7000-8000-000000000002';

/** The fixture configuration (docs/73 §4.7): 1.00 % both directions, settled apart, credited to the float. INVENTED. */
const fixture: ProviderConfig = {
  rateInBp: 100,
  rateOutBp: 100,
  sameRateBothDirections: true,
  commissionDestination: 'provider_float',
  principalFeeMode: 'separate',
  referenceRule: 'optional',
};

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('the configuration gates the provider (docs/73 §1.2)', () => {
  it('no version at all: every required field is missing, and the provider is not ready', () => {
    expect(missingConfigFields(null)).toEqual(['rateInBp', 'rateOutBp', 'commissionDestination', 'principalFeeMode', 'referenceRule']);
    expect(readyForTransactions(null)).toBe(false);
  });

  it('a blank is a blank, never zero: each missing field is named', () => {
    expect(missingConfigFields({ ...fixture, rateInBp: null, commissionDestination: null })).toEqual(['rateInBp', 'commissionDestination']);
    expect(readyForTransactions({ ...fixture, referenceRule: null })).toBe(false);
    expect(readyForTransactions(fixture)).toBe(true);
    // A rate of 0 is a figure the Owner typed, not a blank.
    expect(readyForTransactions({ ...fixture, rateInBp: 0, rateOutBp: 0 })).toBe(true);
  });

  it('one rate for both directions copies the typed rate; two rates stay two', () => {
    expect(withSameRate({ rateInBp: 150, rateOutBp: 20, sameRateBothDirections: true })).toEqual({ rateInBp: 150, rateOutBp: 150, sameRateBothDirections: true });
    expect(withSameRate({ rateInBp: 150, rateOutBp: 20, sameRateBothDirections: false })).toEqual({ rateInBp: 150, rateOutBp: 20, sameRateBothDirections: false });
    // A blank copied is still a blank.
    expect(withSameRate({ rateInBp: null, rateOutBp: 20, sameRateBothDirections: true }).rateOutBp).toBeNull();
  });

  it('a fee deducted from the principal can only land on the float; anything else is refused as a configuration', () => {
    expect(configRefusal({ principalFeeMode: 'deducted', commissionDestination: 'provider_float' })).toBeNull();
    expect(configRefusal({ principalFeeMode: 'deducted', commissionDestination: 'cash' })).toBe('deducted_destination');
    expect(configRefusal({ principalFeeMode: 'deducted', commissionDestination: 'held_separately' })).toBe('deducted_destination');
    expect(configRefusal({ principalFeeMode: 'deducted', commissionDestination: null })).toBe('deducted_destination');
    expect(configRefusal({ principalFeeMode: 'separate', commissionDestination: 'cash' })).toBeNull();
    expect(configRefusal({ principalFeeMode: null, commissionDestination: null })).toBeNull();
  });
});

describe('commission: the whole amount at the direction’s rate, to the cent (A4)', () => {
  it('reads the direction’s own rate', () => {
    const two = { rateInBp: 100, rateOutBp: 75 };
    expect(rateFor('cash_in_credit_out', two)).toBe(100);
    expect(rateFor('cash_out_credit_in', two)).toBe(75);
    expect(rateFor('cash_out_credit_in', { rateInBp: 100, rateOutBp: null })).toBeNull();
  });

  it('round2(amount × bp / 10 000): never brackets, never a guess', () => {
    expect(commissionOf(20_000, 100)).toBe(200);
    expect(commissionOf(15_000, 100)).toBe(150);
    expect(commissionOf(1_234.56, 150)).toBe(18.52);
    expect(commissionOf(333.33, 33)).toBe(1.1);
    expect(commissionOf(0.01, 100)).toBe(0);
    expect(commissionOf(50_000, 0)).toBe(0);
    expect(commissionOf(50_000, 10_000)).toBe(50_000);
  });

  it('a half cent always rounds up, whatever the amount’s binary form, and the largest amounts stay exact', () => {
    // 837 × 0.50 % = 4.185 and 879 × 0.50 % = 4.395: in floating point the first rounded down and the second up.
    expect(commissionOf(837, 50)).toBe(4.19);
    expect(commissionOf(879, 50)).toBe(4.4);
    expect(commissionOf(0.5, 100)).toBe(0.01);
    expect(commissionOf(999_999_999_999.99, 9_999)).toBe(999_899_999_999.99);
  });
});

describe('a rebalancing taking a known position below zero (docs/73 §4.7 row 4)', () => {
  const buy: Leg[] = [
    { account: 'cash', providerId: null, direction: 'outflow', amount: 100_000, kind: 'rebalancing' },
    { account: 'provider', providerId: 'bankily', direction: 'inflow', amount: 100_000, kind: 'rebalancing' },
  ];

  it('cash at 35 000 buying 100 000 of float reads −65 000; the float it fills is never asked', () => {
    const asked: string[] = [];
    const found = negativesAfter(buy, (account, providerId) => {
      asked.push(`${account}:${providerId}`);
      return account === 'cash' ? 35_000 : 50_000;
    });
    expect(found).toEqual([{ account: 'cash', providerId: null, position: 35_000, after: -65_000 }]);
    expect(asked).toEqual(['cash:null']);
  });

  it('an unknown position refuses nothing; exactly zero is not below it; nets per account across legs', () => {
    expect(negativesAfter(buy, () => null)).toEqual([]);
    expect(negativesAfter(buy, () => 100_000)).toEqual([]);
    const split: Leg[] = [
      { account: 'provider', providerId: 'bankily', direction: 'outflow', amount: 30_000, kind: 'rebalancing' },
      { account: 'provider', providerId: 'bankily', direction: 'outflow', amount: 30_000, kind: 'rebalancing' },
      { account: 'cash', providerId: null, direction: 'inflow', amount: 60_000, kind: 'rebalancing' },
    ];
    expect(negativesAfter(split, (a) => (a === 'provider' ? 50_000 : 0))).toEqual([{ account: 'provider', providerId: 'bankily', position: 50_000, after: -10_000 }]);
    const owner: Leg[] = [{ account: 'external', providerId: null, direction: 'outflow', amount: 5_000, kind: 'rebalancing' }, { account: 'cash', providerId: null, direction: 'inflow', amount: 5_000, kind: 'rebalancing' }];
    expect(negativesAfter(owner, () => 0)).toEqual([]);
  });
});

describe('the legs of an exchange (docs/73 §4.2–4.3)', () => {
  const leg = (account: Leg['account'], direction: Leg['direction'], amount: number, kind: Leg['kind'], providerId: string | null = BANKILY): Leg => ({
    account,
    providerId,
    direction,
    amount,
    kind,
  });

  it('Receive cash / Send credit, settled apart on the float: cash in A, float out A, float in C', () => {
    expect(exchangeLegs({ direction: 'cash_in_credit_out', amount: 20_000, commission: 200, providerId: BANKILY, commissionDestination: 'provider_float', principalFeeMode: 'separate' })).toEqual([
      leg('cash', 'inflow', 20_000, 'principal', null),
      leg('provider', 'outflow', 20_000, 'principal'),
      leg('provider', 'inflow', 200, 'commission'),
    ]);
  });

  it('Give cash / Receive credit, settled apart on the float: cash out A, float in A, float in C', () => {
    expect(exchangeLegs({ direction: 'cash_out_credit_in', amount: 15_000, commission: 150, providerId: SEDAD, commissionDestination: 'provider_float', principalFeeMode: 'separate' })).toEqual([
      leg('cash', 'outflow', 15_000, 'principal', null),
      leg('provider', 'inflow', 15_000, 'principal', SEDAD),
      leg('provider', 'inflow', 150, 'commission', SEDAD),
    ]);
  });

  it('commission to the drawer: the third leg is cash in C — the drawer’s agentIn', () => {
    const legs = exchangeLegs({ direction: 'cash_in_credit_out', amount: 10_000, commission: 100, providerId: BANKILY, commissionDestination: 'cash', principalFeeMode: 'separate' });
    expect(legs[2]).toEqual(leg('cash', 'inflow', 100, 'commission', null));
  });

  it('commission held by the provider: the third leg is on the commission_held account of that provider', () => {
    const legs = exchangeLegs({ direction: 'cash_out_credit_in', amount: 10_000, commission: 100, providerId: BANKILY, commissionDestination: 'held_separately', principalFeeMode: 'separate' });
    expect(legs[2]).toEqual(leg('commission_held', 'inflow', 100, 'commission'));
  });

  it('deducted by the provider: the float leg is netted (out A − C, in A + C) and no commission leg is written', () => {
    expect(exchangeLegs({ direction: 'cash_in_credit_out', amount: 20_000, commission: 200, providerId: BANKILY, commissionDestination: 'provider_float', principalFeeMode: 'deducted' })).toEqual([
      leg('cash', 'inflow', 20_000, 'principal', null),
      leg('provider', 'outflow', 19_800, 'principal'),
    ]);
    expect(exchangeLegs({ direction: 'cash_out_credit_in', amount: 20_000, commission: 200, providerId: BANKILY, commissionDestination: 'provider_float', principalFeeMode: 'deducted' })).toEqual([
      leg('cash', 'outflow', 20_000, 'principal', null),
      leg('provider', 'inflow', 20_200, 'principal'),
    ]);
  });

  it('the same figure either way: deducted leaves the float where separate does, by one netted leg instead of two', () => {
    const net = (legs: Leg[]) => legs.filter((l) => l.account === 'provider').reduce((n, l) => n + (l.direction === 'inflow' ? l.amount : -l.amount), 0);
    const apart = exchangeLegs({ direction: 'cash_in_credit_out', amount: 20_000, commission: 200, providerId: BANKILY, commissionDestination: 'provider_float', principalFeeMode: 'separate' });
    const netted = exchangeLegs({ direction: 'cash_in_credit_out', amount: 20_000, commission: 200, providerId: BANKILY, commissionDestination: 'provider_float', principalFeeMode: 'deducted' });
    expect(50_000 + net(apart)).toBe(30_200);
    expect(50_000 + net(netted)).toBe(30_200);
    expect(apart.filter((l) => l.account === 'provider')).toHaveLength(2);
    expect(netted.filter((l) => l.account === 'provider')).toHaveLength(1);
  });

  it('a refused configuration cannot post: deducted anywhere but the float is a defect, not a leg', () => {
    expect(() => exchangeLegs({ direction: 'cash_in_credit_out', amount: 100, commission: 1, providerId: BANKILY, commissionDestination: 'cash', principalFeeMode: 'deducted' })).toThrow(/deducted commission/);
  });

  it('a zero commission writes no leg; the principal legs stay', () => {
    const legs = exchangeLegs({ direction: 'cash_in_credit_out', amount: 100, commission: 0, providerId: BANKILY, commissionDestination: 'cash', principalFeeMode: 'separate' });
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.kind === 'principal')).toBe(true);
  });

  it('a reversal counters every leg once: same account, same amount, opposite direction, kind reversal (A7)', () => {
    const original = exchangeLegs({ direction: 'cash_in_credit_out', amount: 20_000, commission: 200, providerId: BANKILY, commissionDestination: 'provider_float', principalFeeMode: 'separate' });
    expect(reversalLegs(original)).toEqual([
      leg('cash', 'outflow', 20_000, 'reversal', null),
      leg('provider', 'inflow', 20_000, 'reversal'),
      leg('provider', 'outflow', 200, 'reversal'),
    ]);
    // Reversing the reversal's legs would give the original back: nothing is lost in the mirror.
    expect(reversalLegs(reversalLegs(original)).map((l) => [l.account, l.direction, l.amount])).toEqual(original.map((l) => [l.account, l.direction, l.amount]));
  });
});

describe('a rebalancing balances, or names an outside party for exactly the difference (A8)', () => {
  it('buy float with cash: cash out, float in, nets to zero', () => {
    const v = rebalancingLegs({ legs: [{ account: 'cash', direction: 'outflow', amount: 100_000 }, { account: 'provider', providerId: BANKILY, direction: 'inflow', amount: 100_000 }] });
    expect(v).toMatchObject({ ok: true, net: 0 });
    expect(v.ok && v.legs).toEqual([
      { account: 'cash', providerId: null, direction: 'outflow', amount: 100_000, kind: 'rebalancing' },
      { account: 'provider', providerId: BANKILY, direction: 'inflow', amount: 100_000, kind: 'rebalancing' },
    ]);
  });

  it('the Owner brings cash in: an outside party for the difference, written as a leg on the external account', () => {
    const v = rebalancingLegs({ legs: [{ account: 'cash', direction: 'inflow', amount: 50_000 }], externalCounterparty: 'owner_capital', externalAmount: 50_000 });
    expect(v).toMatchObject({ ok: true, net: 50_000 });
    expect(v.ok && v.legs[1]).toEqual({ account: 'external', providerId: null, direction: 'outflow', amount: 50_000, kind: 'rebalancing' });
  });

  it('the provider pays the held commission in cash: cash in C, held out C — balanced, no outside party', () => {
    const v = rebalancingLegs({ legs: [{ account: 'cash', direction: 'inflow', amount: 350 }, { account: 'commission_held', providerId: BANKILY, direction: 'outflow', amount: 350 }] });
    expect(v.ok).toBe(true);
  });

  it('money sent out to a provider: the difference is negative, the external leg flows in', () => {
    const v = rebalancingLegs({ legs: [{ account: 'provider', providerId: BANKILY, direction: 'outflow', amount: 1_000 }], externalCounterparty: 'provider_settlement', externalAmount: -1_000 });
    expect(v.ok && v.legs[1]).toMatchObject({ account: 'external', direction: 'inflow', amount: 1_000 });
  });

  it('refused: legs that do not net to zero with no outside party, or an outside amount that is not the difference', () => {
    expect(rebalancingLegs({ legs: [{ account: 'cash', direction: 'outflow', amount: 100 }, { account: 'provider', providerId: BANKILY, direction: 'inflow', amount: 90 }] })).toMatchObject({ ok: false, code: 'rebalancing_unbalanced' });
    expect(rebalancingLegs({ legs: [{ account: 'cash', direction: 'inflow', amount: 100 }], externalCounterparty: 'owner_capital', externalAmount: 90 })).toMatchObject({ ok: false, code: 'rebalancing_unbalanced' });
    expect(rebalancingLegs({ legs: [{ account: 'cash', direction: 'inflow', amount: 100 }], externalCounterparty: 'owner_capital', externalAmount: -100 })).toMatchObject({ ok: false, code: 'rebalancing_unbalanced' });
    expect(rebalancingLegs({ legs: [{ account: 'cash', direction: 'inflow', amount: 100 }], externalCounterparty: 'owner_capital' })).toMatchObject({ ok: false, code: 'rebalancing_unbalanced' });
    // Balanced legs name nobody outside: there is no difference to explain.
    expect(rebalancingLegs({ legs: [{ account: 'cash', direction: 'outflow', amount: 100 }, { account: 'provider', providerId: BANKILY, direction: 'inflow', amount: 100 }], externalCounterparty: 'other', externalAmount: 0 })).toMatchObject({ ok: false, code: 'rebalancing_unbalanced' });
  });

  it('refused: no legs, a zero or negative amount, a third decimal, a drawer with a provider, a float without one', () => {
    expect(rebalancingLegs({ legs: [] })).toMatchObject({ ok: false, code: 'rebalancing_legs_required' });
    expect(rebalancingLegs({ legs: [{ account: 'cash', direction: 'inflow', amount: 0 }] })).toMatchObject({ ok: false, code: 'rebalancing_leg_invalid' });
    expect(rebalancingLegs({ legs: [{ account: 'cash', direction: 'inflow', amount: -5 }] })).toMatchObject({ ok: false, code: 'rebalancing_leg_invalid' });
    expect(rebalancingLegs({ legs: [{ account: 'cash', direction: 'inflow', amount: 1.005 }] })).toMatchObject({ ok: false, code: 'rebalancing_leg_invalid' });
    expect(rebalancingLegs({ legs: [{ account: 'cash', providerId: BANKILY, direction: 'inflow', amount: 1 }] })).toMatchObject({ ok: false, code: 'rebalancing_leg_invalid' });
    expect(rebalancingLegs({ legs: [{ account: 'provider', direction: 'inflow', amount: 1 }] })).toMatchObject({ ok: false, code: 'rebalancing_leg_invalid' });
  });

  it('every verdict’s legs sum to zero — money never appears from nowhere', () => {
    for (const input of [
      { legs: [{ account: 'cash' as const, direction: 'outflow' as const, amount: 100 }, { account: 'provider' as const, providerId: BANKILY, direction: 'inflow' as const, amount: 100 }] },
      { legs: [{ account: 'cash' as const, direction: 'inflow' as const, amount: 100 }], externalCounterparty: 'owner_capital' as const, externalAmount: 100 },
      { legs: [{ account: 'cash' as const, direction: 'outflow' as const, amount: 30 }], externalCounterparty: 'other' as const, externalAmount: -30 },
    ]) {
      const v = rebalancingLegs(input);
      expect(v.ok).toBe(true);
      expect(v.ok && v.legs.reduce((n, l) => n + (l.direction === 'inflow' ? l.amount : -l.amount), 0)).toBe(0);
    }
  });
});

describe('a float’s position: the anchor plus the legs after its instant (docs/73 §4.4)', () => {
  const anchor: FloatAnchor = { amount: 50_000, at: new Date('2026-10-08T08:00:00Z'), businessDate: '2026-10-08', byName: 'Owner', source: 'set' };
  const legs = [
    { direction: 'outflow' as const, amount: 20_000, recordedAt: new Date('2026-10-08T09:00:00Z') },
    { direction: 'inflow' as const, amount: 200, recordedAt: new Date('2026-10-08T09:00:00Z') },
    // Before the anchor: already inside the amount the Owner read.
    { direction: 'inflow' as const, amount: 999, recordedAt: new Date('2026-10-08T07:59:59Z') },
    // At the anchor's exact instant: not after it.
    { direction: 'inflow' as const, amount: 1, recordedAt: anchor.at },
  ];

  it('counts strictly after the anchor, and not past the moment asked about', () => {
    expect(sumLegs(legs, anchor.at)).toEqual({ inflows: 200, outflows: 20_000 });
    expect(sumLegs(legs, anchor.at, new Date('2026-10-08T08:30:00Z'))).toEqual({ inflows: 0, outflows: 0 });
    expect(sumLegs(legs, null)).toEqual({ inflows: 1_200, outflows: 20_000 });
  });

  it('known: anchor + net; unknown: no anchor, null — never zero', () => {
    expect(floatPosition(anchor, sumLegs(legs, anchor.at))).toEqual({ known: true, position: 30_200, unknownReason: null, sinceAnchorNet: -19_800 });
    expect(floatPosition(null, sumLegs(legs, null))).toEqual({ known: false, position: null, unknownReason: 'no_anchor', sinceAnchorNet: null });
  });

  it('negative is shown as negative: more recorded out than in', () => {
    expect(floatPosition({ amount: 1_000 }, { inflows: 0, outflows: 1_500 })).toMatchObject({ known: true, position: -500 });
    expect(floatPosition({ amount: 0 }, { inflows: 0, outflows: 0 })).toMatchObject({ known: true, position: 0 });
  });

  it('the day’s movement is its own figure, position or no position', () => {
    expect(dayMovementOf('2026-10-08', { inflows: 15_150, outflows: 0 })).toEqual({ businessDate: '2026-10-08', inflows: 15_150, outflows: 0, net: 15_150 });
    expect(dayMovementOf('2026-10-08', { inflows: 0.1, outflows: 0.3 })).toEqual({ businessDate: '2026-10-08', inflows: 0.1, outflows: 0.3, net: -0.2 });
  });

  it('an amount set for a float is zero or more, to the cent', () => {
    expect(() => assertFloatAmount(0)).not.toThrow();
    expect(() => assertFloatAmount(40_000)).not.toThrow();
    for (const bad of [-1, 10.005, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = refusal(() => assertFloatAmount(bad));
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'amount_invalid' });
    }
  });
});

describe('the customer number: the payer number’s digit rule, mandatory, four digits at least (docs/73 §4.6)', () => {
  it('normalised as the payer number is, with the last four digits apart', () => {
    expect(parseCustomerNumber(' +222 36 12-34-56 ')).toEqual({ ok: true, value: '+22236123456', last4: '3456' });
    expect(parseCustomerNumber('٣٦١٢٣٤٥٦')).toEqual({ ok: true, value: '36123456', last4: '3456' });
    expect(parseCustomerNumber('1234')).toEqual({ ok: true, value: '1234', last4: '1234' });
    expect(parseCustomerNumber('+1234')).toEqual({ ok: true, value: '+1234', last4: '1234' });
  });

  it('refused: blank, letters, a misplaced +, fewer than four digits, more than the payer number’s most', () => {
    expect(parseCustomerNumber('')).toEqual({ ok: false, reason: 'missing' });
    expect(parseCustomerNumber(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(parseCustomerNumber('36A1')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseCustomerNumber('36+12')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseCustomerNumber('123')).toEqual({ ok: false, reason: 'too_short' });
    expect(parseCustomerNumber('+123')).toEqual({ ok: false, reason: 'too_short' });
    expect(parseCustomerNumber('1'.repeat(PAYER_NUMBER_MAX_DIGITS + 1))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('the refusal is 400 customer_number_invalid and names the problem, never the number', () => {
    for (const raw of ['', 'MR13 0002', '12', '9'.repeat(40)]) {
      const e = refusal(() => customerNumberFor(raw));
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'customer_number_invalid' });
      if (raw) expect(JSON.stringify((e as BadRequestException).getResponse())).not.toContain(raw.replace(/\s/g, ''));
    }
    expect(customerNumberFor('36 12 34 56')).toEqual({ value: '36123456', last4: '3456' });
  });

  it('masked: four bullets and the last four digits', () => {
    expect(maskedCustomerNumber('3456')).toBe('•••• 3456');
  });
});

/**
 * docs/73 §4.7, replayed. Fixture rates: 1.00 % both directions, settled apart,
 * credited to the float — invented. The drawer is the closing's: its figure here
 * is the opening plus the cash legs, exactly the two components the equation
 * gains (`agentIn` − `agentOut`). Each float is its anchor plus its legs.
 */
describe('the worked example of docs/73 §4.7, event by event', () => {
  const t = (hhmm: string) => new Date(`2026-10-08T${hhmm}:00Z`);
  const DAY = '2026-10-08';
  type Stored = Leg & { recordedAt: Date };
  const ledger: Stored[] = [];
  const post = (legs: Leg[], at: Date) => ledger.push(...legs.map((l) => ({ ...l, recordedAt: at })));
  const anchors: Record<string, FloatAnchor | null> = { [BANKILY]: { amount: 50_000, at: t('08:00'), businessDate: DAY, byName: 'Owner', source: 'set' }, [SEDAD]: null };
  const OPENING = 10_000;
  const drawer = () => OPENING + ledger.filter((l) => l.account === 'cash').reduce((n, l) => n + (l.direction === 'inflow' ? l.amount : -l.amount), 0);
  const float = (providerId: string) => {
    const anchor = anchors[providerId];
    const legs = ledger.filter((l) => l.account === 'provider' && l.providerId === providerId);
    return floatPosition(anchor, sumLegs(legs, anchor?.at ?? null));
  };
  const sedadDay = () => dayMovementOf(DAY, sumLegs(ledger.filter((l) => l.account === 'provider' && l.providerId === SEDAD), null));
  const transactions: ReportTransaction[] = [];
  const rebalancings: ReportRebalancingLeg[] = [];
  const figures = () => aggregateAgentReport({ period: 'day', from: DAY, to: DAY, transactions, rebalancingLegs: rebalancings }).totals;

  it('0 — the Owner sets: drawer 10 000, Bankily 50 000, Sedad unknown', () => {
    expect(drawer()).toBe(10_000);
    expect(float(BANKILY)).toMatchObject({ known: true, position: 50_000 });
    expect(float(SEDAD)).toMatchObject({ known: false, position: null, unknownReason: 'no_anchor' });
  });

  it('1 — Receive cash 20 000 / send Bankily credit: drawer 30 000, Bankily 30 200, commission 200, 1 / 20 000', () => {
    const commission = commissionOf(20_000, rateFor('cash_in_credit_out', fixture)!);
    post(exchangeLegs({ direction: 'cash_in_credit_out', amount: 20_000, commission, providerId: BANKILY, commissionDestination: 'provider_float', principalFeeMode: 'separate' }), t('09:00'));
    transactions.push({ providerId: BANKILY, providerLabel: 'Bankily', direction: 'cash_in_credit_out', amount: 20_000, commission, recordedById: 'u1', recordedByName: 'Aicha', businessDate: DAY, reversalDate: null });
    expect(commission).toBe(200);
    expect(drawer()).toBe(30_000);
    expect(float(BANKILY).position).toBe(30_200);
    expect(float(SEDAD).position).toBeNull();
    expect(figures()).toMatchObject({ count: 1, volume: 20_000, commission: 200, cashReceived: 20_000, creditSent: 20_000 });
  });

  it('2 — Give cash 15 000 / receive Sedad credit: drawer 15 000, Bankily 30 200, Sedad unknown with 15 150 moved today, commission 350, 2 / 35 000', () => {
    const commission = commissionOf(15_000, rateFor('cash_out_credit_in', fixture)!);
    post(exchangeLegs({ direction: 'cash_out_credit_in', amount: 15_000, commission, providerId: SEDAD, commissionDestination: 'provider_float', principalFeeMode: 'separate' }), t('10:00'));
    transactions.push({ providerId: SEDAD, providerLabel: 'Sedad', direction: 'cash_out_credit_in', amount: 15_000, commission, recordedById: 'u1', recordedByName: 'Aicha', businessDate: DAY, reversalDate: null });
    expect(drawer()).toBe(15_000);
    expect(float(BANKILY).position).toBe(30_200);
    expect(float(SEDAD)).toMatchObject({ known: false, position: null });
    expect(sedadDay()).toEqual({ businessDate: DAY, inflows: 15_150, outflows: 0, net: 15_150 });
    expect(figures()).toMatchObject({ count: 2, volume: 35_000, commission: 350, cashPaid: 15_000, creditReceived: 15_000 });
  });

  /*
   * The table prints the drawer at 35 000 after this reversal. Under its own rule (A7: every leg of the exchange gets
   * one counter-leg) the reversal takes the 20 000 the drawer received back OUT: 15 000 − 20 000 = −5 000, shown as
   * negative (A9), never hidden. The Bankily figure the table gives (50 000) is exactly that rule applied to the float,
   * so the 35 000 is a slip in the table's cash column, carried into its rows 4, 4' and 6; the rows below follow the
   * rule, and the slip is reported for the doc to correct.
   */
  it('3 — reversal of #1 (wrong direction): the drawer gives the 20 000 back (−5 000, shown as negative), Bankily 50 000, commission 150, 1 completed and 1 reversed / 15 000', () => {
    const original = ledger.filter((l) => l.recordedAt.getTime() === t('09:00').getTime());
    post(reversalLegs(original), t('11:00'));
    transactions[0] = { ...transactions[0], reversalDate: DAY };
    expect(drawer()).toBe(-5_000);
    expect(float(BANKILY).position).toBe(50_000);
    expect(float(SEDAD).position).toBeNull();
    expect(figures()).toMatchObject({ count: 1, volume: 15_000, commission: 150, reversals: { count: 1, volume: 20_000, commission: 200 } });
  });

  it('4 — buying 100 000 of Bankily float with cash: the rule balances; the drawer would go 100 000 further below zero, a figure shown as negative before the Owner confirms, never hidden', () => {
    const v = rebalancingLegs({ legs: [{ account: 'cash', direction: 'outflow', amount: 100_000 }, { account: 'provider', providerId: BANKILY, direction: 'inflow', amount: 100_000 }] });
    expect(v.ok).toBe(true);
    expect(drawer() - 100_000).toBe(-105_000);
    expect(figures()).toMatchObject({ count: 1, volume: 15_000, commission: 150 });
  });

  it("4' — the Owner brings 100 000 cash (owner_capital), then buys 100 000 of float: the drawer back where it was, Bankily 150 000, the figures unchanged", () => {
    const capital = rebalancingLegs({ legs: [{ account: 'cash', direction: 'inflow', amount: 100_000 }], externalCounterparty: 'owner_capital', externalAmount: 100_000 });
    const buy = rebalancingLegs({ legs: [{ account: 'cash', direction: 'outflow', amount: 100_000 }, { account: 'provider', providerId: BANKILY, direction: 'inflow', amount: 100_000 }] });
    expect(capital.ok && buy.ok).toBe(true);
    if (capital.ok) post(capital.legs, t('12:00'));
    if (buy.ok) post(buy.legs, t('12:05'));
    for (const [id, legs] of [['r1', capital.ok ? capital.legs : []], ['r2', buy.ok ? buy.legs : []]] as const) {
      rebalancings.push(...legs.map((l) => ({ rebalancingId: id, account: l.account, direction: l.direction, amount: l.amount, businessDate: DAY })));
    }
    expect(drawer()).toBe(-5_000);
    expect(float(BANKILY).position).toBe(150_000);
    expect(figures()).toMatchObject({ count: 1, volume: 15_000, commission: 150, rebalancings: { count: 2, cashIn: 100_000, cashOut: 100_000, floatIn: 100_000, floatOut: 0 } });
  });

  it('5 — Sedad set at 40 000 by the Owner at 14:00: 40 000 plus later movements; the morning’s 15 150 is inside the amount read', () => {
    anchors[SEDAD] = { amount: 40_000, at: t('14:00'), businessDate: DAY, byName: 'Owner', source: 'set' };
    expect(float(SEDAD)).toMatchObject({ known: true, position: 40_000, sinceAnchorNet: 0 });
    expect(sedadDay().net).toBe(15_150);
  });

  it('6 — the closing counts the floats: Bankily 149 900 (−100, a discrepancy), Sedad 40 000 (0); the drawer is expected at its tracked figure, negative and said so', () => {
    expect(149_900 - (float(BANKILY).position as number)).toBe(-100);
    expect(40_000 - (float(SEDAD).position as number)).toBe(0);
    expect(drawer()).toBeLessThan(0);
  });
});
