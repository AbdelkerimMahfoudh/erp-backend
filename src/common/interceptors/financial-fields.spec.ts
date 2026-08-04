import { FINANCIAL_FIELDS, stripFinancialFields } from './financial-fields';

describe('stripFinancialFields', () => {
  it('removes every financial field at the top level', () => {
    const input: Record<string, number> = {};
    for (const k of FINANCIAL_FIELDS) input[k] = 1;
    input.price = 9;
    input.revenue = 9;
    const out = stripFinancialFields(input) as Record<string, number>;
    for (const k of FINANCIAL_FIELDS) expect(out).not.toHaveProperty(k);
    expect(out).toEqual({ price: 9, revenue: 9 });
  });

  it('keeps selling prices, revenue, totals, quantities, labels', () => {
    const sale = { total: 100, subtotal: 100, price: 50, revenue: 100, qtySold: 2, amountPaid: 100, name: 'x' };
    expect(stripFinancialFields(sale)).toEqual(sale);
  });

  it('strips financial fields nested in objects and arrays', () => {
    const dashboard = {
      today: { revenue: 100, grossProfit: 40, netProfit: 30 },
      products: [
        { label: 'A', revenue: 60, cogs: 20, grossProfit: 40 },
        { label: 'B', revenue: 40, cogs: 30, grossProfit: 10 },
      ],
      inventory: { inventoryValue: 500, expectedProfit: 200, productCount: 7 },
    };
    expect(stripFinancialFields(dashboard)).toEqual({
      today: { revenue: 100 },
      products: [
        { label: 'A', revenue: 60 },
        { label: 'B', revenue: 40 },
      ],
      inventory: { productCount: 7 },
    });
  });

  it('does not touch health-score component keys (no financial key names)', () => {
    const health = {
      score: 71.8,
      status: 'amber',
      components: [{ key: 'profit_trend', score: 1, weight: 0.25, contribution: 25 }],
    };
    expect(stripFinancialFields(health)).toEqual(health);
  });

  it('passes through null, dates, and primitives; does not mutate input', () => {
    const d = new Date('2026-07-30T00:00:00Z');
    const input = { soldAt: d, cost: 5, nested: null, n: 3 };
    const out = stripFinancialFields(input) as typeof input;
    expect(out).toEqual({ soldAt: d, nested: null, n: 3 });
    expect(input.cost).toBe(5); // original untouched
  });
});
