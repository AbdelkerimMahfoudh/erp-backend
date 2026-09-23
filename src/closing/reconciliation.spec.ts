import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The authoritative reconciliation equation** (Milestone E0).
 *
 * Five milestones have now each added a movement to expected cash, and each
 * one arrived as a separate fix for a separate reported shortage:
 *
 *   I3  refunds paid in cash          — a refunded day looked short
 *   J1  supplier payments in cash     — a day the shop paid a supplier looked short
 *   B   corrections returned in cash  — money came back and nothing said so
 *   D   expenses paid in cash         — a day the shop bought electricity looked short
 *
 * That history is the reason this file exists. Each addition was individually
 * correct and nobody was ever looking at the whole equation, so the next
 * omission was only ever found by somebody noticing their till did not balance.
 *
 * This pins the WHOLE equation in one place:
 *
 *   expected = cash taken in
 *            − refunds(cash) − supplier(cash) − expenses(cash)
 *            + corrections(cash)
 *
 * Two properties are asserted, and both matter:
 *
 *   1. **Every movement appears exactly once.** Twice would double-count.
 *   2. **Only CONFIRMED movements appear.** A pending report must change no
 *      figure anybody reconciles against.
 *
 * Milestone E builds the progressive closing on top of this. It must not create
 * a second equation — if a term is added, it is added here.
 */

const SRC = __dirname;
const closing = readFileSync(join(SRC, 'closing.service.ts'), 'utf8');
const rollup = readFileSync(join(SRC, '..', 'analytics', 'rollup.service.ts'), 'utf8');
/** Paid for stock now lives in closing itself (first release: Suppliers module removed). */
const stockPaid = closing.slice(closing.indexOf('private async stockPaidOn('), closing.indexOf('private async channelMovements('));

/**
 * The expected-cash expression, comments stripped.
 *
 * Bounded by the statement's own terminator rather than by whatever line
 * happens to follow it — E-CP1 inserted the counted-cash resolution between
 * this statement and `const difference`, and an equation that silently absorbs
 * its neighbours stops being an equation.
 */
const expectedCashStart = closing.indexOf('const expectedCash');
const equation = closing
  .slice(expectedCashStart, closing.indexOf(';', expectedCashStart))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Every term the equation is allowed to contain, and its sign. */
const TERMS = [
  { name: 'openingCash', sign: '+', why: 'the drawer’s opening balance (0076): carried forward, never income' },
  { name: 'cash._sum.amount', sign: '+', why: 'cash taken in from sales' },
  { name: 'refundedCash', sign: '-', why: 'refunds handed back in cash (I3)' },
  { name: 'supplierPaid.cash', sign: '-', why: 'paid for stock in cash: settlements (J1) and purchases paid at receipt' },
  { name: 'expensesCash', sign: '-', why: 'expenses paid in cash (D)' },
  { name: 'correctedCash', sign: '+', why: 'corrections returned in cash (B)' },
] as const;

describe('the reconciliation equation', () => {
  for (const term of TERMS) {
    it(`includes ${term.name} exactly once — ${term.why}`, () => {
      const escaped = term.name.replace(/\./g, '\\.');
      const hits = equation.match(new RegExp(escaped, 'g')) ?? [];
      expect(hits).toHaveLength(1);
    });

    it(`applies the right sign to ${term.name}`, () => {
      const escaped = term.name.replace(/\./g, '\\.');
      if (term.sign === '-') {
        expect(equation).toMatch(new RegExp(`-\\s*${escaped}`));
      } else {
        // The first term has no leading operator; the rest are added.
        expect(equation).toMatch(new RegExp(`[+(]\\s*${escaped}|${escaped}`));
        expect(equation).not.toMatch(new RegExp(`-\\s*${escaped}`));
      }
    });
  }

  it('contains NOTHING but those six terms', () => {
    /**
     * The assertion that actually catches a sixth movement being bolted on
     * without being reasoned about. If a term is genuinely needed, it is added
     * to `TERMS` above with its sign and its reason — which forces somebody to
     * say why.
     */
    const identifiers = [...equation.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)].map((m) => m[0]);
    const allowed = new Set([
      ...TERMS.map((t) => t.name),
      'const',
      'expectedCash',
      'round2',
      'num',
      'cash',
      '_sum',
      'amount',
      'cash._sum',
    ]);
    const unexpected = identifiers.filter(
      (id) => !allowed.has(id) && !TERMS.some((t) => t.name.startsWith(id) || id.startsWith(t.name)),
    );
    expect(unexpected).toEqual([]);
  });
});

describe('only CONFIRMED movements reach the equation', () => {
  it('refunds: the rollup component counts confirmed payouts only', () => {
    const block = rollup.slice(rollup.indexOf('FROM refund_payouts'), rollup.indexOf('FROM refund_payouts') + 300);
    expect(block).toMatch(/status = 'confirmed'/);
  });

  it('paid for stock: confirmed settlements, and purchases paid at receipt', () => {
    expect(stockPaid).toMatch(/FROM supplier_settlements[\s\S]*status = 'confirmed'/);
    // A purchase is paid in full the moment it is received, so its payment row
    // is already a completed movement — keyed on when it was paid, at the
    // purchase's own branch.
    expect(stockPaid).toContain('FROM supplier_payments sp');
    expect(stockPaid).toContain('JOIN purchases p ON p.id = sp.purchase_id');
    expect(stockPaid).toContain('p.branch_id = ${branchId}');
    // 0076: keyed on the STORED business date, never on the timestamp's calendar day.
    expect(stockPaid).toContain('sp.business_date = ${dayDate}');
  });

  it('expenses: confirmed only', () => {
    const block = rollup.slice(rollup.indexOf('FROM expenses'), rollup.indexOf('FROM expenses') + 400);
    expect(block).toMatch(/status = 'confirmed'/);
  });

  it('corrections: approved only', () => {
    const block = rollup.slice(
      rollup.indexOf('FROM financial_corrections'),
      rollup.indexOf('FROM financial_corrections') + 300,
    );
    expect(block).toMatch(/status = 'approved'/);
  });
});

describe('only CASH reaches the till figure', () => {
  /**
   * An account transfer never touched the drawer. Every component therefore
   * separates its cash half, and the equation uses only that half — the reason
   * each of these `CASE WHEN method = 'cash'` sums exists.
   */
  it('each component separates its cash part', () => {
    expect(rollup).toMatch(/method = 'cash' THEN reported_amount END\), 0\)\s+AS paid_cash/);
    expect(rollup).toMatch(/method = 'cash' THEN amount END\), 0\)\s+AS paid_cash|method = 'cash' THEN amount END\), 0\)\s+AS expenses_cash/);
    expect(stockPaid).toContain("GROUP BY (method = 'cash')");
    expect(stockPaid).toContain("GROUP BY (sp.method = 'cash')");
  });

  it('the equation reads the cash figures, never the totals', () => {
    for (const total of ['refundsPaidTotal', 'supplierPaid.total', 'correctionsTotal']) {
      expect(equation).not.toContain(total);
    }
  });
});

describe('a locked closing is a snapshot, not a view', () => {
  /**
   * Once written, the figures are stored on the closing row. Nothing recomputes
   * and rewrites them later — a correction posts to the current open day
   * instead, which is what keeps a signed-off day signed off.
   */
  it('the closing stores its own expected and counted figures', () => {
    expect(closing).toMatch(/const snapshot = \{[\s\S]{0,120}expectedCash,\s*\n\s*countedCash,/);
  });

  it('closing the same day twice is refused', () => {
    expect(closing).toMatch(/already closed for this branch/);
  });

  it('only a LOCKED day refuses to be closed again', () => {
    /**
     * E-CP1 made a counting day have a closing row of its own, so existence
     * stopped being the test. If this reverts to refusing on existence, the
     * whole progressive flow becomes unreachable — the first count would block
     * the sign-off that follows it.
     */
    expect(closing).toMatch(/already\?\.status === 'locked'/);
  });
});

describe('the per-channel path is the same equation, not a second one', () => {
  /**
   * E-CP1 added expected/counted per receiving account. The danger is obvious
   * in hindsight: a second place computing "what should be here" is exactly how
   * the five separate cash fixes happened, each correct on its own and nobody
   * looking at the whole thing.
   *
   * So the channel builder owns the signs, `channels.spec.ts` pins them, and
   * these assert the closing does not quietly grow a private copy.
   */
  const channels = readFileSync(join(SRC, 'channels.ts'), 'utf8');

  it('the signs live in exactly one table', () => {
    expect(channels).toMatch(/COMPONENT_SIGN: Record<Component, 1 \| -1>/);
    // The opening balance (0076) is a starting balance, not a movement: it has
    // no sign of its own, so the five movement components are what is signed.
    expect(channels.match(/COMPONENT_SIGN\.\w+/g) ?? []).toHaveLength(TERMS.filter((t) => t.name !== 'openingCash').length);
  });

  it('every cash term has a per-channel counterpart', () => {
    for (const component of ['salesIn', 'refundsOut', 'supplierOut', 'expensesOut', 'correctionsIn']) {
      expect(channels).toContain(`${component}:`);
      expect(closing).toContain(`'${component}'`);
    }
  });

  it('the closing computes no expected figure of its own per channel', () => {
    /**
     * `expectedChannels` must delegate. If somebody inlines the arithmetic here
     * instead, the channel figure and the till figure can disagree about the
     * same movement without any test noticing.
     */
    expect(closing).toMatch(/return buildChannels\(/);
  });
});
