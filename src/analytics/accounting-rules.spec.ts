import {
  affectsCash,
  affectsProfit,
  cashMovement,
  compare,
  EFFECT_OF,
  precedingPeriod,
  profit,
  type BusinessEvent,
} from './accounting-rules';

/**
 * The accounting identities (Milestone L).
 *
 * These are the sentences a shop's trust rests on. Every one of them is easy to
 * get wrong in a SQL query and impossible to notice afterwards, because a wrong
 * profit figure looks exactly like a right one.
 */

describe('a return is counted once', () => {
  it('moves profit at APPROVAL', () => {
    expect(affectsProfit('return_approved')).toBe(true);
    // Nothing has left the till yet — the customer has not been paid.
    expect(affectsCash('return_approved')).toBe(false);
  });

  it('and NOT again when the refund is paid', () => {
    /*
      The mistake this prevents: reversing revenue at approval and again at
      payment, which would show the shop losing the sale twice.
    */
    expect(affectsProfit('refund_confirmed')).toBe(false);
    expect(affectsCash('refund_confirmed')).toBe(true);
  });

  it('and a reported refund does nothing at all', () => {
    expect(affectsProfit('refund_reported')).toBe(false);
    expect(affectsCash('refund_reported')).toBe(false);
    expect(EFFECT_OF.refund_reported.balance).toBe(false);
  });

  it('gives the cost back as well as the revenue', () => {
    /*
      A phone that came back is a phone the shop still has. Charging its cost
      against an undone sale would understate profit twice over.
    */
    const p = profit({
      grossSales: 100_000,
      returnsRevenue: 20_000,
      cogs: 70_000,
      returnsCogs: 14_000,
      expenses: 0,
    });
    expect(p.netRevenue).toBe(80_000);
    expect(p.netCogs).toBe(56_000);
    expect(p.grossProfit).toBe(24_000);
  });
});

describe('a supplier settlement is cash, not cost', () => {
  it('receiving stock creates a liability and no expense', () => {
    expect(affectsProfit('purchase_received')).toBe(false);
    expect(EFFECT_OF.purchase_received.balance).toBe(true);
  });

  it('paying the supplier moves cash and the liability, never profit', () => {
    // The cost reaches profit through COGS when the goods sell. Counting it
    // here as well would charge the shop for the same phone twice.
    expect(affectsProfit('supplier_payment_confirmed')).toBe(false);
    expect(affectsCash('supplier_payment_confirmed')).toBe(true);
    expect(EFFECT_OF.supplier_payment_confirmed.balance).toBe(true);
  });
});

describe('lending is not earning', () => {
  it('a loan principal is neither revenue nor expense', () => {
    // A shop that lent 20 000 is not 20 000 poorer, and one that borrowed it is
    // not 20 000 richer. Both are balance-sheet movements.
    expect(affectsProfit('loan_principal')).toBe(false);
    expect(EFFECT_OF.loan_principal.balance).toBe(true);
  });

  it('nor is repaying one', () => {
    expect(affectsProfit('loan_payment_confirmed')).toBe(false);
    expect(affectsCash('loan_payment_confirmed')).toBe(true);
  });

  it('a consignment balance settles without touching profit', () => {
    // Profit was taken at disposition, when the consigned phone actually sold.
    expect(affectsProfit('consignment_disposition')).toBe(true);
    expect(affectsProfit('consignment_payment_confirmed')).toBe(false);
    expect(affectsCash('consignment_payment_confirmed')).toBe(true);
  });
});

describe('a closing discrepancy is not profit', () => {
  it('moves nothing on its own', () => {
    /*
      A shortage is a question — who counted, what is missing — and becomes an
      employee debt or a written-off difference through its own workflow. Rolling
      it into profit would hide it inside a number nobody investigates.
    */
    expect(affectsProfit('closing_discrepancy')).toBe(false);
    expect(affectsCash('closing_discrepancy')).toBe(false);
    expect(EFFECT_OF.closing_discrepancy.balance).toBe(false);
  });
});

describe('expenses', () => {
  it('a confirmed expense reduces profit and cash', () => {
    expect(affectsProfit('expense_confirmed')).toBe(true);
    expect(affectsCash('expense_confirmed')).toBe(true);
  });

  it('and comes off gross profit to give the operating result', () => {
    const p = profit({
      grossSales: 50_000,
      returnsRevenue: 0,
      cogs: 30_000,
      returnsCogs: 0,
      expenses: 8_000,
    });
    expect(p.grossProfit).toBe(20_000);
    expect(p.netOperatingProfit).toBe(12_000);
  });
});

describe('cash is a different question from profit', () => {
  it('sums every confirmed outflow', () => {
    const c = cashMovement({
      salesReceived: 100_000,
      refundsPaid: 5_000,
      supplierPaymentsConfirmed: 40_000,
      expensesCash: 8_000,
      otherOutflows: 2_000,
    });
    expect(c.inflow).toBe(100_000);
    expect(c.outflow).toBe(55_000);
    expect(c.net).toBe(45_000);
  });

  it('can be negative in a profitable week', () => {
    /*
      Sold well, paid three suppliers, refunded a customer. Presenting cash as
      profit — or profit as cash — is the most misleading thing a retail report
      can do, which is why they are separate figures on separate rows.
    */
    const c = cashMovement({
      salesReceived: 10_000,
      refundsPaid: 3_000,
      supplierPaymentsConfirmed: 20_000,
      expensesCash: 1_000,
      otherOutflows: 0,
    });
    expect(c.net).toBeLessThan(0);
  });
});

describe('comparison never invents a percentage', () => {
  it('compares against the previous period', () => {
    const c = compare(150, 100);
    expect(c).toMatchObject({ available: true, previous: 100, change: 50, changePercent: 50 });
  });

  it('reports a fall as a negative change', () => {
    const c = compare(50, 100);
    expect(c).toMatchObject({ available: true, change: -50, changePercent: -50 });
  });

  it('refuses to divide by a zero base', () => {
    // "Up 100%" from nothing is a division nobody checked, and a shop would
    // read it as a result.
    const c = compare(500, 0);
    expect(c.available).toBe(false);
    expect(c.available === false && c.reason).toBe('no_previous_activity');
  });

  it('handles both being zero without pretending anything happened', () => {
    expect(compare(0, 0).available).toBe(false);
  });

  it('uses the magnitude of a negative base rather than flipping the sign', () => {
    // Going from -100 to -50 is an improvement, and must not read as -50%.
    const c = compare(-50, -100);
    expect(c.available === true && c.changePercent).toBe(50);
  });
});

describe('the preceding period is the same length and does not overlap', () => {
  it('a seven-day window compares with the seven days before it', () => {
    expect(precedingPeriod('2026-08-08', '2026-08-14')).toEqual({
      from: '2026-08-01',
      to: '2026-08-07',
    });
  });

  it('a single day compares with the day before', () => {
    expect(precedingPeriod('2026-08-18', '2026-08-18')).toEqual({
      from: '2026-08-17',
      to: '2026-08-17',
    });
  });

  it('never shares a day with the window it follows', () => {
    // An off-by-one here would count one day twice in every comparison the app
    // shows, and the error would be invisible.
    const prev = precedingPeriod('2026-03-01', '2026-03-31');
    expect(prev.to).toBe('2026-02-28');
    expect(prev.from).toBe('2026-01-29');
  });

  it('crosses a month boundary correctly', () => {
    expect(precedingPeriod('2026-01-01', '2026-01-07')).toEqual({
      from: '2025-12-25',
      to: '2025-12-31',
    });
  });
});

describe('every event explains itself', () => {
  it('so the table can be read without the code around it', () => {
    for (const [event, effect] of Object.entries(EFFECT_OF)) {
      expect(effect.why.length).toBeGreaterThan(30);
      expect(typeof effect.profit).toBe('boolean');
    }
  });

  it('covers every event the app can record', () => {
    const events: BusinessEvent[] = [
      'sale',
      'return_approved',
      'refund_reported',
      'refund_confirmed',
      'purchase_received',
      'supplier_payment_confirmed',
      'expense_confirmed',
      'consignment_disposition',
      'consignment_payment_confirmed',
      'loan_principal',
      'loan_payment_confirmed',
      'closing_discrepancy',
    ];
    for (const e of events) expect(EFFECT_OF[e]).toBeDefined();
  });
});
