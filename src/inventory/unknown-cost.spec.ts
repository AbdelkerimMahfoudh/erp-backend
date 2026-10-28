import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { receiveQuantityAtCost } from './stock-cost';
import { CostCompletionService } from './cost-completion.service';
import { knownMargin } from '../sales/known-margin';
import { SalesPolicyService } from '../sales/sales-policy.service';
import { ReceiveItemDto } from '../purchasing/dto/create-purchase.dto';
import { FINANCIAL_FIELDS } from '../common/interceptors/financial-fields';

/**
 * An unknown buying cost is NULL, never zero (0107, the owner's decision of 2026-10-28).
 *
 * Stock may be received without its cost after an explicit warning. From then
 * on nothing may treat that cost as 0: profit and valuation leave the line out
 * and say how many they left out, and the cost can be entered later — audited,
 * moving no money, never rewriting a sale's price nor creating a sale.
 */

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const PRODUCT = Buffer.alloc(16, 3);

describe('receiving without a buying cost', () => {
  it('a purchase line may omit the cost, and a given cost is still validated', async () => {
    const omitted = plainToInstance(ReceiveItemDto, { productId: '0192aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', quantity: 2 });
    expect(await validate(omitted)).toHaveLength(0);
    const zero = plainToInstance(ReceiveItemDto, { productId: '0192aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', quantity: 2, unitCost: 0 });
    expect((await validate(zero)).map((e) => e.property)).toContain('unitCost');
  });

  it('the purchase stores NULL for an omitted cost, and pays only what is known', () => {
    const purchasing = src('purchasing/purchasing.service.ts');
    expect(purchasing).toMatch(/cost: item\.unitCost \?\? null,/);
    expect(purchasing).toMatch(/committableUnits\.reduce\(\(s, u\) => s \+ \(u\.cost \?\? 0\), 0\)/);
  });

  it('counted stock of unknown cost is counted apart, and the known average is left alone', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const tx = { $executeRaw: async (q: Prisma.Sql) => (calls.push({ sql: q.sql.replace(/\s+/g, ' '), values: q.values }), 1) };
    await receiveQuantityAtCost(tx, { companyId: COMPANY, productId: PRODUCT, branchId: BRANCH, received: 5, unitCost: null });
    const [{ sql, values }] = calls;
    // VALUES (id, company, product, branch, received, cost, price, missing): cost NULL, missing = 5.
    expect(values[5]).toBeNull();
    expect(values[7]).toBe(5);
    expect(sql).toContain('WHEN incoming.cost IS NULL THEN stock_items.cost');
    expect(sql).toContain('missing_cost_quantity = stock_items.missing_cost_quantity + incoming.missing_cost_quantity');
  });

  it('a known cost adds no missing pieces', async () => {
    const calls: unknown[][] = [];
    const tx = { $executeRaw: async (q: Prisma.Sql) => (calls.push(q.values), 1) };
    await receiveQuantityAtCost(tx, { companyId: COMPANY, productId: PRODUCT, branchId: BRANCH, received: 5, unitCost: 4 });
    expect(calls[0][7]).toBe(0);
  });
});

describe('selling what has no known cost', () => {
  it('the margin counts only the lines of known cost — never a price minus zero', () => {
    const lines = [
      { price: 100, quantity: 1, discount: 0, cost: 60 },
      { price: 50, quantity: 2, discount: 0, cost: null },
    ];
    // Known line: 100 − 60 = 40. The unknown line adds neither its 100 nor a fake zero cost.
    expect(knownMargin(lines, 200, 0, 200, 60)).toBe(40);
  });

  it('a sale-wide discount is shared, so the known lines carry only their part', () => {
    const lines = [
      { price: 100, quantity: 1, discount: 0, cost: 60 },
      { price: 100, quantity: 1, discount: 0, cost: null },
    ];
    // 20 off a 200 sale: the known half carries 10 → 100 − 10 − 60.
    expect(knownMargin(lines, 200, 20, 180, 60)).toBe(30);
  });

  it('with every cost known the margin is exactly total − cost, as before', () => {
    const lines = [{ price: 100, quantity: 1, discount: 5, cost: 60 }];
    expect(knownMargin(lines, 100, 0, 95, 60)).toBe(35);
  });

  it('nothing is refused or approved below an unknown cost; a known one is guarded as before', () => {
    const policy = new SalesPolicyService();
    expect(() => policy.assertPriceAllowed({ price: 1, cost: null, mayAcceptLoss: false, approval: null, reason: undefined })).not.toThrow();
    expect(() => policy.assertPriceAllowed({ price: 1, cost: 10, mayAcceptLoss: false, approval: null, reason: undefined })).toThrow();
  });

  it('a line of unknown cost sells at NULL; counted stock with unknown pieces is unknown too', () => {
    const sales = src('sales/sales.service.ts');
    expect(sales).toMatch(/cost: unit\.cost === null \? null : Number\(unit\.cost\)/);
    expect(sales).toMatch(/cost: stock\.cost === null \|\| stock\.missingCostQuantity > 0 \? null : Number\(stock\.cost\)/);
    expect(sales).toMatch(/missingCostQuantity: \{ decrement: p\.missingTaken \}/);
  });
});

describe('reports never count an unknown cost as zero', () => {
  it('the closing report counts NULL as missing, and the result says it cannot calculate', () => {
    const q = src('closing/closing-report.queries.ts');
    expect(q.match(/si\.cost IS NULL OR si\.cost <= \$\{MISSING_COST_EPSILON\}/g)).toHaveLength(2);
    expect(q).toMatch(/line_cost IS NULL OR line_cost <= \$\{MISSING_COST_EPSILON\}/);
    expect(src('closing/closing-report.ts')).toMatch(/status: calculable \? 'ok' : 'cannot_calculate'/);
  });

  it('the day rollup takes profit over the known lines and records how many it left out', () => {
    const r = src('analytics/rollup.service.ts');
    expect(r).toMatch(/if \(r\.cost === null\) \{\s*missingCostLines \+= 1;\s*continue;/);
    expect(r).toMatch(/const grossProfit = round2\(totals\.profitRevenue - cogs\);/);
    expect(r).toMatch(/missingCostLines: totals\.missingCostLines,/);
  });

  it('period figures and the dashboard disclose the count; valuation leaves unknown pieces out', () => {
    expect(src('analytics/period-figures.ts')).toMatch(/si\.cost IS NULL OR si\.cost <= 0\.005/);
    expect(src('analytics/dashboard.service.ts')).toMatch(/missingCostLines: num\(s\.missingCostLines \?\? null\)/);
    expect(src('analytics/held-value.ts')).toMatch(/SUM\(\(si\.quantity - si\.missing_cost_quantity\) \* si\.cost\) AS inv_value/);
  });

  it('whether a cost is known is cost information: hidden from callers without cost.view', () => {
    expect(FINANCIAL_FIELDS.has('costMissing')).toBe(true);
    expect(FINANCIAL_FIELDS.has('missingCostQuantity')).toBe(true);
  });
});

// ── Entering the cost later ──────────────────────────────────────────────────

function harness(seed: {
  unitCost?: number | null;
  sold?: { closed: boolean } | null;
  stock?: { quantity: number; cost: number | null; missing: number };
  line?: { quantity: number; unitCost: number | null };
}) {
  const writes: { model: string; data: unknown; where?: unknown }[] = [];
  const audits: unknown[] = [];
  const rollups: unknown[] = [];
  const SALE = Buffer.alloc(16, 9);
  const day = new Date('2026-10-28T00:00:00.000Z');
  const tx: Record<string, unknown> = {
    unit: { updateMany: async (a: { data: unknown }) => (writes.push({ model: 'unit', data: a.data }), { count: 1 }) },
    purchaseItem: {
      findFirst: async () => ({ id: Buffer.alloc(16, 7) }),
      update: async (a: { data: unknown }) => (writes.push({ model: 'purchaseItem', data: a.data }), {}),
      updateMany: async (a: { data: unknown }) => (writes.push({ model: 'purchaseItem', data: a.data }), { count: 1 }),
    },
    saleItem: {
      findFirst: async () => (seed.sold ? { id: Buffer.alloc(16, 8), saleId: SALE, sale: { branchId: BRANCH, businessDate: day } } : null),
      update: async (a: { data: unknown }) => (writes.push({ model: 'saleItem', data: a.data }), {}),
    },
    dailyClosing: { findFirst: async () => (seed.sold?.closed ? { id: Buffer.alloc(16, 5) } : null) },
    sale: {
      findUniqueOrThrow: async () => ({
        subtotal: new Prisma.Decimal(150),
        discount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(150),
        items: [
          { price: new Prisma.Decimal(150), quantity: 1, discount: new Prisma.Decimal(0), cost: new Prisma.Decimal(90) },
        ],
      }),
      update: async (a: { data: unknown }) => (writes.push({ model: 'sale', data: a.data }), {}),
    },
    stockItem: {
      findFirst: async () => (seed.stock ? { id: Buffer.alloc(16, 6), quantity: seed.stock.quantity, cost: seed.stock.cost === null ? null : new Prisma.Decimal(seed.stock.cost), missingCostQuantity: seed.stock.missing } : null),
      updateMany: async (a: { data: unknown }) => (writes.push({ model: 'stockItem', data: a.data }), { count: 1 }),
    },
    rollupRequest: { createMany: async (a: { data: unknown }) => (rollups.push(a.data), { count: 1 }) },
    $executeRaw: async (q: Prisma.Sql) => (rollups.push(q.values), 1),
  };
  const db = {
    unit: { findFirst: async () => ({ id: Buffer.alloc(16, 4), cost: seed.unitCost === undefined ? null : seed.unitCost, productId: PRODUCT, purchaseId: Buffer.alloc(16, 10) }) },
    purchaseItem: {
      findFirst: async () => (seed.line ? { id: Buffer.alloc(16, 7), productId: PRODUCT, quantity: seed.line.quantity, unitCost: seed.line.unitCost, product: { trackingType: 'quantity' } } : null),
    },
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const tenant = { companyId: () => COMPANY, requireBranchId: () => BRANCH };
  const audit = { recordTx: async (_t: unknown, entry: unknown) => void audits.push(entry) };
  const service = new CostCompletionService(db as never, tenant as never, audit as never);
  return { service, writes, audits, rollups };
}

describe('entering a missing cost later', () => {
  const UNIT = '0192aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

  it('completes an unsold unit and its purchase line, audited, moving no money', async () => {
    const h = harness({});
    const out = await h.service.completeUnit(UNIT, { cost: 250 });
    expect(out).toMatchObject({ cost: 250, saleCompleted: false, saleOnClosedDay: false });
    expect(h.writes.map((w) => w.model)).toEqual(['unit', 'purchaseItem']);
    expect(h.audits[0]).toMatchObject({ before: { cost: null }, after: { cost: 250, costCompleted: true } });
  });

  it('a unit sold on an open day: the sale line takes the cost and the sale is recomputed — price untouched, no second sale', async () => {
    const h = harness({ sold: { closed: false } });
    const out = await h.service.completeUnit(UNIT, { cost: 90 });
    expect(out.saleCompleted).toBe(true);
    const sale = h.writes.find((w) => w.model === 'sale')!;
    // 150 sold, 90 cost: the profit is complete now. Only cost and margin are written.
    expect(sale.data).toEqual({ totalCost: 90, margin: 60 });
    expect(h.writes.find((w) => w.model === 'saleItem')!.data).toEqual({ cost: 90 });
    expect(h.writes.some((w) => w.model === 'sale' && 'price' in (w.data as object))).toBe(false);
  });

  it('a unit sold on a CLOSED day leaves that sale as the closing froze it, and says so', async () => {
    const h = harness({ sold: { closed: true } });
    const out = await h.service.completeUnit(UNIT, { cost: 90 });
    expect(out).toMatchObject({ saleCompleted: false, saleOnClosedDay: true });
    expect(h.writes.map((w) => w.model)).toEqual(['unit', 'purchaseItem']);
  });

  it('refuses to "complete" a cost that is already known — that is a correction, with its reason', async () => {
    const h = harness({ unitCost: 100 });
    await expect(h.service.completeUnit(UNIT, { cost: 90 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('a counted line folds its pieces still on hand into the average; pieces already sold stay unknown', async () => {
    // 10 on hand: 6 known at 5.00, 4 of unknown cost. The line brought 6, so 2 of them were sold.
    const h = harness({ line: { quantity: 6, unitCost: null }, stock: { quantity: 10, cost: 5, missing: 4 } });
    const out = await h.service.completeStockLine(UNIT, { cost: 8 });
    expect(out).toMatchObject({ piecesValued: 4, piecesSoldUnknown: 2 });
    // (6 × 5 + 4 × 8) / 10 = 6.20
    expect(h.writes.find((w) => w.model === 'stockItem')!.data).toEqual({ cost: 6.2, missingCostQuantity: { decrement: 4 } });
  });

  it('a counted line with nothing left of unknown cost changes no average', async () => {
    const h = harness({ line: { quantity: 3, unitCost: null }, stock: { quantity: 2, cost: 5, missing: 0 } });
    const out = await h.service.completeStockLine(UNIT, { cost: 8 });
    expect(out).toMatchObject({ piecesValued: 0, piecesSoldUnknown: 3 });
    expect(h.writes.some((w) => w.model === 'stockItem')).toBe(false);
  });
});
