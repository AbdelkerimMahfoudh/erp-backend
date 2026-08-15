import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  allocateOldestFirst,
  assertAllocationFits,
  assertStillPayable,
  purchaseStatusOf,
  round2,
  settlementFingerprint,
  type OutstandingPurchase,
} from './payable';

/**
 * The payable arithmetic, tested directly.
 *
 * This is where a supplier gets overpaid: allocation that adds up to the wrong
 * total, a duplicate line hiding inside a correct-looking sum, or a concurrency
 * check that reads a screen rather than the committed rows.
 */

const day = (n: number) => new Date(2026, 0, n);

const purchase = (id: string, total: number, paid: number, d: number): OutstandingPurchase => ({
  purchaseId: id,
  total,
  paid,
  outstanding: round2(total - paid),
  date: day(d),
});

const index = (ps: OutstandingPurchase[]) => new Map(ps.map((p) => [p.purchaseId, p]));

describe('allocateOldestFirst', () => {
  const open = [purchase('c', 100, 0, 3), purchase('a', 500, 0, 1), purchase('b', 200, 0, 2)];

  it('pays the oldest debt first, whatever order the rows arrive in', () => {
    expect(allocateOldestFirst(600, open)).toEqual([
      { purchaseId: 'a', amount: 500 },
      { purchaseId: 'b', amount: 100 },
    ]);
  });

  it('stops when the money runs out, part-paying the last one', () => {
    expect(allocateOldestFirst(550, open)).toEqual([
      { purchaseId: 'a', amount: 500 },
      { purchaseId: 'b', amount: 50 },
    ]);
  });

  it('never allocates more than is owed in total', () => {
    const all = allocateOldestFirst(99_999, open);
    expect(all.reduce((s, a) => s + a.amount, 0)).toBe(800);
  });

  it('skips a purchase that is already settled', () => {
    const withPaid = [purchase('a', 500, 500, 1), purchase('b', 200, 0, 2)];
    expect(allocateOldestFirst(100, withPaid)).toEqual([{ purchaseId: 'b', amount: 100 }]);
  });

  it('allocates nothing when nothing is owed', () => {
    expect(allocateOldestFirst(100, [purchase('a', 500, 500, 1)])).toEqual([]);
  });

  it('handles a part-paid purchase by its REMAINDER, not its total', () => {
    const partly = [purchase('a', 500, 450, 1), purchase('b', 200, 0, 2)];
    expect(allocateOldestFirst(100, partly)).toEqual([
      { purchaseId: 'a', amount: 50 },
      { purchaseId: 'b', amount: 50 },
    ]);
  });
});

describe('assertAllocationFits', () => {
  const open = [purchase('a', 500, 0, 1), purchase('b', 200, 0, 2)];

  it('accepts an allocation that adds up', () => {
    expect(() =>
      assertAllocationFits(600, [
        { purchaseId: 'a', amount: 500 },
        { purchaseId: 'b', amount: 100 },
      ], index(open)),
    ).not.toThrow();
  });

  it('REFUSES a total that does not match the money handed over', () => {
    expect(() =>
      assertAllocationFits(600, [{ purchaseId: 'a', amount: 500 }], index(open)),
    ).toThrow(/does not add up/i);
  });

  it('refuses paying more than one purchase owes', () => {
    try {
      assertAllocationFits(600, [{ purchaseId: 'a', amount: 600 }], index(open));
      throw new Error('should have thrown');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as {
        problems: { outstanding: number; requested: number }[];
      };
      expect(body.problems[0].outstanding).toBe(500);
      expect(body.problems[0].requested).toBe(600);
    }
  });

  it('refuses the same purchase listed twice, even when the total is right', () => {
    // 300 + 300 against a 500 debt sums to 600 and would look correct.
    try {
      assertAllocationFits(600, [
        { purchaseId: 'a', amount: 300 },
        { purchaseId: 'a', amount: 300 },
      ], index(open));
      throw new Error('should have thrown');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as { problems: { reason: string }[] };
      expect(body.problems.some((p) => /twice/.test(p.reason))).toBe(true);
    }
  });

  it('refuses a purchase belonging to somebody else', () => {
    expect(() =>
      assertAllocationFits(100, [{ purchaseId: 'zzz', amount: 100 }], index(open)),
    ).toThrow(/cannot be applied/i);
  });

  it('refuses a zero or negative line', () => {
    expect(() =>
      assertAllocationFits(100, [
        { purchaseId: 'a', amount: 150 },
        { purchaseId: 'b', amount: -50 },
      ], index(open)),
    ).toThrow(BadRequestException);
  });

  it('refuses an empty allocation rather than guessing', () => {
    expect(() => assertAllocationFits(100, [], index(open))).toThrow(/which purchases/i);
  });

  it('accepts a settlement that clears a debt exactly', () => {
    expect(() =>
      assertAllocationFits(500, [{ purchaseId: 'a', amount: 500 }], index(open)),
    ).not.toThrow();
  });
});

describe('assertStillPayable', () => {
  it('passes when the debt is still there', () => {
    expect(() =>
      assertStillPayable([{ purchaseId: 'a', amount: 100 }], index([purchase('a', 500, 0, 1)])),
    ).not.toThrow();
  });

  it('REFUSES when somebody else paid it first — the overpayment guard', () => {
    // Two managers confirm at once: the second re-reads committed rows and
    // finds only 50 left of the 100 it was going to settle.
    expect(() =>
      assertStillPayable([{ purchaseId: 'a', amount: 100 }], index([purchase('a', 500, 450, 1)])),
    ).toThrow(ConflictException);
  });

  it('refuses when the purchase has vanished from the open set entirely', () => {
    expect(() => assertStillPayable([{ purchaseId: 'a', amount: 10 }], new Map())).toThrow(
      ConflictException,
    );
  });

  it('reports what is left and what was asked for', () => {
    try {
      assertStillPayable([{ purchaseId: 'a', amount: 100 }], index([purchase('a', 500, 460, 1)]));
      throw new Error('should have thrown');
    } catch (e) {
      const body = (e as ConflictException).getResponse() as {
        problems: { outstanding: number; requested: number }[];
      };
      expect(body.problems[0].outstanding).toBe(40);
      expect(body.problems[0].requested).toBe(100);
    }
  });
});

describe('purchaseStatusOf', () => {
  it('is unpaid at zero', () => expect(purchaseStatusOf(500, 0)).toBe('unpaid'));
  it('is partial in between', () => expect(purchaseStatusOf(500, 200)).toBe('partial'));
  it('is paid when it is settled exactly', () => expect(purchaseStatusOf(500, 500)).toBe('paid'));
  it('is paid rather than partial if it somehow went over', () =>
    expect(purchaseStatusOf(500, 501)).toBe('paid'));
  it('treats a rounding sliver as unpaid, not partial', () =>
    expect(purchaseStatusOf(500, 0.004)).toBe('unpaid'));
});

describe('settlementFingerprint', () => {
  const base = {
    supplierId: 'S1',
    amount: 600,
    method: 'cash',
    allocations: [
      { purchaseId: 'a', amount: 500 },
      { purchaseId: 'b', amount: 100 },
    ],
  };

  it('does not change when the allocation is listed in another order', () => {
    const reordered = {
      ...base,
      allocations: [
        { purchaseId: 'b', amount: 100 },
        { purchaseId: 'a', amount: 500 },
      ],
    };
    expect(settlementFingerprint(base)).toBe(settlementFingerprint(reordered));
  });

  it('CHANGES when the amount changes', () => {
    expect(settlementFingerprint(base)).not.toBe(settlementFingerprint({ ...base, amount: 601 }));
  });

  it('CHANGES when the money moves to a different purchase', () => {
    expect(settlementFingerprint(base)).not.toBe(
      settlementFingerprint({
        ...base,
        allocations: [
          { purchaseId: 'a', amount: 100 },
          { purchaseId: 'b', amount: 500 },
        ],
      }),
    );
  });

  it('CHANGES when the method changes', () => {
    expect(settlementFingerprint(base)).not.toBe(
      settlementFingerprint({ ...base, method: 'account', receivingAccountId: 'ACC' }),
    );
  });

  it('CHANGES when the supplier changes', () => {
    expect(settlementFingerprint(base)).not.toBe(
      settlementFingerprint({ ...base, supplierId: 'S2' }),
    );
  });

  it('is case-insensitive about ids, which clients format differently', () => {
    expect(settlementFingerprint(base)).toBe(
      settlementFingerprint({
        ...base,
        supplierId: 's1',
        allocations: base.allocations.map((a) => ({ ...a, purchaseId: a.purchaseId.toUpperCase() })),
      }),
    );
  });
});
