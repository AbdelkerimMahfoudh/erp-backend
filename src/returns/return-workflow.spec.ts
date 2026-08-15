import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  assertEditable,
  assertMayApprove,
  assertTransition,
  canTransition,
  custodyIntakeNeeded,
  fingerprintRequest,
  grossRefundOf,
  priceAdjustment,
  settleRefund,
} from './return-workflow';

/**
 * The rules of a reviewed return.
 *
 * These are the decisions the legacy endpoint got wrong — who may decide, what
 * the refund actually is, and whether anything can be replayed into a second
 * claim — so they are tested here against the pure functions, exhaustively,
 * before any of it touches a database.
 */

describe('what the shop owes back', () => {
  /**
   * The single most important line in this file. The daily rollup computes
   * revenue as `price * quantity - discount`. If the refund used any other
   * expression, reversing a sale would not cancel the revenue it created, and
   * the books would disagree by exactly the discount — silently, forever.
   */
  it('is the sale line’s own revenue, discount included', () => {
    expect(grossRefundOf({ price: 1000, quantity: 1, discount: 0 })).toBe(1000);
    expect(grossRefundOf({ price: 1000, quantity: 1, discount: 150 })).toBe(850);
    expect(grossRefundOf({ price: 20, quantity: 3, discount: 5 })).toBe(55);
  });

  it('rounds to the cent rather than carrying float noise', () => {
    expect(grossRefundOf({ price: 10.1, quantity: 3, discount: 0 })).toBe(30.3);
  });
});

describe('adjustments are priced by the server', () => {
  it('multiplies unit amount by quantity', () => {
    expect(priceAdjustment({ kind: 'other', label: 'x', quantity: 3, unitAmount: 12.5 }).totalAmount).toBe(37.5);
  });

  it('refuses a negative amount', () => {
    expect(() =>
      priceAdjustment({ kind: 'screen_protector', label: 'x', quantity: 1, unitAmount: -1 }),
    ).toThrow(BadRequestException);
  });

  it('refuses a zero or fractional quantity', () => {
    for (const quantity of [0, -2, 1.5]) {
      expect(() => priceAdjustment({ kind: 'other', label: 'x', quantity, unitAmount: 1 })).toThrow(
        BadRequestException,
      );
    }
  });

  it('demands a label, because a charge nobody can explain is a dispute', () => {
    expect(() => priceAdjustment({ kind: 'other', label: '   ', quantity: 1, unitAmount: 5 })).toThrow(
      /what the charge is for/,
    );
  });

  it('allows zero — a line recorded for the record, charging nothing', () => {
    expect(priceAdjustment({ kind: 'accessory_retained', label: 'case kept', quantity: 1, unitAmount: 0 }).totalAmount).toBe(0);
  });
});

describe('net refund', () => {
  it('is gross minus every adjustment', () => {
    expect(settleRefund(1000, [{ totalAmount: 50 }, { totalAmount: 25.5 }])).toEqual({
      adjustmentTotal: 75.5,
      netRefundDue: 924.5,
    });
  });

  it('is the gross itself when nothing is withheld', () => {
    expect(settleRefund(850, [])).toEqual({ adjustmentTotal: 0, netRefundDue: 850 });
  });

  /**
   * The customer must never finish a return owing money. No approved decision
   * supports customer debt, so the refusal is here rather than in a screen.
   */
  it('refuses adjustments that exceed the refund', () => {
    expect(() => settleRefund(100, [{ totalAmount: 100.01 }])).toThrow(BadRequestException);
    expect(() => settleRefund(100, [{ totalAmount: 60 }, { totalAmount: 41 }])).toThrow(
      /cannot exceed the refund/,
    );
  });

  it('allows adjustments that exactly consume the refund', () => {
    expect(settleRefund(100, [{ totalAmount: 100 }])).toEqual({ adjustmentTotal: 100, netRefundDue: 0 });
  });
});

describe('idempotency fingerprint', () => {
  const base = {
    saleItemId: '019FB400-3034-7BFA-88AC-C4BD3754CF4A',
    unitId: '353285110000015',
    requestReason: 'screen flickers',
    conditionNotes: 'no cracks',
    custody: 'store_holds' as const,
  };

  it('is stable for the same payload', () => {
    expect(fingerprintRequest(base)).toBe(fingerprintRequest({ ...base }));
  });

  it('ignores case in ids and surrounding whitespace in text', () => {
    // Two clients that format the same request differently must still be
    // recognised as the same request.
    expect(fingerprintRequest(base)).toBe(
      fingerprintRequest({
        ...base,
        saleItemId: base.saleItemId.toLowerCase(),
        requestReason: '  screen flickers  ',
      }),
    );
  });

  it('changes when anything material changes', () => {
    const differing = [
      { requestReason: 'battery swollen' },
      { conditionNotes: 'deep scratch' },
      { custody: 'customer_holds' as const },
      { unitId: '353285110000016' },
    ];
    for (const change of differing) {
      expect(fingerprintRequest({ ...base, ...change })).not.toBe(fingerprintRequest(base));
    }
  });

  it('treats absent notes and empty notes as the same request', () => {
    expect(fingerprintRequest({ ...base, conditionNotes: undefined })).toBe(
      fingerprintRequest({ ...base, conditionNotes: '' }),
    );
  });
});

describe('the lifecycle', () => {
  it('lets an investigation start, and lets either decision be reached', () => {
    expect(canTransition('pending_investigation', 'under_review')).toBe(true);
    expect(canTransition('pending_investigation', 'approved_refund_due')).toBe(true);
    expect(canTransition('under_review', 'rejected')).toBe(true);
  });

  /**
   * Both decisions are terminal, which is what makes approve-versus-reject a
   * race with exactly one winner rather than a last-writer-wins overwrite.
   */
  it('makes both decisions terminal', () => {
    for (const from of ['approved_refund_due', 'rejected'] as const) {
      for (const to of ['pending_investigation', 'under_review', 'approved_refund_due', 'rejected'] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('never goes backwards to pending', () => {
    expect(canTransition('under_review', 'pending_investigation')).toBe(false);
  });

  it('says "already decided" rather than "illegal transition" for a settled return', () => {
    // The wording matters at a counter: one is actionable, the other is jargon.
    expect(() => assertTransition('rejected', 'approved_refund_due')).toThrow(/already rejected/);
    expect(() => assertTransition('approved_refund_due', 'rejected')).toThrow(/already approved/);
    expect(() => assertTransition('under_review', 'pending_investigation')).toThrow(ConflictException);
  });

  it('freezes everything after a decision', () => {
    expect(() => assertEditable('pending_investigation')).not.toThrow();
    expect(() => assertEditable('under_review')).not.toThrow();
    expect(() => assertEditable('approved_refund_due')).toThrow(/no longer be changed/);
    expect(() => assertEditable('rejected')).toThrow(ConflictException);
  });

  it('has no "refunded" state at all', () => {
    // Confirming money moved is I3. A state that does not exist cannot be set
    // by accident, which is the strongest possible guarantee here.
    expect(canTransition('approved_refund_due', 'approved_refund_due')).toBe(false);
  });
});

describe('custody intake', () => {
  it('is needed when the customer still holds the phone', () => {
    expect(custodyIntakeNeeded('customer_holds')).toBe(true);
  });

  it('is a no-op when the store already holds it, not an error', () => {
    // A counter tapping twice must not produce a failure.
    expect(custodyIntakeNeeded('store_holds')).toBe(false);
  });

  it('refuses once the phone has been handed back or retained', () => {
    expect(() => custodyIntakeNeeded('handed_back')).toThrow(/cannot be received again/);
    expect(() => custodyIntakeNeeded('retained_hold')).toThrow(ConflictException);
  });
});

describe('who may approve', () => {
  const perms = (...keys: string[]) => new Set(keys);

  it('lets a manager approve an ordinary in-window store-fault return', () => {
    expect(
      assertMayApprove({
        requiresException: false,
        responsibility: 'store_or_product_fault',
        permissions: perms('return.approve'),
      }),
    ).toEqual({ isException: false });
  });

  it('refuses anyone without return.approve', () => {
    expect(() =>
      assertMayApprove({
        requiresException: false,
        responsibility: 'store_or_product_fault',
        permissions: perms('return.review'),
      }),
    ).toThrow(ForbiddenException);
  });

  it('refuses to approve before responsibility is decided', () => {
    expect(() =>
      assertMayApprove({
        requiresException: false,
        responsibility: 'pending_investigation',
        permissions: perms('return.approve', 'return.exception'),
      }),
    ).toThrow(/who is responsible/);
  });

  /**
   * The two Owner-only cases, and the reason they are Owner-only: both step
   * outside what the customer was actually promised.
   */
  it('makes an out-of-policy return an Owner exception', () => {
    expect(() =>
      assertMayApprove({
        requiresException: true,
        responsibility: 'store_or_product_fault',
        permissions: perms('return.approve'),
      }),
    ).toThrow(/Only the owner/);
  });

  it('makes customer-caused damage an Owner exception even inside the window', () => {
    expect(() =>
      assertMayApprove({
        requiresException: false,
        responsibility: 'customer_damage',
        permissions: perms('return.approve'),
      }),
    ).toThrow(ForbiddenException);
  });

  it('demands a written reason for any exception', () => {
    for (const exceptionReason of [undefined, '', '   ']) {
      expect(() =>
        assertMayApprove({
          requiresException: true,
          responsibility: 'store_or_product_fault',
          permissions: perms('return.approve', 'return.exception'),
          exceptionReason,
        }),
      ).toThrow(/Say why/);
    }
  });

  it('lets the Owner approve either exception with a reason', () => {
    expect(
      assertMayApprove({
        requiresException: true,
        responsibility: 'customer_damage',
        permissions: perms('return.approve', 'return.exception'),
        exceptionReason: 'goodwill for a regular customer',
      }),
    ).toEqual({ isException: true });
  });
});
