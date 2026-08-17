import {
  assertForgivenessAllowed,
  assertPaymentAllowed,
  BALANCE_EFFECT,
  breakdown,
  destinationCostBasis,
  forgivenessIsCash,
  MoneyRefused,
  outstanding,
  paymentAffectsProfit,
  sourceAccounting,
  type LedgerRow,
} from './consignment-money';

/**
 * Consignment money (H-CP4).
 *
 * Both properties under test are ways of counting once: the balance is derived
 * rather than stored, and profit is recognised at disposition and never again
 * when the payment arrives.
 */

const refuses = (fn: () => unknown, matching?: RegExp) => {
  expect(fn).toThrow(MoneyRefused);
  if (matching) expect(fn).toThrow(matching);
};

describe('a report is not a payment', () => {
  it('moves the balance by nothing at all', () => {
    /**
     * A report is a claim that money moved. Until the creditor confirms it,
     * nothing has settled — the same two-party rule refunds and supplier
     * settlements already follow.
     */
    expect(BALANCE_EFFECT.payment_reported).toBe(0);
    const rows: LedgerRow[] = [
      { kind: 'receivable_raised', amount: 900 },
      { kind: 'payment_reported', amount: 400 },
    ];
    expect(outstanding(rows)).toBe(900);
  });

  it('is still visible, so nobody thinks it was lost', () => {
    const rows: LedgerRow[] = [
      { kind: 'receivable_raised', amount: 900 },
      { kind: 'payment_reported', amount: 400 },
    ];
    expect(breakdown(rows).awaitingConfirmation).toBe(400);
  });

  it('settles only once confirmed', () => {
    const rows: LedgerRow[] = [
      { kind: 'receivable_raised', amount: 900 },
      { kind: 'payment_reported', amount: 400 },
      { kind: 'payment_confirmed', amount: 400 },
    ];
    expect(outstanding(rows)).toBe(500);
  });
});

describe('correcting a confirmed payment puts the debt back', () => {
  it('adds the amount to what is owed', () => {
    /**
     * Exactly as Milestone B's corrections restore a settled liability. A
     * correction that merely deleted the payment would leave no trace that
     * anybody had ever claimed it arrived.
     */
    expect(BALANCE_EFFECT.payment_corrected).toBe(1);
    const rows: LedgerRow[] = [
      { kind: 'receivable_raised', amount: 900 },
      { kind: 'payment_confirmed', amount: 400 },
      { kind: 'payment_corrected', amount: 400 },
    ];
    expect(outstanding(rows)).toBe(900);
  });

  it('keeps both entries in the breakdown', () => {
    const rows: LedgerRow[] = [
      { kind: 'receivable_raised', amount: 900 },
      { kind: 'payment_confirmed', amount: 400 },
      { kind: 'payment_corrected', amount: 400 },
    ];
    const b = breakdown(rows);
    expect(b.confirmedPaid).toBe(400);
    expect(b.corrected).toBe(400);
  });
});

describe('the balance is derived, never stored', () => {
  it('adds up a whole history', () => {
    const rows: LedgerRow[] = [
      { kind: 'receivable_raised', amount: 1000 },
      { kind: 'payment_confirmed', amount: 300 },
      { kind: 'payment_confirmed', amount: 200 },
      { kind: 'forgiven', amount: 100 },
    ];
    expect(outstanding(rows)).toBe(400);
  });

  it('reads an empty ledger as nothing owed', () => {
    expect(outstanding([])).toBe(0);
  });

  it('explains itself rather than merely asserting a number', () => {
    const rows: LedgerRow[] = [
      { kind: 'receivable_raised', amount: 1000 },
      { kind: 'payment_confirmed', amount: 300 },
      { kind: 'forgiven', amount: 200 },
    ];
    expect(breakdown(rows)).toMatchObject({
      raised: 1000,
      confirmedPaid: 300,
      forgiven: 200,
      outstanding: 500,
    });
  });
});

describe('paying', () => {
  const base = { amount: 100, method: 'cash' as const, outstanding: 500 };

  it('accepts a partial payment', () => {
    expect(() => assertPaymentAllowed(base)).not.toThrow();
  });

  it('accepts settling exactly', () => {
    expect(() => assertPaymentAllowed({ ...base, amount: 500 })).not.toThrow();
  });

  it('refuses more than is owed', () => {
    /**
     * Catches the ordinary mistake — the same payment entered twice — before it
     * turns into the creditor apparently owing the debtor money.
     */
    refuses(() => assertPaymentAllowed({ ...base, amount: 501 }), /more than the 500/);
  });

  it('refuses zero and negative', () => {
    refuses(() => assertPaymentAllowed({ ...base, amount: 0 }));
    refuses(() => assertPaymentAllowed({ ...base, amount: -5 }));
  });

  it('makes an account payment name its account', () => {
    refuses(() => assertPaymentAllowed({ ...base, method: 'account' }), /which account/);
    expect(() =>
      assertPaymentAllowed({ ...base, method: 'account', receivingAccountId: 'a1' }),
    ).not.toThrow();
  });

  it('refuses cash claiming an account, as the database does', () => {
    refuses(() => assertPaymentAllowed({ ...base, receivingAccountId: 'a1' }));
  });
});

describe('writing it off', () => {
  const base = { amount: 100, reason: 'Long-standing partner', outstanding: 500 };

  it('always needs a reason', () => {
    /**
     * A write-off nobody can explain is indistinguishable from money quietly
     * going missing.
     */
    refuses(() => assertForgivenessAllowed({ ...base, reason: '   ' }), /why/);
    refuses(() => assertForgivenessAllowed({ ...base, reason: null }));
  });

  it('cannot exceed what is left', () => {
    refuses(() => assertForgivenessAllowed({ ...base, amount: 501 }), /only 500 left/);
  });

  it('may clear the balance entirely', () => {
    expect(() => assertForgivenessAllowed({ ...base, amount: 500 })).not.toThrow();
  });

  it('is NOT cash', () => {
    /**
     * Treating it as cash would make a till balance against money that never
     * arrived; treating it as an ordinary expense would bury a credit decision
     * among electricity bills.
     */
    expect(forgivenessIsCash()).toBe(false);
  });
});

describe('profit is recognised once, at disposition', () => {
  it('gives the source the agreed amount as revenue and its own cost as COGS', () => {
    /**
     * Revenue is the agreed amount, never Store 2's resale price — which Store
     * 1 never learns. COGS is Store 1's own unit cost, which Store 2 never
     * learns. Each side computes its own margin from a figure the other cannot
     * see.
     */
    expect(sourceAccounting(900, 700)).toEqual({ revenue: 900, cogs: 700, grossProfit: 200 });
  });

  it('gives the destination the agreed amount as its cost basis', () => {
    expect(destinationCostBasis(900)).toBe(900);
  });

  it('makes the destination margin correct by construction', () => {
    // Sold at 1100 having "cost" 900 → 200. Store 1's real 700 never appears.
    const resale = 1100;
    expect(resale - destinationCostBasis(900)).toBe(200);
  });

  it('and the PAYMENT does not touch profit', () => {
    /**
     * The single thing most likely to be "fixed" by somebody who sees cash
     * arriving and assumes income. Profit happened at disposition; this is
     * settlement. Milestone E spent a whole checkpoint closing the same trap
     * for the till.
     */
    expect(paymentAffectsProfit()).toBe(false);
  });

  it('handles a consignment sold at cost without inventing a loss', () => {
    expect(sourceAccounting(700, 700).grossProfit).toBe(0);
  });

  it('reports a real loss when the agreed amount is below cost', () => {
    // Clearing old stock at a loss is a decision, not an error to hide.
    expect(sourceAccounting(600, 700).grossProfit).toBe(-100);
  });
});
