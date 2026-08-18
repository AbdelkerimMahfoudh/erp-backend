import {
  assertDecision,
  assertForgivenessAllowed,
  assertPaymentAllowed,
  BALANCE_EFFECT,
  breakdown,
  creditorIs,
  directionFor,
  fingerprintPayment,
  forgivenessIsCash,
  GROUP_OF,
  invert,
  LoanRefused,
  paymentAffectsProfit,
  principalAffectsProfit,
  remaining,
  type LedgerRow,
  type LoanStatus,
} from './loan-rules';

/**
 * Money loans (Milestone I).
 *
 * The properties under test are the three that make a two-party debt record
 * trustworthy: direction is data, the principal is agreed rather than asserted,
 * and lending money is not income.
 */

const refuses = (fn: () => unknown, matching?: RegExp) => {
  expect(fn).toThrow(LoanRefused);
  if (matching) expect(fn).toThrow(matching);
};

describe('direction is data, never a sign', () => {
  it('inverts for the other party', () => {
    expect(invert('they_owe_us')).toBe('we_owe_them');
    expect(invert('we_owe_them')).toBe('they_owe_us');
  });

  it('shows each side the direction from THEIR point of view', () => {
    /**
     * One row, two readings. Two mirrored rows could disagree about who owes
     * whom, and no amount of care would make that safe.
     */
    const loan = { companyId: 'A', direction: 'they_owe_us' as const };
    expect(directionFor(loan, 'A')).toBe('they_owe_us');
    expect(directionFor(loan, 'B')).toBe('we_owe_them');
  });

  it('never encodes direction in the amount', () => {
    /**
     * Every ledger effect is +1, 0 or -1 applied to a POSITIVE magnitude. If a
     * negative amount ever became meaningful, a correction would silently
     * reverse who owes whom.
     */
    for (const effect of Object.values(BALANCE_EFFECT)) {
      expect([-1, 0, 1]).toContain(effect);
    }
  });

  it('decides the creditor from the direction, not from who created the record', () => {
    expect(creditorIs({ companyId: 'A', direction: 'they_owe_us' })).toBe('owner');
    expect(creditorIs({ companyId: 'A', direction: 'we_owe_them' })).toBe('counterparty');
  });
});

describe('confirmed means the balance reached zero', () => {
  it('does NOT include merely agreeing the debt exists', () => {
    expect(GROUP_OF.accepted).toBe('accepted');
    expect(GROUP_OF.partially_paid).toBe('accepted');
  });

  it('counts only paid, written off, and closed', () => {
    const confirmed = (Object.keys(GROUP_OF) as LoanStatus[]).filter((s) => GROUP_OF[s] === 'confirmed');
    expect(confirmed.sort()).toEqual(['cancelled', 'forgiven_settled', 'settled'].sort());
  });
});

describe('nobody accepts their own offer', () => {
  it('refuses accepting an offer you made', () => {
    /**
     * Without this, one side could propose 20 000 and immediately accept it,
     * producing a debt the other party never agreed to — the entire thing the
     * proposal step exists to prevent.
     */
    refuses(
      () => assertDecision({ action: 'accept', from: 'proposed', isOwnOffer: true }),
      /waiting on the other side/,
    );
  });

  it('refuses countering your own offer', () => {
    refuses(() => assertDecision({ action: 'counter', from: 'counter_proposed', isOwnOffer: true, amount: 100 }));
  });

  it('lets the other side accept it', () => {
    expect(assertDecision({ action: 'accept', from: 'proposed', isOwnOffer: false })).toBe('accepted');
  });

  it('walks the worked example: 20 000 proposed, 18 000 countered, proposer decides', () => {
    // The recipient counters.
    expect(
      assertDecision({ action: 'counter', from: 'proposed', isOwnOffer: false, amount: 18000 }),
    ).toBe('counter_proposed');
    // Now the ORIGINAL proposer answers — and the counter is not theirs.
    expect(
      assertDecision({ action: 'accept', from: 'counter_proposed', isOwnOffer: false }),
    ).toBe('accepted');
  });
});

describe('a counter and a dispute have to say something', () => {
  it('a counter needs an amount', () => {
    refuses(() => assertDecision({ action: 'counter', from: 'proposed', isOwnOffer: false }), /needs an amount/);
  });

  it('a dispute needs a reason', () => {
    refuses(
      () => assertDecision({ action: 'dispute', from: 'proposed', isOwnOffer: false, reason: '  ' }),
      /what you disagree with/,
    );
  });

  it('an accepted loan can no longer be disputed', () => {
    // The principal is immutable once agreed; disagreement afterwards is a
    // correction or a write-off, not a re-negotiation.
    refuses(() => assertDecision({ action: 'dispute', from: 'accepted', isOwnOffer: false, reason: 'no' }));
  });
});

describe('a report is not a payment', () => {
  it('moves the balance by nothing', () => {
    expect(BALANCE_EFFECT.payment_reported).toBe(0);
    const rows: LedgerRow[] = [
      { kind: 'principal_accepted', amount: 18000 },
      { kind: 'payment_reported', amount: 5000 },
    ];
    expect(remaining(rows)).toBe(18000);
  });

  it('is still visible, so nobody thinks it was lost', () => {
    const rows: LedgerRow[] = [
      { kind: 'principal_accepted', amount: 18000 },
      { kind: 'payment_reported', amount: 5000 },
    ];
    expect(breakdown(rows).awaitingConfirmation).toBe(5000);
  });

  it('settles only once confirmed', () => {
    const rows: LedgerRow[] = [
      { kind: 'principal_accepted', amount: 18000 },
      { kind: 'payment_reported', amount: 5000 },
      { kind: 'payment_confirmed', amount: 5000 },
    ];
    expect(remaining(rows)).toBe(13000);
  });

  it('stops waiting once the creditor has answered it', () => {
    /*
      The whole point of the figure is "what is still unanswered". Totalling
      every report ever made left a payment that had already arrived showing as
      outstanding forever, and the shop would go and chase it.
    */
    const rows: LedgerRow[] = [
      { kind: 'principal_accepted', amount: 18000, id: 'p' },
      { kind: 'payment_reported', amount: 5000, id: 'r1' },
      { kind: 'payment_confirmed', amount: 5000, id: 'c1', refersToId: 'r1' },
    ];
    expect(breakdown(rows).awaitingConfirmation).toBe(0);
    expect(breakdown(rows).remaining).toBe(13000);
  });

  it('waits only on the report nobody answered, even out of order', () => {
    // The second report is confirmed first. Positional pairing would have
    // credited the wrong one and reported the wrong amount as waiting.
    const rows: LedgerRow[] = [
      { kind: 'principal_accepted', amount: 18000, id: 'p' },
      { kind: 'payment_reported', amount: 5000, id: 'r1' },
      { kind: 'payment_reported', amount: 2000, id: 'r2' },
      { kind: 'payment_confirmed', amount: 2000, id: 'c1', refersToId: 'r2' },
    ];
    expect(breakdown(rows).awaitingConfirmation).toBe(5000);
  });

  it('does not start waiting again when a confirmed payment is reversed', () => {
    /*
      The report was answered; reversing the confirmation puts the DEBT back,
      which `payment_corrected` already carries. Reviving the report as well
      would ask the creditor to confirm a payment they have just rejected.
    */
    const rows: LedgerRow[] = [
      { kind: 'principal_accepted', amount: 18000, id: 'p' },
      { kind: 'payment_reported', amount: 5000, id: 'r1' },
      { kind: 'payment_confirmed', amount: 5000, id: 'c1', refersToId: 'r1' },
      { kind: 'payment_corrected', amount: 5000, id: 'x1', refersToId: 'c1' },
    ];
    expect(breakdown(rows).awaitingConfirmation).toBe(0);
    expect(breakdown(rows).remaining).toBe(18000);
  });

  it('a correction puts the debt back rather than erasing the claim', () => {
    const rows: LedgerRow[] = [
      { kind: 'principal_accepted', amount: 18000 },
      { kind: 'payment_confirmed', amount: 5000 },
      { kind: 'payment_corrected', amount: 5000 },
    ];
    expect(remaining(rows)).toBe(18000);
    expect(breakdown(rows).corrected).toBe(5000);
  });
});

describe('the exact arithmetic', () => {
  it('adds up a whole history', () => {
    const rows: LedgerRow[] = [
      { kind: 'principal_accepted', amount: 18000 },
      { kind: 'payment_confirmed', amount: 5000 },
      { kind: 'payment_confirmed', amount: 3000 },
      { kind: 'forgiven', amount: 2000 },
    ];
    expect(remaining(rows)).toBe(8000);
  });

  it('explains itself rather than asserting a number', () => {
    const rows: LedgerRow[] = [
      { kind: 'principal_accepted', amount: 18000 },
      { kind: 'payment_confirmed', amount: 5000 },
      { kind: 'forgiven', amount: 3000 },
    ];
    expect(breakdown(rows)).toMatchObject({
      principal: 18000,
      confirmedPaid: 5000,
      forgiven: 3000,
      remaining: 10000,
    });
  });

  it('reads an empty ledger as nothing owed', () => {
    expect(remaining([])).toBe(0);
  });
});

describe('paying and writing off', () => {
  const pay = { amount: 5000, method: 'cash' as const, remaining: 18000 };
  const forgive = { amount: 5000, reason: 'Long friendship', remaining: 18000 };

  it('accepts a partial payment and an exact one', () => {
    expect(() => assertPaymentAllowed(pay)).not.toThrow();
    expect(() => assertPaymentAllowed({ ...pay, amount: 18000 })).not.toThrow();
  });

  it('refuses paying more than is owed', () => {
    refuses(() => assertPaymentAllowed({ ...pay, amount: 18001 }), /more than the 18000/);
  });

  it('makes an account payment name its account, and cash name none', () => {
    refuses(() => assertPaymentAllowed({ ...pay, method: 'account' }), /which account/);
    refuses(() => assertPaymentAllowed({ ...pay, receivingAccountId: 'a1' }), /does not go to an account/);
  });

  it('always requires a reason to write off', () => {
    refuses(() => assertForgivenessAllowed({ ...forgive, reason: '   ' }), /why/);
  });

  it('refuses writing off more than is left', () => {
    refuses(() => assertForgivenessAllowed({ ...forgive, amount: 18001 }), /only 18000 left/);
  });
});

describe('a loan is not income and not a cost', () => {
  it('the principal never touches profit', () => {
    /**
     * Lending money is a balance-sheet movement. Recognising it as income would
     * make a shop that lent 20 000 look 20 000 more profitable, which is
     * exactly backwards.
     */
    expect(principalAffectsProfit()).toBe(false);
  });

  it('and neither does a repayment', () => {
    // Money arriving looks like income to anybody reading a bank line. It is
    // the debt being settled, and the profit effect is zero in both directions.
    expect(paymentAffectsProfit()).toBe(false);
  });

  it('forgiveness is not cash', () => {
    /**
     * Recording it as a sale would invent revenue; recording it as an operating
     * expense would bury a credit decision among electricity bills.
     */
    expect(forgivenessIsCash()).toBe(false);
  });
});

describe('a queued report cannot lie about its own payload', () => {
  const payment = {
    loanId: '018f0000-0000-7000-8000-000000000001',
    amount: 5000,
    method: 'cash',
    reference: 'Handed over Thursday',
  };

  it('the same payload fingerprints the same, so a retry is a retry', () => {
    expect(fingerprintPayment(payment)).toBe(fingerprintPayment({ ...payment }));
  });

  it('a changed amount fingerprints differently', () => {
    /*
      The offline case this exists for: a queued 5 000 report is edited to 8 000
      and keeps its key. Without this, the server would answer about the 5 000
      and the phone would show "synced" — so the shop would believe it had
      reported a figure the server never saw.
    */
    expect(fingerprintPayment({ ...payment, amount: 8000 })).not.toBe(fingerprintPayment(payment));
  });

  it('so does a changed method, account, reference or evidence', () => {
    const base = fingerprintPayment(payment);
    expect(fingerprintPayment({ ...payment, method: 'account' })).not.toBe(base);
    expect(fingerprintPayment({ ...payment, receivingAccountId: 'acc-1' })).not.toBe(base);
    expect(fingerprintPayment({ ...payment, reference: 'Something else' })).not.toBe(base);
    expect(fingerprintPayment({ ...payment, evidenceRef: 'photo.jpg' })).not.toBe(base);
  });

  it('but surrounding whitespace does not, because that is the same report', () => {
    expect(fingerprintPayment({ ...payment, reference: '  Handed over Thursday  ' })).toBe(
      fingerprintPayment(payment),
    );
  });

  it('and 5000 written as 5000.00 is the same payment', () => {
    expect(fingerprintPayment({ ...payment, amount: 5000.0 })).toBe(fingerprintPayment(payment));
  });

  it('a different loan with identical numbers is a different report', () => {
    expect(
      fingerprintPayment({ ...payment, loanId: '018f0000-0000-7000-8000-000000000002' }),
    ).not.toBe(fingerprintPayment(payment));
  });
});
