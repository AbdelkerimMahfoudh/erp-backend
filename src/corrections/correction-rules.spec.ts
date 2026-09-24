import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  assertDayOpen,
  assertDecidable,
  assertNoOpenRequest,
  assertNotAlreadyCorrected,
  assertReasonGiven,
  assertTargetCorrectable,
  fingerprintCorrection,
  assertReclassifiable,
} from './correction-rules';

/**
 * The rules that decide whether already-settled money gets un-settled.
 *
 * Each is asserted for what it refuses as much as what it allows — the refusals
 * are the safety property.
 */

describe('only a confirmed payment can be corrected', () => {
  it('accepts a confirmed one', () => {
    expect(() => assertTargetCorrectable({ status: 'confirmed' })).not.toThrow();
  });

  /**
   * A reported payment has moved no money and settled no liability, so there is
   * nothing to compensate. Sending one through here would post a compensating
   * movement for cash that never left — inventing money.
   */
  it('REFUSES one that is only reported', () => {
    expect(() => assertTargetCorrectable({ status: 'reported' })).toThrow(ConflictException);
    expect(() => assertTargetCorrectable({ status: 'reported_pending_confirmation' })).toThrow(
      ConflictException,
    );
  });

  it('refuses a target that does not exist', () => {
    expect(() => assertTargetCorrectable(null)).toThrow(BadRequestException);
  });
});

describe('a correction happens at most once', () => {
  it('refuses a second correction on an already-corrected payment', () => {
    expect(() => assertNotAlreadyCorrected([{ status: 'approved' }])).toThrow(ConflictException);
  });

  it('allows a fresh request when earlier ones were rejected', () => {
    expect(() =>
      assertNotAlreadyCorrected([{ status: 'rejected' }, { status: 'rejected' }]),
    ).not.toThrow();
  });

  it('refuses a second OPEN request, so an owner is never asked twice', () => {
    expect(() => assertNoOpenRequest([{ status: 'requested' }])).toThrow(ConflictException);
  });

  it('allows a new request once the previous one was rejected', () => {
    expect(() => assertNoOpenRequest([{ status: 'rejected' }])).not.toThrow();
  });
});

describe('a reason is mandatory', () => {
  it('keeps the trimmed reason', () => {
    expect(assertReasonGiven('  paid the wrong supplier  ')).toBe('paid the wrong supplier');
  });

  it('refuses blank and whitespace alike', () => {
    expect(() => assertReasonGiven('')).toThrow(BadRequestException);
    expect(() => assertReasonGiven('   ')).toThrow(BadRequestException);
    expect(() => assertReasonGiven(undefined)).toThrow(BadRequestException);
  });
});

describe('only an open request can be decided', () => {
  it('allows deciding a requested one', () => {
    expect(() => assertDecidable({ status: 'requested' })).not.toThrow();
  });

  /**
   * Not a silent no-op: the first decision may already have moved money, so a
   * second one is a conflict the caller has to see.
   */
  it('refuses re-deciding, and says which way it went', () => {
    expect(() => assertDecidable({ status: 'approved' })).toThrow(/already approved/);
    expect(() => assertDecidable({ status: 'rejected' })).toThrow(/already rejected/);
  });
});

describe('the compensating movement never reopens a closed day', () => {
  it('allows an open day', () => {
    expect(() => assertDayOpen({ isLocked: false }, '2026-08-15')).not.toThrow();
  });

  it('allows a day with no closing at all', () => {
    expect(() => assertDayOpen(null, '2026-08-15')).not.toThrow();
  });

  /**
   * The single most important refusal in this milestone. Slotting a movement
   * into a filed closing would rewrite a day the shop already counted and
   * signed off — the exact thing the append-only design exists to prevent.
   */
  it('REFUSES a locked day, and names it', () => {
    expect(() => assertDayOpen({ isLocked: true }, '2026-08-15')).toThrow(ConflictException);
    expect(() => assertDayOpen({ isLocked: true }, '2026-08-15')).toThrow(/2026-08-15/);
  });

  it('uses the same conflict code as the other confirmation guards', () => {
    // So the mobile handler recognises it without a second branch.
    try {
      assertDayOpen({ isLocked: true }, '2026-08-15');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ConflictException).getResponse()).toMatchObject({ code: 'day_already_closed' });
    }
  });
});

describe('idempotency fingerprint', () => {
  const base = {
    targetKind: 'refund_payout' as const,
    targetId: '0192f1a0-0000-7000-8000-000000000001',
    reason: 'wrong account',
  };

  it('is stable for the same payload', () => {
    expect(fingerprintCorrection(base)).toBe(fingerprintCorrection({ ...base }));
  });

  it('ignores surrounding whitespace, so a retry is still a retry', () => {
    expect(fingerprintCorrection({ ...base, reason: '  wrong account  ' })).toBe(
      fingerprintCorrection(base),
    );
  });

  /**
   * The reason a fingerprint exists at all: the same key with a DIFFERENT
   * payload is not a retry, it is a second correction wearing the first one's
   * id, and the service turns this difference into a 409.
   */
  it('changes when the target changes', () => {
    expect(
      fingerprintCorrection({ ...base, targetId: '0192f1a0-0000-7000-8000-000000000002' }),
    ).not.toBe(fingerprintCorrection(base));
  });

  it('changes when the reason changes', () => {
    expect(fingerprintCorrection({ ...base, reason: 'duplicate payment' })).not.toBe(
      fingerprintCorrection(base),
    );
  });

  it('distinguishes the two target kinds', () => {
    expect(fingerprintCorrection({ ...base, targetKind: 'supplier_settlement' })).not.toBe(
      fingerprintCorrection(base),
    );
  });
});

describe('reclassifying a payment to the channel it really reached (0078)', () => {
  const cashPayment = { amount: 10_000, fromMethod: 'cash' as const, fromAccountId: null };
  const toBankily = { toMethod: 'account' as const, toAccountId: 'bankily', toAccountActive: true };
  const code = (f: () => void) => {
    try {
      f();
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return ((e as BadRequestException).getResponse() as { code: string }).code;
    }
  };

  it('moves all or part of a payment to another channel', () => {
    expect(code(() => assertReclassifiable(cashPayment, toBankily, 10_000))).toBeNull();
    expect(code(() => assertReclassifiable(cashPayment, toBankily, 4_000))).toBeNull();
    expect(code(() => assertReclassifiable({ amount: 8_000, fromMethod: 'account', fromAccountId: 'bankily' }, { toMethod: 'cash', toAccountId: null, toAccountActive: true }, 8_000))).toBeNull();
    expect(code(() => assertReclassifiable({ amount: 8_000, fromMethod: 'account', fromAccountId: 'bankily' }, { toMethod: 'account', toAccountId: 'masrivi', toAccountActive: true }, 8_000))).toBeNull();
  });

  it('refuses moving nothing, or more than was paid', () => {
    expect(code(() => assertReclassifiable(cashPayment, toBankily, 0))).toBe('amount_required');
    expect(code(() => assertReclassifiable(cashPayment, toBankily, 10_000.01))).toBe('amount_above_payment');
  });

  it('refuses moving money to the channel it is already in', () => {
    expect(code(() => assertReclassifiable(cashPayment, { toMethod: 'cash', toAccountId: null, toAccountActive: true }, 1_000))).toBe('same_channel');
    expect(code(() => assertReclassifiable({ amount: 5_000, fromMethod: 'account', fromAccountId: 'bankily' }, toBankily, 1_000))).toBe('same_channel');
  });

  it('refuses a destination that could not have been recorded', () => {
    expect(code(() => assertReclassifiable(cashPayment, { toMethod: 'cash', toAccountId: 'bankily', toAccountActive: true }, 1_000))).toBe('cash_has_no_account');
    expect(code(() => assertReclassifiable(cashPayment, { toMethod: 'account', toAccountId: null, toAccountActive: true }, 1_000))).toBe('account_required');
    expect(code(() => assertReclassifiable(cashPayment, { ...toBankily, toAccountActive: false }, 1_000))).toBe('account_inactive');
  });

  it('where the money goes is part of the request: a retry to another channel is not a retry', () => {
    const base = { targetKind: 'sale_payment' as const, targetId: 'p1', reason: 'Paid by Bankily' };
    expect(fingerprintCorrection({ ...base, toMethod: 'account', toAccountId: 'bankily', amount: 4_000 })).not.toBe(
      fingerprintCorrection({ ...base, toMethod: 'account', toAccountId: 'masrivi', amount: 4_000 }),
    );
    expect(fingerprintCorrection({ ...base, toMethod: 'account', toAccountId: 'bankily', amount: 4_000 })).not.toBe(
      fingerprintCorrection({ ...base, toMethod: 'account', toAccountId: 'bankily', amount: 5_000 }),
    );
  });
});
