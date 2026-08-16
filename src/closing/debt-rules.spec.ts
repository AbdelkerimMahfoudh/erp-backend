import {
  assertEntryAllowed,
  balanceOf,
  opensDiscrepancy,
  planResolution,
  RuleViolation,
  type DebtEntryKind,
} from './debt-rules';

/**
 * The rules that decide what happens after a till does not balance (E-CP2).
 *
 * The E0 audit found `difference` was a number on a locked row — no
 * investigation, no decision, no record of who was held responsible. These pin
 * the decisions that replaced it, especially the ones that protect the person
 * on the wrong end of a shortage.
 */

const refuses = (fn: () => unknown, matching?: RegExp) => {
  expect(fn).toThrow(RuleViolation);
  if (matching) expect(fn).toThrow(matching);
};

describe('what somebody owes is derived, never stored', () => {
  it('charges add, and everything else subtracts', () => {
    expect(
      balanceOf([
        { kind: 'charge', amount: 500 },
        { kind: 'repayment', amount: 200 },
        { kind: 'deduction', amount: 100 },
        { kind: 'forgiveness', amount: 50 },
      ]),
    ).toBe(150);
  });

  it('an empty ledger owes nothing', () => {
    expect(balanceOf([])).toBe(0);
  });

  it('over-repayment shows as negative rather than being swallowed', () => {
    /**
     * If the shop has taken more than it was owed, that must be visible. A
     * `Math.max(0, …)` here would hide the shop owing an employee money, which
     * is the error worth seeing most.
     */
    expect(balanceOf([{ kind: 'charge', amount: 100 }, { kind: 'repayment', amount: 130 }])).toBe(-30);
  });
});

describe('resolving a discrepancy', () => {
  const base = { resolution: 'store_absorbed' as const, reason: 'Investigated; no cause found', amount: -250 };

  it('always requires a reason', () => {
    refuses(() => planResolution({ ...base, reason: null }), /requires a reason/);
    refuses(() => planResolution({ ...base, reason: '   ' }), /requires a reason/);
  });

  it('the business absorbing the loss writes no ledger row', () => {
    expect(planResolution(base)).toEqual([]);
  });

  it('a record being wrong writes no ledger row either', () => {
    expect(planResolution({ ...base, resolution: 'error_corrected', reason: 'Sale entered twice' })).toEqual([]);
  });

  it('holding somebody responsible requires naming them', () => {
    refuses(
      () => planResolution({ ...base, resolution: 'employee_debt', responsibleUserId: null }),
      /requires naming them/,
    );
  });

  it('naming somebody and then absorbing the loss is refused', () => {
    /**
     * That combination records an accusation that led to nothing. If a person
     * was involved and the shop still absorbed it, the reason says so.
     */
    refuses(() => planResolution({ ...base, responsibleUserId: 'u1' }), /does not name a person/);
  });

  it('charges the shortage as a magnitude, not as a negative', () => {
    expect(planResolution({ ...base, resolution: 'employee_debt', responsibleUserId: 'u1' })).toEqual([
      { kind: 'charge', amount: 250 },
    ]);
  });

  it('a SURPLUS can never become a debt', () => {
    /**
     * Nobody owes the business money for having too much of it. Unexplained
     * extra cash is a mis-recorded sale until somebody shows otherwise — that
     * is an investigation, not a charge.
     */
    refuses(
      () => planResolution({ ...base, amount: 250, resolution: 'employee_debt', responsibleUserId: 'u1' }),
      /not a debt/,
    );
  });

  it('a surplus may still be absorbed or corrected', () => {
    expect(planResolution({ ...base, amount: 250 })).toEqual([]);
  });

  it('forgiving writes BOTH the charge and the waiver', () => {
    /**
     * Recording only the waiver would leave no trace that anything was ever
     * short. An owner should be able to see somebody came up short three times
     * even when every one was forgiven.
     */
    const rows = planResolution({ ...base, resolution: 'forgiven', responsibleUserId: 'u1' });
    expect(rows).toEqual([
      { kind: 'charge', amount: 250 },
      { kind: 'forgiveness', amount: 250 },
    ]);
    expect(balanceOf(rows as { kind: DebtEntryKind; amount: number }[])).toBe(0);
  });

  it('there is nothing to resolve when nothing was out', () => {
    refuses(() => planResolution({ ...base, amount: 0 }), /nothing to resolve/);
  });
});

describe('writing a ledger entry directly', () => {
  const base = { kind: 'repayment' as const, amount: 100, reason: 'Paid back in cash', method: 'cash' as const, outstanding: 250 };

  it('always requires a reason', () => {
    refuses(() => assertEntryAllowed({ ...base, reason: '  ' }), /requires a reason/);
  });

  it('is always a positive magnitude', () => {
    refuses(() => assertEntryAllowed({ ...base, amount: 0 }), /positive amount/);
    refuses(() => assertEntryAllowed({ ...base, amount: -10 }), /positive amount/);
  });

  it('a CHARGE can never be written on its own', () => {
    /**
     * The one that matters most. A charge only ever comes from resolving a real
     * discrepancy; allowing a direct one would be a way to make somebody owe
     * money with no till, no day and no shortage behind it.
     */
    refuses(
      () => assertEntryAllowed({ ...base, kind: 'charge', method: null }),
      /resolving a discrepancy, never on its own/,
    );
  });

  it('a repayment says how it arrived, and only a repayment does', () => {
    refuses(() => assertEntryAllowed({ ...base, method: null }), /how it arrived/);
    refuses(
      () => assertEntryAllowed({ ...base, kind: 'forgiveness', method: 'cash' }),
      /Only a repayment/,
    );
  });

  it('settling more than is owed is refused', () => {
    /**
     * Catches the ordinary mistake — the same repayment entered twice — before
     * it turns into the shop apparently owing an employee money.
     */
    refuses(() => assertEntryAllowed({ ...base, amount: 300 }), /more than the 250 still owed/);
  });

  it('settling exactly what is owed is fine', () => {
    expect(() => assertEntryAllowed({ ...base, amount: 250 })).not.toThrow();
  });
});

describe('which differences become a discrepancy at all', () => {
  it('a channel that balances does not', () => {
    expect(opensDiscrepancy({ counted: 500, isSkipped: false, difference: 0 })).toBe(false);
  });

  it('a shortage does, and so does a surplus', () => {
    expect(opensDiscrepancy({ counted: 400, isSkipped: false, difference: -100 })).toBe(true);
    expect(opensDiscrepancy({ counted: 600, isSkipped: false, difference: 100 })).toBe(true);
  });

  it('a SKIPPED channel does not — nobody claimed a figure', () => {
    expect(opensDiscrepancy({ counted: null, isSkipped: true, difference: null })).toBe(false);
  });

  it('an uncounted channel does not either', () => {
    /**
     * There is nothing to disagree with. Opening a discrepancy against a
     * channel nobody counted would accuse somebody of a shortage that has not
     * been measured.
     */
    expect(opensDiscrepancy({ counted: null, isSkipped: false, difference: null })).toBe(false);
  });
});
