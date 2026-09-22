import { readFileSync } from 'node:fs';
import {
  ANOMALY_WINDOW_DAYS,
  belowCostAnomalies,
  BELOW_COST_MIN_COUNT,
  cashShortfallAnomalies,
  deadStockAnomalies,
  MARGIN_MIN_SALES,
  NOTIFYING_CODES,
  orderAnomalies,
  overdueDebtAnomalies,
  pageOf,
  sellerMarginAnomalies,
  SHORTFALL_MIN_COUNT,
  withoutDismissed,
  type Anomaly,
} from './anomaly-rules';
import { FINANCIAL_FIELDS } from '../common/interceptors/financial-fields';

/**
 * The five rules, by name — low stock was removed with low-stock management
 * in the first-release scope:
 *
 * `anomaly.dead_stock` · `anomaly.overdue_debt` · `anomaly.seller_margin_drop`
 * · `anomaly.cash_shortfall` · `anomaly.below_cost_cluster`
 *
 * There is no sixth, no score and no model. What is pinned here is each
 * rule's threshold, its minimum sample and its behaviour with no history — the
 * three places a "needs your attention" panel turns into noise.
 */

const SERVICE = readFileSync('src/anomalies/anomalies.service.ts', 'utf8');
const RULES = readFileSync('src/anomalies/anomaly-rules.ts', 'utf8');

describe('the five rules, and only five', () => {
  it('are exactly the approved codes', () => {
    const codes = [
      ...deadStockAnomalies([{ productId: 'p', label: 'P', inStock: 1, days: 60 }]),
      ...overdueDebtAnomalies({ count: 1, amount: 100 }),
      ...sellerMarginAnomalies([
        {
          userId: 'u',
          name: 'A',
          current: { sales: 20, revenue: 1000, margin: 50 },
          previous: { sales: 20, revenue: 1000, margin: 300 },
        },
      ]),
      ...cashShortfallAnomalies({ count: 3, amount: -300 }),
      ...belowCostAnomalies([{ userId: 'u', name: 'A', count: 3 }]),
    ].map((a) => a.code);

    expect(new Set(codes)).toEqual(
      new Set([
        'anomaly.dead_stock',
        'anomaly.overdue_debt',
        'anomaly.seller_margin_drop',
        'anomaly.cash_shortfall',
        'anomaly.below_cost_cluster',
      ]),
    );
  });

  it('adds no machine learning and no external service', () => {
    // The rulebook's plain-language requirement is structural here: a
    // shopkeeper has to be able to check the sentence against the numbers.
    expect(RULES).not.toMatch(/fetch\(|axios|http[s]?:\/\//);
    expect(RULES).not.toMatch(/\bmodel\b.*\bpredict\b/i);
    expect(SERVICE).not.toMatch(/fetch\(|axios/);
  });

  it('never computes a metric of its own', () => {
    /*
     * Every figure comes from a service that already produced it, or from a
     * ledger row. A second definition of profit, cost, expected cash or stock
     * value is the failure mode this feature has to avoid.
     */
    expect(SERVICE).toMatch(/this\.dashboard\.deadStock\(\)/);
    // First release: no low-stock anomaly, and no low-stock list to read.
    expect(SERVICE).not.toMatch(/lowStock/);
    expect(SERVICE).toMatch(/this\.dashboard\.employeePerformance\(/);
  });
});

describe('2 — dead stock', () => {
  it('uses the shop’s own window and names it', () => {
    const [a] = deadStockAnomalies([{ productId: 'p1', label: 'Case', inStock: 4, days: 45 }]);
    expect(a.params).toEqual({ product: 'Case', days: 45 });
  });

  it('carries no value, because what the shop paid is cost', () => {
    const [a] = deadStockAnomalies([{ productId: 'p1', label: 'Case', inStock: 4, days: 60 }]);
    for (const key of Object.keys(a.params)) expect(FINANCIAL_FIELDS.has(key)).toBe(false);
    expect(a.params).not.toHaveProperty('inventoryValue');
  });

  it('ignores a product with nothing left', () => {
    expect(deadStockAnomalies([{ productId: 'p1', label: 'Case', inStock: 0, days: 60 }])).toEqual([]);
  });
});

describe('3 — overdue debt', () => {
  it('speaks when anything is past due', () => {
    const [a] = overdueDebtAnomalies({ count: 2, amount: 4500.567 });
    expect(a.params).toEqual({ count: 2, amount: 4500.57 });
    expect(a.severity).toBe('caution');
  });

  it('says nothing when nothing is overdue', () => {
    expect(overdueDebtAnomalies({ count: 0, amount: 0 })).toEqual([]);
  });
});

describe('4 — seller margin collapse', () => {
  const seller = (current: [number, number, number], previous: [number, number, number]) => ({
    userId: 'u1',
    name: 'Amina',
    current: { sales: current[0], revenue: current[1], margin: current[2] },
    previous: { sales: previous[0], revenue: previous[1], margin: previous[2] },
  });

  it('compares rates, not amounts', () => {
    /*
     * A quieter month is not a collapse. Half the revenue at the same margin
     * RATE must say nothing — an amount-based rule would call it a collapse and
     * accuse somebody of something that did not happen.
     */
    expect(sellerMarginAnomalies([seller([20, 500, 100], [20, 1000, 200])])).toEqual([]);
  });

  it('speaks when the rate has halved', () => {
    const [a] = sellerMarginAnomalies([seller([20, 1000, 100], [20, 1000, 200])]);
    expect(a.code).toBe('anomaly.seller_margin_drop');
    expect(a.params).toEqual({ seller: 'Amina', before: 20, after: 10, days: ANOMALY_WINDOW_DAYS });
  });

  it('says nothing at exactly half, because "halved" is the boundary not the trigger', () => {
    // 20% → 10% is the boundary; the rule fires strictly below it.
    expect(sellerMarginAnomalies([seller([20, 1000, 100.01], [20, 1000, 200])])).toEqual([]);
  });

  it('needs twenty sales in BOTH windows', () => {
    expect(sellerMarginAnomalies([seller([MARGIN_MIN_SALES - 1, 1000, 10], [20, 1000, 200])])).toEqual([]);
    expect(sellerMarginAnomalies([seller([20, 1000, 10], [MARGIN_MIN_SALES - 1, 1000, 200])])).toEqual([]);
  });

  it('says nothing about a seller who was not making a margin before', () => {
    // There is nothing to halve, and the comparison would report noise as news.
    expect(sellerMarginAnomalies([seller([20, 1000, -50], [20, 1000, 0])])).toEqual([]);
  });

  it('says nothing when a window has no revenue at all', () => {
    expect(sellerMarginAnomalies([seller([20, 0, 0], [20, 1000, 200])])).toEqual([]);
  });
});

describe('5 — repeated cash shortfall', () => {
  it('needs three in the window', () => {
    expect(cashShortfallAnomalies({ count: SHORTFALL_MIN_COUNT - 1, amount: -200 })).toEqual([]);
  });

  it('reports the shortage as a positive amount', () => {
    // "Short 900" reads; "short −900" is a puzzle.
    const [a] = cashShortfallAnomalies({ count: 3, amount: -900 });
    expect(a.params).toEqual({ count: 3, amount: 900, days: ANOMALY_WINDOW_DAYS });
  });
});

describe('6 — below-cost cluster', () => {
  it('needs three by the same person', () => {
    expect(belowCostAnomalies([{ userId: 'u1', name: 'A', count: BELOW_COST_MIN_COUNT - 1 }])).toEqual([]);
  });

  it('names the person and the count, and nothing about cost', () => {
    const [a] = belowCostAnomalies([{ userId: 'u1', name: 'Sidi', count: 4 }]);
    expect(a.params).toEqual({ seller: 'Sidi', count: 4, days: ANOMALY_WINDOW_DAYS });
    expect(a.key).toBe('anomaly.below_cost_cluster:u1');
  });

  it('counts approvals that were SPENT, not requests that were made', () => {
    // Asking is not selling, and a rejected request is the system working.
    expect(SERVICE).toMatch(/status: 'consumed'/);
    expect(SERVICE).toMatch(/belowCost: true/);
  });
});

describe('dismissal, ordering and notification', () => {
  const a = (key: string, code: Anomaly['code'] = 'anomaly.dead_stock', at: string | null = null): Anomaly => ({
    key,
    at,
    code,
    severity: 'info',
    messageKey: 'warning.anomaly.deadStock',
    params: {},
    field: null,
    submitted: null,
    reference: null,
  });

  it('suppresses exactly the dismissed key', () => {
    const kept = withoutDismissed([a('anomaly.dead_stock:p1'), a('anomaly.dead_stock:p2')], new Set(['anomaly.dead_stock:p1']));
    expect(kept.map((x) => x.key)).toEqual(['anomaly.dead_stock:p2']);
  });

  it('puts what must be acted on above what is merely noted', () => {
    const ordered = orderAnomalies([
      a('x'),
      { ...a('y', 'anomaly.cash_shortfall'), severity: 'caution' },
    ]);
    expect(ordered[0].severity).toBe('caution');
  });

  it('lists the newest first, then the serious, then by key — the same way every time', () => {
    /*
     * Nothing is stored, so "newest" is each rule's own instant. Two reads of
     * the same figures must put the same rows in the same places, or the
     * overview's "three most recent" and the full list would disagree.
     */
    const rows: Anomaly[] = [
      a('anomaly.dead_stock:b', 'anomaly.dead_stock', '2026-09-01T00:00:00.000Z'),
      { ...a('anomaly.cash_shortfall', 'anomaly.cash_shortfall', '2026-09-01T00:00:00.000Z'), severity: 'caution' },
      a('anomaly.dead_stock:a', 'anomaly.dead_stock', '2026-09-01T00:00:00.000Z'),
      a('anomaly.dead_stock:z', 'anomaly.dead_stock', '2026-09-20T00:00:00.000Z'),
      { ...a('anomaly.overdue_debt', 'anomaly.overdue_debt', null), severity: 'caution' },
    ];
    const expected = [
      'anomaly.dead_stock:z', // newest
      'anomaly.cash_shortfall', // same day, but must be acted on
      'anomaly.dead_stock:a', // same day, same weight: by key
      'anomaly.dead_stock:b',
      'anomaly.overdue_debt', // no instant of its own: last, whatever its weight
    ];
    expect(orderAnomalies(rows).map((x) => x.key)).toEqual(expected);
    expect(orderAnomalies([...rows].reverse()).map((x) => x.key)).toEqual(expected);
  });

  it('dates each rule from its own records, never from the clock', () => {
    const lastSold = new Date('2026-06-01T10:00:00.000Z');
    const [dead] = deadStockAnomalies([{ productId: 'p', label: 'P', inStock: 1, days: 60, lastSoldAt: lastSold }]);
    expect(dead.at).toBe(new Date(lastSold.getTime() + 60 * 86_400_000).toISOString());
    expect(deadStockAnomalies([{ productId: 'p', label: 'P', inStock: 1, days: 60 }])[0].at).toBeNull();

    const due = new Date('2026-09-10T00:00:00.000Z');
    expect(overdueDebtAnomalies({ count: 1, amount: 10, oldestDueDate: due })[0].at).toBe(due.toISOString());

    const short = new Date('2026-09-18T19:30:00.000Z');
    expect(cashShortfallAnomalies({ count: 3, amount: -30, latestAt: short })[0].at).toBe(short.toISOString());

    const spent = new Date('2026-09-19T12:00:00.000Z');
    expect(belowCostAnomalies([{ userId: 'u', name: 'A', count: 3, latestAt: spent }])[0].at).toBe(spent.toISOString());

    const day = new Date('2026-09-22T00:00:00.000Z');
    const [drop] = sellerMarginAnomalies(
      [{ userId: 'u', name: 'A', current: { sales: 20, revenue: 1000, margin: 50 }, previous: { sales: 20, revenue: 1000, margin: 300 } }],
      day,
    );
    expect(drop.at).toBe(day.toISOString());
  });

  it('pages an ordered list without changing it', () => {
    const rows = ['a', 'b', 'c', 'd'];
    expect(pageOf(rows, undefined, undefined)).toEqual({ rows, total: 4, page: 1, pageSize: 4 });
    expect(pageOf(rows, 1, 3)).toEqual({ rows: ['a', 'b', 'c'], total: 4, page: 1, pageSize: 3 });
    expect(pageOf(rows, 2, 3)).toEqual({ rows: ['d'], total: 4, page: 2, pageSize: 3 });
    expect(pageOf(rows, 3, 3)).toEqual({ rows: [], total: 4, page: 3, pageSize: 3 });
    expect(pageOf([], 1, 3)).toEqual({ rows: [], total: 0, page: 1, pageSize: 3 });
    // A nonsense size or page is read charitably, never as an error a phone has to handle.
    expect(pageOf(rows, 0, 0)).toEqual({ rows: ['a'], total: 4, page: 1, pageSize: 1 });
    expect(pageOf(rows, Number.NaN, 1000).pageSize).toBe(100);
  });

  it('answers a repeated dismissal with the one that already stands', () => {
    // A double tap, or "I understand" from a stale screen, must not stack rows.
    expect(SERVICE).toMatch(/anomalyDismissal\.findFirst\(\{\s*where: \{ companyId: this\.tenant\.companyId\(\), anomalyKey: key, suppressedUntil: \{ gt: now \} \}/);
    expect(SERVICE).toMatch(/if \(standing\) return \{ key, suppressedUntil: standing\.suppressedUntil\.toISOString\(\), replayed: true \}/);
  });

  it('interrupts for three of the six, and reads the other three', () => {
    expect(NOTIFYING_CODES).toEqual(
      new Set(['anomaly.overdue_debt', 'anomaly.cash_shortfall', 'anomaly.below_cost_cluster']),
    );
  });

  it('deduplicates a notification per anomaly per day', () => {
    // Refreshing the screen twenty times must produce one message, and the
    // database is what enforces it.
    expect(SERVICE).toMatch(/dedupeKey: `anomaly:\$\{item\.key\}:\$\{day\}`/);
    expect(SERVICE).toMatch(/e\.code === 'P2002'/);
  });

  it('suppresses for seven days and forgets after ninety', () => {
    expect(SERVICE).toMatch(/DISMISSAL_DAYS = 7/);
    expect(SERVICE).toMatch(/DISMISSAL_RETENTION_DAYS = 90/);
    expect(SERVICE).toMatch(/deleteMany\(\{ where: \{ dismissedAt: \{ lt: cutoff \} \} \}\)/);
  });

  it('audits a dismissal, because "why did nobody see it" needs an answer', () => {
    expect(SERVICE).toMatch(/entityType: 'anomaly_dismissal'/);
    expect(SERVICE).toMatch(/event: 'anomaly_dismissed'/);
  });
});

describe('who may see what', () => {
  it('never computes a rule the caller may not see', () => {
    /*
     * Computed-then-filtered is one refactor away from leaking. A figure that
     * is never fetched cannot escape through a log line or an error message.
     */
    expect(SERVICE).toMatch(/this\.isOwner\(\) \? this\.sellerMargin\(now\) : Promise\.resolve\(\[\]\)/);
    expect(SERVICE).toMatch(/this\.isOwner\(\) \? this\.belowCostCluster\(/);
    expect(SERVICE).toMatch(/this\.may\('loan\.view'\) \? this\.overdueDebt\(/);
  });

  it('treats the Owner as cost.view AND discount.override, not as a role name', () => {
    expect(SERVICE).toMatch(/this\.may\('discount\.override'\) && this\.may\('cost\.view'\)/);
  });

  it('scopes every read to the tenant client and the active branch', () => {
    // Company isolation is the extension's job; the branch is read from the
    // context, never from a request body.
    expect(SERVICE).not.toMatch(/companyId: (dto|input|body)/);
    expect(SERVICE).toMatch(/this\.tenant\.branchId\(\)/);
  });
});
