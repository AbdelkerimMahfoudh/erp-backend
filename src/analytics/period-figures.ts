import { Prisma } from '@prisma/client';
import { fromCents, sharesBySale, toCents } from '../sales/sale-shares';

/**
 * The dated accounting rules, in one place (docs/53 D29). Home, Money, the sales-by-day list,
 * the employees report and the product/category reports read their figures from here, so a
 * screen cannot count a sale, a cancellation, a return or an expense on a different day, or by
 * a different measure, from the Daily closing:
 *
 *   R1  a sale stays on its business date; its cancellation is a negative adjustment on the approval date
 *   R2  a return reduces revenue by the net refund due, and profit by gross − adjustments − cost credited,
 *       on its approval date (a refund's confirmation moves money only — it is not here)
 *   R4  an expense stays on its own date (variable: confirmation, fixed: due); a reversal comes off on the
 *       correction date
 *   R5  sales count = invoices − whole-sale cancellations; a return is its own count
 *   R6  units (and phones) sold = on the invoices − on the cancelled invoices; units returned apart
 *
 * Every query is filtered by company (the tenant client does not scope raw SQL) and, when given,
 * by branch. Each groups by the date that carries the fact, so a period is the sum of its days.
 */

export interface RawRunner {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Invoices of the dates, on their business date. */
export interface InvoiceFigures {
  count: number;
  /** Σ sales.total — what the customer was invoiced. */
  value: number;
  units: number;
  phones: number;
  /** Σ sales.total_cost. */
  cost: number;
  /** Σ sales.margin. */
  margin: number;
}

/** Whole sales cancelled on the dates (approval date), whatever day they were sold. */
export type CancellationFigures = InvoiceFigures;

/** Returns approved on the dates (approval date), whatever day the item was sold. */
export interface ReturnedFigures {
  count: number;
  /** Σ net refund due — the revenue that comes off. */
  value: number;
  grossRefund: number;
  adjustments: number;
  /** Σ line cost credited back. */
  costCredited: number;
  /** Σ (gross − adjustments − cost credited) — what the return takes off profit. */
  profitEffect: number;
  phones: number;
}

export interface ExpenseFigures {
  /** Confirmed expenses on their own date (variable: confirmation, fixed: due). */
  recorded: number;
  recordedCount: number;
  /** Reversals approved on the dates (correction date). */
  reversed: number;
  reversedCount: number;
  /** recorded − reversed; negative when a day holds only a reversal. */
  net: number;
}

export interface PeriodFigures {
  invoices: InvoiceFigures;
  cancellations: CancellationFigures;
  returns: ReturnedFigures;
  expenses: ExpenseFigures;
  /** R1/R2/R5/R6 applied: value − returns − cancellations; invoices − cancellations. */
  net: { salesValue: number; salesCount: number; units: number; phones: number };
}

export const emptyInvoices = (): InvoiceFigures => ({ count: 0, value: 0, units: 0, phones: 0, cost: 0, margin: 0 });
export const emptyReturns = (): ReturnedFigures => ({ count: 0, value: 0, grossRefund: 0, adjustments: 0, costCredited: 0, profitEffect: 0, phones: 0 });
const emptyExpenses = (): ExpenseFigures => ({ recorded: 0, recordedCount: 0, reversed: 0, reversedCount: 0, net: 0 });

/** The units and the phones of one invoice — shared by the invoice and the cancellation reads. */
const UNITS_OF_SALE = Prisma.sql`(SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id AND si.voided = 0)`;
const PHONES_OF_SALE = Prisma.sql`(SELECT COUNT(*) FROM sale_items si JOIN units u ON u.id = si.unit_id JOIN products p ON p.id = u.product_id
                                     WHERE si.sale_id = s.id AND si.voided = 0 AND p.tracking_type = 'imei')`;

type InvoiceRow = { day: string; n: bigint; value: unknown; cost: unknown; margin: unknown; units: unknown; phones: unknown };
type ReturnRow = { day: string; n: bigint; value: unknown; gross: unknown; adj: unknown; cost: unknown; effect: unknown; phones: unknown };
type ExpenseRow = { day: string; amount: unknown; n: bigint };

const invoiceOf = (r: InvoiceRow | undefined): InvoiceFigures =>
  r
    ? { count: Number(r.n), value: round2(num(r.value)), units: num(r.units), phones: num(r.phones), cost: round2(num(r.cost)), margin: round2(num(r.margin)) }
    : emptyInvoices();
const returnOf = (r: ReturnRow | undefined): ReturnedFigures =>
  r
    ? {
        count: Number(r.n),
        value: round2(num(r.value)),
        grossRefund: round2(num(r.gross)),
        adjustments: round2(num(r.adj)),
        costCredited: round2(num(r.cost)),
        profitEffect: round2(num(r.effect)),
        phones: num(r.phones),
      }
    : emptyReturns();

/** Each business date of the range that holds any fact, with the figures that date carries. */
export async function figuresByDay(
  db: RawRunner,
  companyId: Buffer,
  branchId: Buffer | null,
  from: string,
  to: string,
): Promise<Map<string, PeriodFigures>> {
  const branch = (col: string) => (branchId ? Prisma.sql`AND ${Prisma.raw(col)} = ${branchId}` : Prisma.empty);

  const [invoices, cancellations, returns, recorded, reversed] = await Promise.all([
    db.$queryRaw<InvoiceRow[]>(Prisma.sql`
      SELECT DATE_FORMAT(s.business_date, '%Y-%m-%d') AS day, COUNT(*) AS n,
             COALESCE(SUM(s.total), 0) AS value, COALESCE(SUM(s.total_cost), 0) AS cost, COALESCE(SUM(s.margin), 0) AS margin,
             COALESCE(SUM(${UNITS_OF_SALE}), 0) AS units, COALESCE(SUM(${PHONES_OF_SALE}), 0) AS phones
        FROM sales s
       WHERE s.company_id = ${companyId} ${branch('s.branch_id')} AND s.is_reversed = 0
         AND s.business_date BETWEEN ${from} AND ${to}
       GROUP BY day`),
    db.$queryRaw<InvoiceRow[]>(Prisma.sql`
      SELECT DATE_FORMAT(fc.correction_date, '%Y-%m-%d') AS day, COUNT(*) AS n,
             COALESCE(SUM(s.total), 0) AS value, COALESCE(SUM(s.total_cost), 0) AS cost, COALESCE(SUM(s.margin), 0) AS margin,
             COALESCE(SUM(${UNITS_OF_SALE}), 0) AS units, COALESCE(SUM(${PHONES_OF_SALE}), 0) AS phones
        FROM financial_corrections fc
        JOIN sales s ON s.id = fc.target_sale_id
       WHERE fc.company_id = ${companyId} ${branch('fc.branch_id')}
         AND fc.target_kind = 'sale' AND fc.status = 'approved'
         AND fc.correction_date BETWEEN ${from} AND ${to}
       GROUP BY day`),
    db.$queryRaw<ReturnRow[]>(Prisma.sql`
      SELECT DATE_FORMAT(rr.approval_date, '%Y-%m-%d') AS day, COUNT(*) AS n,
             COALESCE(SUM(rr.net_refund_due), 0) AS value, COALESCE(SUM(rr.gross_refund), 0) AS gross,
             COALESCE(SUM(rr.adjustment_total), 0) AS adj, COALESCE(SUM(rr.line_cost), 0) AS cost,
             COALESCE(SUM(rr.gross_refund - rr.adjustment_total - rr.line_cost), 0) AS effect,
             COALESCE(SUM(p.tracking_type = 'imei'), 0) AS phones
        FROM return_reversals rr
        LEFT JOIN units u ON u.id = rr.unit_id
        LEFT JOIN products p ON p.id = u.product_id
       WHERE rr.company_id = ${companyId} ${branch('rr.branch_id')}
         AND rr.approval_date BETWEEN ${from} AND ${to}
       GROUP BY day`),
    db.$queryRaw<ExpenseRow[]>(Prisma.sql`
      SELECT DATE_FORMAT(IF(expense_class = 'fixed', due_date, confirmation_date), '%Y-%m-%d') AS day,
             COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS n
        FROM expenses
       WHERE company_id = ${companyId} ${branch('branch_id')} AND status = 'confirmed'
         AND IF(expense_class = 'fixed', due_date, confirmation_date) BETWEEN ${from} AND ${to}
       GROUP BY day`),
    db.$queryRaw<ExpenseRow[]>(Prisma.sql`
      SELECT DATE_FORMAT(fc.correction_date, '%Y-%m-%d') AS day, COALESCE(SUM(fc.amount), 0) AS amount, COUNT(*) AS n
        FROM financial_corrections fc
       WHERE fc.company_id = ${companyId} ${branch('fc.branch_id')}
         AND fc.target_kind = 'expense' AND fc.status = 'approved'
         AND fc.correction_date BETWEEN ${from} AND ${to}
       GROUP BY day`),
  ]);

  const days = new Set<string>([...invoices, ...cancellations, ...returns, ...recorded, ...reversed].map((r) => r.day));
  const out = new Map<string, PeriodFigures>();
  for (const day of [...days].sort()) {
    const inv = invoiceOf(invoices.find((r) => r.day === day));
    const can = invoiceOf(cancellations.find((r) => r.day === day));
    const ret = returnOf(returns.find((r) => r.day === day));
    const rec = recorded.find((r) => r.day === day);
    const rev = reversed.find((r) => r.day === day);
    const expenses: ExpenseFigures = {
      recorded: round2(num(rec?.amount)),
      recordedCount: Number(rec?.n ?? 0),
      reversed: round2(num(rev?.amount)),
      reversedCount: Number(rev?.n ?? 0),
      net: round2(num(rec?.amount) - num(rev?.amount)),
    };
    out.set(day, withNet({ invoices: inv, cancellations: can, returns: ret, expenses }));
  }
  return out;
}

/** The range as one total — the sum of its days, by construction. */
export async function periodFigures(db: RawRunner, companyId: Buffer, branchId: Buffer | null, from: string, to: string): Promise<PeriodFigures> {
  return sumFigures([...(await figuresByDay(db, companyId, branchId, from, to)).values()]);
}

export function sumFigures(days: PeriodFigures[]): PeriodFigures {
  const inv = emptyInvoices();
  const can = emptyInvoices();
  const ret = emptyReturns();
  const exp = emptyExpenses();
  for (const d of days) {
    for (const [a, b] of [[inv, d.invoices], [can, d.cancellations]] as const) {
      a.count += b.count;
      a.value += b.value;
      a.units += b.units;
      a.phones += b.phones;
      a.cost += b.cost;
      a.margin += b.margin;
    }
    ret.count += d.returns.count;
    ret.value += d.returns.value;
    ret.grossRefund += d.returns.grossRefund;
    ret.adjustments += d.returns.adjustments;
    ret.costCredited += d.returns.costCredited;
    ret.profitEffect += d.returns.profitEffect;
    ret.phones += d.returns.phones;
    exp.recorded += d.expenses.recorded;
    exp.recordedCount += d.expenses.recordedCount;
    exp.reversed += d.expenses.reversed;
    exp.reversedCount += d.expenses.reversedCount;
  }
  for (const o of [inv, can]) {
    o.value = round2(o.value);
    o.cost = round2(o.cost);
    o.margin = round2(o.margin);
  }
  for (const k of ['value', 'grossRefund', 'adjustments', 'costCredited', 'profitEffect'] as const) ret[k] = round2(ret[k]);
  exp.recorded = round2(exp.recorded);
  exp.reversed = round2(exp.reversed);
  exp.net = round2(exp.recorded - exp.reversed);
  return withNet({ invoices: inv, cancellations: can, returns: ret, expenses: exp });
}

function withNet(f: Omit<PeriodFigures, 'net'>): PeriodFigures {
  return {
    ...f,
    net: {
      salesValue: round2(f.invoices.value - f.returns.value - f.cancellations.value),
      salesCount: f.invoices.count - f.cancellations.count,
      units: f.invoices.units - f.cancellations.units,
      phones: f.invoices.phones - f.cancellations.phones,
    },
  };
}

/**
 * One product's cancellations and returns approved from a date on (docs/53 D34), on the product
 * report's own basis — each line at its share of its invoice's recorded total (docs/54 D36).
 */
export interface ProductAdjustment {
  productId: Buffer;
  categoryId: Buffer | null;
  cancelledUnits: number;
  /** Σ the cancelled lines' shares of their invoices' totals — what their sale put on. */
  cancelledRevenue: number;
  cancelledCogs: number;
  returnedUnits: number;
  /** Σ net refund due of the returns. */
  returnedRevenue: number;
  /** Σ line cost credited back by the returns. */
  returnedCostCredited: number;
}

export async function productAdjustments(db: RawRunner, companyId: Buffer, branchId: Buffer | null, from: string): Promise<ProductAdjustment[]> {
  const branch = (col: string) => (branchId ? Prisma.sql`AND ${Prisma.raw(col)} = ${branchId}` : Prisma.empty);
  const [cancelled, returned] = await Promise.all([
    // Every line of each cancelled sale, with its sale's total: a share is weighed against its siblings.
    db.$queryRaw<{ id: Buffer; sale_id: Buffer; price: unknown; quantity: unknown; discount: unknown; cost: unknown; sale_total: unknown; product_id: Buffer | null; category_id: Buffer | null }[]>(Prisma.sql`
      SELECT si.id, si.sale_id, si.price, si.quantity, si.discount, si.cost, s.total AS sale_total,
             p.id AS product_id, p.category_id AS category_id
        FROM financial_corrections fc
        JOIN sales s ON s.id = fc.target_sale_id
        JOIN sale_items si ON si.sale_id = s.id AND si.voided = 0
        LEFT JOIN units u ON u.id = si.unit_id
        LEFT JOIN products p ON p.id = COALESCE(si.product_id, u.product_id)
       WHERE fc.company_id = ${companyId} ${branch('fc.branch_id')}
         AND fc.target_kind = 'sale' AND fc.status = 'approved' AND fc.correction_date >= ${from}`),
    db.$queryRaw<{ product_id: Buffer; category_id: Buffer | null; n: bigint; revenue: unknown; cost: unknown }[]>(Prisma.sql`
      SELECT u.product_id AS product_id, p.category_id AS category_id,
             COUNT(*) AS n, SUM(rr.net_refund_due) AS revenue, SUM(rr.line_cost) AS cost
        FROM return_reversals rr
        JOIN units u ON u.id = rr.unit_id
        JOIN products p ON p.id = u.product_id
       WHERE rr.company_id = ${companyId} ${branch('rr.branch_id')} AND rr.approval_date >= ${from}
       GROUP BY u.product_id, p.category_id`),
  ]);
  const byProduct = new Map<string, ProductAdjustment>();
  const entry = (productId: Buffer, categoryId: Buffer | null) => {
    const key = productId.toString('hex');
    const found = byProduct.get(key);
    if (found) return found;
    const fresh: ProductAdjustment = { productId, categoryId, cancelledUnits: 0, cancelledRevenue: 0, cancelledCogs: 0, returnedUnits: 0, returnedRevenue: 0, returnedCostCredited: 0 };
    byProduct.set(key, fresh);
    return fresh;
  };
  const shares = sharesBySale(
    cancelled.map((l) => ({ id: l.id, saleId: l.sale_id, price: String(l.price), quantity: Number(l.quantity), discount: String(l.discount), saleTotal: String(l.sale_total) })),
  );
  for (const l of cancelled) {
    if (!l.product_id) continue;
    const e = entry(l.product_id, l.category_id);
    e.cancelledUnits += Number(l.quantity);
    e.cancelledRevenue = round2(e.cancelledRevenue + fromCents(shares.get(l.id.toString('hex')) ?? 0n));
    e.cancelledCogs = round2(e.cancelledCogs + fromCents(toCents(String(l.cost)) * BigInt(Number(l.quantity))));
  }
  for (const r of returned) {
    const e = entry(r.product_id, r.category_id);
    e.returnedUnits += Number(r.n);
    e.returnedRevenue = round2(e.returnedRevenue + num(r.revenue));
    e.returnedCostCredited = round2(e.returnedCostCredited + num(r.cost));
  }
  return [...byProduct.values()];
}

/** One seller's figures over a window of business dates [from, until) (docs/53 D34). */
export interface SellerFigures {
  userId: Buffer;
  invoices: number;
  cancellations: number;
  returns: number;
  /** invoices − cancellations (R5). */
  salesCount: number;
  /** Σ invoice totals − cancelled totals − net refunds due. */
  revenue: number;
  /** Σ invoice margins − cancelled margins − returns' profit effect. */
  margin: number;
}

export async function sellerFigures(db: RawRunner, companyId: Buffer, branchId: Buffer | null, from: string, until: string | null): Promise<SellerFigures[]> {
  const branch = (col: string) => (branchId ? Prisma.sql`AND ${Prisma.raw(col)} = ${branchId}` : Prisma.empty);
  const window = (col: string) => Prisma.sql`AND ${Prisma.raw(col)} >= ${from} ${until ? Prisma.sql`AND ${Prisma.raw(col)} < ${until}` : Prisma.empty}`;
  type Row = { user_id: Buffer; n: bigint; value: unknown; margin: unknown };
  const [invoices, cancelled, returned] = await Promise.all([
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT s.user_id, COUNT(*) AS n, SUM(s.total) AS value, SUM(s.margin) AS margin
        FROM sales s
       WHERE s.company_id = ${companyId} ${branch('s.branch_id')} AND s.is_reversed = 0 ${window('s.business_date')}
       GROUP BY s.user_id`),
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT s.user_id, COUNT(*) AS n, SUM(s.total) AS value, SUM(s.margin) AS margin
        FROM financial_corrections fc
        JOIN sales s ON s.id = fc.target_sale_id
       WHERE fc.company_id = ${companyId} ${branch('fc.branch_id')}
         AND fc.target_kind = 'sale' AND fc.status = 'approved' ${window('fc.correction_date')}
       GROUP BY s.user_id`),
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT s.user_id, COUNT(*) AS n, SUM(rr.net_refund_due) AS value, SUM(rr.gross_refund - rr.adjustment_total - rr.line_cost) AS margin
        FROM return_reversals rr
        JOIN sales s ON s.id = rr.sale_id
       WHERE rr.company_id = ${companyId} ${branch('rr.branch_id')} ${window('rr.approval_date')}
       GROUP BY s.user_id`),
  ]);
  const bySeller = new Map<string, SellerFigures>();
  const entry = (userId: Buffer) => {
    const key = userId.toString('hex');
    const found = bySeller.get(key);
    if (found) return found;
    const fresh: SellerFigures = { userId, invoices: 0, cancellations: 0, returns: 0, salesCount: 0, revenue: 0, margin: 0 };
    bySeller.set(key, fresh);
    return fresh;
  };
  for (const r of invoices) {
    const e = entry(r.user_id);
    e.invoices += Number(r.n);
    e.revenue += num(r.value);
    e.margin += num(r.margin);
  }
  for (const r of cancelled) {
    const e = entry(r.user_id);
    e.cancellations += Number(r.n);
    e.revenue -= num(r.value);
    e.margin -= num(r.margin);
  }
  for (const r of returned) {
    const e = entry(r.user_id);
    e.returns += Number(r.n);
    e.revenue -= num(r.value);
    e.margin -= num(r.margin);
  }
  return [...bySeller.values()].map((e) => ({ ...e, salesCount: e.invoices - e.cancellations, revenue: round2(e.revenue), margin: round2(e.margin) }));
}
