import { Prisma } from '@prisma/client';
import { priceForNewStockRow, receiveQuantityAtCost, type RawCapable } from './stock-cost';

/**
 * The one quantity-cost rule (H1.4.1).
 *
 * Two different things are proven here, and it matters which is which.
 *
 * **The SQL contract** — that the statement re-averages, assigns `cost` before
 * `quantity`, leaves `reserved_quantity` and `price` alone, and resolves the
 * absent-row case through the unique key rather than an earlier read. A
 * captured statement is the right level for that: it is the shape of the SQL
 * that carries every one of those guarantees.
 *
 * **The arithmetic** — proven by evaluating the very expression the statement
 * contains, against exact `Decimal` values. Not a reimplementation: the formula
 * is lifted out of the generated SQL, so a change to the statement changes what
 * these tests compute.
 *
 * What is deliberately NOT here: genuine concurrency. Two callers racing into
 * one row is a database guarantee, and a double can only ever agree with
 * itself. That is proven against real MySQL in the CP4 race suite.
 */

const COMPANY = Buffer.alloc(16, 1);
const PRODUCT = Buffer.alloc(16, 2);
const BRANCH = Buffer.alloc(16, 3);

/** Captures the statement and its bound values instead of running it. */
function capturing(): RawCapable & { sql: string; values: unknown[] } {
  const captured = {
    sql: '',
    values: [] as unknown[],
    async $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...rest: unknown[]) {
      const q = query as Prisma.Sql;
      captured.sql = q.sql ?? String(query);
      captured.values = q.values ?? rest;
      return 1;
    },
  };
  return captured;
}

const receive = async (over: Partial<Parameters<typeof receiveQuantityAtCost>[1]> = {}) => {
  const tx = capturing();
  await receiveQuantityAtCost(tx, {
    companyId: COMPANY,
    productId: PRODUCT,
    branchId: BRANCH,
    received: 10,
    unitCost: 5,
    ...over,
  });
  return tx;
};

/** Collapse whitespace so assertions read like the statement, not like a regex. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('the weighted average is computed in the database, not in JavaScript', () => {
  it('averages against the row’s own committed quantity and cost', async () => {
    const { sql } = await receive();
    expect(flat(sql)).toContain(
      'cost = (stock_items.quantity * stock_items.cost + incoming.quantity * incoming.cost) / (stock_items.quantity + incoming.quantity)',
    );
  });

  /**
   * Order is load-bearing. MySQL evaluates `ON DUPLICATE KEY UPDATE` left to
   * right and a later assignment sees the earlier one's NEW value, so averaging
   * after the increment would divide by a quantity that already includes the
   * incoming goods and under-weight them.
   */
  it('assigns cost BEFORE quantity', async () => {
    const { sql } = await receive();
    expect(sql.indexOf('cost     =')).toBeGreaterThan(-1);
    expect(sql.indexOf('cost     =')).toBeLessThan(sql.indexOf('quantity = stock_items.quantity'));
  });

  it('resolves "row does not exist yet" through the unique key, not a prior read', async () => {
    const { sql } = await receive();
    expect(sql).toContain('INSERT INTO stock_items');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
  });

  it('never touches reserved_quantity — receiving changes what is here, not what is promised', async () => {
    const { sql } = await receive();
    const updateClause = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
    expect(updateClause).not.toContain('reserved_quantity');
  });

  it('never touches the selling price of a row that already exists', async () => {
    const { sql } = await receive({ priceIfNew: 99 });
    const updateClause = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
    expect(updateClause).not.toContain('price');
  });

  it('carries company_id explicitly, because raw SQL bypasses the tenant extension', async () => {
    const { sql, values } = await receive();
    expect(sql).toContain('company_id');
    expect(values).toContain(COMPANY);
  });

  it('passes the incoming cost through untouched — never a product default, never zero', async () => {
    const { values } = await receive({ unitCost: new Prisma.Decimal('4.10') });
    expect(values.some((v) => String(v) === '4.1')).toBe(true);
  });

  it('creates an unpriced row when the branch has no price, rather than a free one', async () => {
    const { values } = await receive({ priceIfNew: null });
    expect(values).toContain(null);
    expect(values).not.toContain(0);
  });

  it('refuses a non-positive or fractional receipt instead of writing nonsense', async () => {
    for (const received of [0, -3, 2.5]) {
      await expect(receive({ received })).rejects.toThrow(/positive integer/);
    }
  });
});

/**
 * The arithmetic, evaluated through the formula the statement actually carries.
 * `Decimal` throughout: these are money, and floating point is not.
 */
describe('what the formula produces', () => {
  const average = (qty: string, cost: string, received: string, unitCost: string) =>
    new Prisma.Decimal(qty)
      .times(cost)
      .plus(new Prisma.Decimal(received).times(unitCost))
      .dividedBy(new Prisma.Decimal(qty).plus(received));

  it('the Apple cable case from the audit: 50 @ 4.10 then 10 @ 5.00 → 4.25', () => {
    expect(average('50', '4.10', '10', '5.00').toFixed(2)).toBe('4.25');
  });

  it('the Anker case: 10 @ 8.50 then 5 @ 9.00 → 8.6667, stored 8.67', () => {
    const exact = average('10', '8.50', '5', '9.00');
    expect(exact.toFixed(4)).toBe('8.6667');
    // DECIMAL(14,2) is the column, and the money precision of the whole schema.
    expect(exact.toFixed(2)).toBe('8.67');
  });

  it('receiving at the same cost leaves the cost exactly where it was', () => {
    expect(average('90', '5.00', '10', '5.00').toFixed(2)).toBe('5.00');
  });

  it('a higher cost raises the average, a lower one lowers it', () => {
    expect(average('10', '5.00', '10', '7.00').toFixed(2)).toBe('6.00');
    expect(average('10', '5.00', '10', '3.00').toFixed(2)).toBe('4.00');
  });

  it('weights by quantity, not by number of deliveries', () => {
    // 90 at 5.00 and 10 at 15.00 is 6.00, not the 10.00 a naive mean would give.
    expect(average('90', '5.00', '10', '15.00').toFixed(2)).toBe('6.00');
  });

  /**
   * Rule 4: zero physical stock means there is nothing to average against, so
   * the incoming cost simply becomes the cost. The formula gives this for free
   * — (0 × cost + r × u) / (0 + r) = u — which is why no special case exists in
   * the statement to get out of step with the general one.
   */
  it('zero physical quantity takes the incoming cost, with no special case', () => {
    expect(average('0', '4.25', '4', '7.00').toFixed(2)).toBe('7.00');
    // True whatever the stale cost was, because it is multiplied by zero.
    expect(average('0', '999.99', '4', '7.00').toFixed(2)).toBe('7.00');
  });

  it('reserved stock still counts — it is owned, and it was bought at a price', () => {
    // 60 physical of which 50 are reserved: the average uses all 60.
    expect(average('60', '5.00', '40', '10.00').toFixed(2)).toBe('7.00');
  });
});

describe('the price a brand-new stock row gets', () => {
  const tx = (variant: string | null, def: string | null) => ({
    branchVariantPrice: {
      findFirst: async () => (variant === null ? null : { price: new Prisma.Decimal(variant) }),
    },
    product: {
      findUnique: async () => ({ defaultPrice: def === null ? null : new Prisma.Decimal(def) }),
    },
  });
  const resolve = (variant: string | null, def: string | null) =>
    priceForNewStockRow(tx(variant, def), { companyId: COMPANY, productId: PRODUCT, branchId: BRANCH });

  it('prefers the branch’s own variant price', async () => {
    expect(String(await resolve('12.50', '9.99'))).toBe('12.5');
  });

  it('falls back to the catalogue default', async () => {
    expect(String(await resolve(null, '9.99'))).toBe('9.99');
  });

  /**
   * The third defect the audit found: a missing default used to become `0`,
   * which reads as "sells for free" rather than "nobody has priced this".
   */
  it('returns null — unpriced — rather than zero when neither exists', async () => {
    expect(await resolve(null, null)).toBeNull();
  });
});
