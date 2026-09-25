import { Injectable } from '@nestjs/common';
import { Prisma, TrackingType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { heldValueRows } from './held-value';
import { fromCents, sharesBySale, toCents } from '../sales/sale-shares';

/** Coerce a raw SQL aggregate (Decimal string | bigint | null) to a number. */
function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v as number | string);
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

interface RefundPaidRow {
  paid_total: unknown;
  paid_cash: unknown;
  paid_count: unknown;
}

interface ReturnTotalsRow {
  gross: unknown;
  adjustments: unknown;
  cogs_credited: unknown;
  returns_count: unknown;
}

/** One non-voided sale line with what its share needs: its sale's total, and every sibling (docs/54 D36). */
interface SaleLineRow {
  id: Buffer;
  sale_id: Buffer;
  price: unknown;
  quantity: unknown;
  discount: unknown;
  cost: unknown;
  sale_total: unknown;
}

interface DayLineRow extends SaleLineRow {
  product_id: Buffer | null;
  category_id: Buffer | null;
  tracking_type: TrackingType | null;
}

/** The lines as `sharesBySale` reads them. */
const shareLines = (rows: readonly SaleLineRow[]) =>
  rows.map((r) => ({ id: r.id, saleId: r.sale_id, price: String(r.price), quantity: Number(r.quantity), discount: String(r.discount), saleTotal: String(r.sale_total) }));

/** Σ share, Σ cost, Σ units of some lines, the shares taken from the invoice totals. */
function lineTotals(rows: readonly SaleLineRow[], shares: Map<string, bigint>) {
  let revenue = 0n;
  let cogs = 0n;
  let qty = 0;
  for (const r of rows) {
    revenue += shares.get(r.id.toString('hex')) ?? 0n;
    cogs += toCents(String(r.cost)) * BigInt(Number(r.quantity));
    qty += Number(r.quantity);
  }
  return { revenue: fromCents(revenue), cogs: fromCents(cogs), qty };
}

interface ValuationSourceRow {
  kind: 'unit' | 'stock';
  product_id: Buffer;
  category_id: Buffer | null;
  tracking_type: TrackingType;
  units_count?: unknown;
  quantity?: unknown;
  inv_value: unknown;
  exp_rev: unknown;
}

interface ValuationAcc {
  categoryId: Buffer | null;
  trackingType: TrackingType;
  unitsCount: number;
  quantity: number;
  inventoryValue: number;
  expectedRevenue: number;
}

/**
 * Recomputes analytics rollups from the source-of-truth tables. Uses the
 * SYSTEM Prisma client (no tenant CLS) so it can run from a background worker
 * later; every query is filtered by an explicit company_id.
 *
 * TRACKING-TYPE INDEPENDENT: all figures derive from `sale_items`
 * (price/cost/discount/quantity), each line valued at its share of the
 * recorded invoice total — a whole-invoice discount included (docs/54 D36,
 * `sale-shares.ts`). The product for a line is resolved as
 * COALESCE(sale_item.product_id, unit.product_id), so IMEI, serial, and
 * quantity lines flow through identical math — no identifier is ever read.
 */
@Injectable()
export class RollupService {
  constructor(private readonly prisma: PrismaService) {}

  /** The recompute in flight for each branch-day, so a second caller waits for it rather than interleaving. */
  private readonly inFlight = new Map<string, Promise<void>>();

  /**
   * Recompute one branch-day — one at a time per branch-day (docs/51 §12.6).
   *
   * The recompute replaces derived rows (delete, then insert). Two callers at the
   * same moment — a close and a correction approval, two taps on Close — would
   * interleave those steps and collide on the unique keys, failing a request whose
   * own work had already committed. Each caller now runs after the one before it
   * for the same branch-day; both compute the same figures from the same records.
   * The API is one process, as the in-process rollup queue already assumes.
   */
  async recomputeDaily(companyId: Buffer, branchId: Buffer, day: string): Promise<void> {
    const key = `${branchId.toString('hex')}:${day}`;
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.recomputeDailyNow(companyId, branchId, day));
    this.inFlight.set(key, run);
    try {
      await run;
    } finally {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    }
  }

  private async recomputeDailyNow(companyId: Buffer, branchId: Buffer, day: string): Promise<void> {
    // The day is a STORED business date (0076): every sale carries the date it
    // was assigned when written, so this recompute can never move a sale
    // between days, whatever the zone or the rule says now.
    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const now = new Date();

    /**
     * 1. The branch-day's sale lines (voided lines excluded), each valued at its
     * share of its invoice's recorded total. Revenue is therefore Σ `sales.total` —
     * what the Daily closing, Home and Money read — whole-invoice discount and all;
     * it used to be Σ(price × quantity − line discount), which left that discount
     * out of Results, goals, branches and the product report (docs/54 D36).
     */
    const dayLines = await this.prisma.$queryRaw<DayLineRow[]>(Prisma.sql`
      SELECT si.id, si.sale_id, si.price, si.quantity, si.discount, si.cost, s.total AS sale_total,
             p.id AS product_id, p.category_id AS category_id, p.tracking_type AS tracking_type
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN units u ON u.id = si.unit_id
      LEFT JOIN products p ON p.id = COALESCE(si.product_id, u.product_id)
      WHERE si.company_id = ${companyId}
        AND s.branch_id = ${branchId}
        AND si.voided = 0
        AND s.business_date = ${day}
    `);
    const dayShares = sharesBySale(shareLines(dayLines));
    const totals = lineTotals(dayLines, dayShares);
    const salesCount = new Set(dayLines.map((l) => l.sale_id.toString('hex'))).size;
    /**
     * Expenses for this day (Milestone D). Three things changed here, and each
     * was a defect:
     *
     * **Only CONFIRMED expenses count.** The old query summed every row, so a
     * report that nobody had agreed to already reduced the day's profit.
     *
     * **The date depends on the class.** A `variable` expense belongs to the
     * day it was CONFIRMED; a `fixed` one to its DUE date. Keying both on
     * `spent_on` put rent in whatever day somebody happened to type it.
     *
     * **Cash is separated.** Only cash left the drawer, so only cash may be
     * subtracted from expected cash — an account transfer never touched it.
     * The old schema could not express the difference at all.
     */
    const expRows = await this.prisma.$queryRaw<
      Array<{
        expenses: unknown;
        expenses_cash: unknown;
        expenses_count: unknown;
        expenses_fixed: unknown;
        expenses_salary: unknown;
      }>
    >(Prisma.sql`
      SELECT COALESCE(SUM(amount), 0)                                          AS expenses,
             COALESCE(SUM(CASE WHEN method = 'cash' THEN amount END), 0)       AS expenses_cash,
             COUNT(*)                                                          AS expenses_count,
             COALESCE(SUM(CASE WHEN expense_class = 'fixed' THEN amount END), 0) AS expenses_fixed,
             COALESCE(SUM(CASE WHEN is_salary = 1 THEN amount END), 0)         AS expenses_salary
      FROM expenses
      WHERE company_id = ${companyId}
        AND branch_id = ${branchId}
        AND status = 'confirmed'
        AND (
          (expense_class = 'variable' AND confirmation_date = ${day})
          OR (expense_class = 'fixed' AND due_date = ${day})
        )
    `);
    const expensesCash = round2(toNum(expRows[0].expenses_cash));
    const expensesCount = toNum(expRows[0].expenses_count);

    /**
     * Returns approved ON THIS DAY (I2).
     *
     * Keyed on `approval_date`, never on the sale's day — that is precisely what
     * lets the original day recompute byte-identically and keeps a closed day
     * closed. The legacy endpoint did the opposite: it set `voided = true`, and
     * because the query above filters `si.voided = 0`, every return silently
     * rewrote a past day's revenue and profit.
     *
     * ## What is reversed, and what is deliberately not
     *
     * Revenue falls by the NET refund due — the money actually going back.
     * Anything withheld as an adjustment (a consumed screen protector) is money
     * the shop keeps, so it stays as revenue.
     *
     * COGS is NOT credited back. The returned phone is held as `faulty` and is
     * unsellable, and `held-value` counts only `in_stock`, so the goods are not
     * an asset again. Crediting the cost here while the asset is absent from
     * inventory would book the benefit twice and overstate profit. Cost recovery
     * belongs to the later inspection milestone, when the phone either returns
     * to sellable stock or is written off — and `returns_cogs` exists for that
     * day.
     *
     * So the profit impact of an approved return is the full net refund. That is
     * the conservative reading, and the one that cannot flatter a month.
     */
    const returnRows = await this.prisma.$queryRaw<ReturnTotalsRow[]>(Prisma.sql`
      SELECT COALESCE(SUM(gross_refund), 0)     AS gross,
             COALESCE(SUM(adjustment_total), 0) AS adjustments,
             COALESCE(SUM(line_cost), 0)        AS cogs_credited,
             COUNT(*)                           AS returns_count
      FROM return_reversals
      WHERE company_id = ${companyId}
        AND branch_id = ${branchId}
        AND approval_date = ${day}
    `);
    // Components, all POSITIVE magnitudes; each consumer applies its own sign.
    const returnsRevenue = round2(toNum(returnRows[0].gross));
    const returnsAdjustments = round2(toNum(returnRows[0].adjustments));
    const returnsCogs = round2(toNum(returnRows[0].cogs_credited));
    const returnsCount = toNum(returnRows[0].returns_count);
    /**
     * The profit effect of the day's returns, as a positive REDUCTION:
     *
     *   effect = gross refund − adjustments kept − COGS credited back
     *
     * so net profit subtracts it. Across a sale and its return this leaves
     * cumulative profit equal to the adjustments alone:
     *
     *   sale    + gross − cost
     *   return  − gross + adjustments + cost
     *   ------------------------------------
     *   total   + adjustments
     *
     * The COGS credit is what makes that true. The phone is unsellable but the
     * shop still owns it, and its cost is reinstated as faulty/return-held
     * inventory value (see `faultyHeldValue`). Writing the asset to zero here
     * would be a full impairment decided before anyone inspected the phone —
     * which is the LATER milestone's call, not this one's.
     */
    const returnsGrossProfit = round2(returnsRevenue - returnsAdjustments - returnsCogs);

    /**
     * Refunds CONFIRMED on this day (I3) — money leaving the till.
     *
     * Keyed on `confirmation_date`, which is a different day from the approval
     * that reversed the profit. That separation is the whole point:
     *
     *   approval day     profit reverses, a liability appears
     *   confirmation day cash moves, the liability settles
     *
     * There is deliberately NO profit component here. Profit was already
     * reversed at approval, and subtracting it again at payout would count the
     * same loss twice — the single easiest mistake to make in this phase.
     */
    const refundRows = await this.prisma.$queryRaw<RefundPaidRow[]>(Prisma.sql`
      SELECT COALESCE(SUM(reported_amount), 0)                                     AS paid_total,
             COALESCE(SUM(CASE WHEN method = 'cash' THEN reported_amount END), 0)   AS paid_cash,
             COUNT(*)                                                              AS paid_count
      FROM refund_payouts
      WHERE company_id = ${companyId}
        AND branch_id = ${branchId}
        AND status = 'confirmed'
        AND confirmation_date = ${day}
    `);
    const refundsPaidTotal = round2(toNum(refundRows[0].paid_total));
    const refundsPaidCash = round2(toNum(refundRows[0].paid_cash));
    const refundsPaidCount = toNum(refundRows[0].paid_count);

    /**
     * Money that came BACK because a confirmed payment was corrected
     * (Milestone B), keyed on the correction day — never on the day of the
     * payment it reverses.
     *
     * Note what is deliberately absent: the refund query above is NOT filtered
     * to exclude corrected payouts. The original payment genuinely happened on
     * its own day and that day's figures stand; the correction is a separate
     * movement on a separate day. Filtering both would remove the money twice.
     *
     * Like a refund, this has **no profit component**. Profit was reversed at
     * return approval and a supplier payment never had one — this moves cash
     * and liability only.
     */
    const correctionRows = await this.prisma.$queryRaw<RefundPaidRow[]>(Prisma.sql`
      SELECT COALESCE(SUM(amount), 0)                                     AS paid_total,
             COALESCE(SUM(CASE WHEN method = 'cash' THEN amount END), 0)  AS paid_cash,
             COUNT(*)                                                     AS paid_count
      FROM financial_corrections
      WHERE company_id = ${companyId}
        AND branch_id = ${branchId}
        AND status = 'approved'
        AND correction_date = ${day}
        -- Money coming BACK only: a payment reclassified to another channel (0078) moves money
        -- between channels, and the closing's channel figures carry both of its legs.
        AND target_kind IN ('refund_payout', 'supplier_settlement')
    `);
    const correctionsTotal = round2(toNum(correctionRows[0].paid_total));
    const correctionsCash = round2(toNum(correctionRows[0].paid_cash));
    const correctionsCount = toNum(correctionRows[0].paid_count);

    /**
     * Sales CANCELLED on this day (0079), on the rollup's own revenue basis — the
     * cancelled sale's lines at their shares of its recorded total, so a cancellation
     * takes off exactly what its sale put on (docs/54 D36). Keyed on the correction day,
     * never on the sale's day, which recomputes byte-identically and keeps its
     * closing shut; the line itself is never voided (`released_by_correction_id`
     * only frees its phone). Positive magnitudes: net profit subtracts
     * (revenue − cogs), exactly as a return subtracts its effect; the units-sold
     * goal subtracts the units (0080).
     */
    const cancelledLines = await this.prisma.$queryRaw<(SaleLineRow & { correction_id: Buffer })[]>(Prisma.sql`
      SELECT si.id, si.sale_id, si.price, si.quantity, si.discount, si.cost, s.total AS sale_total, fc.id AS correction_id
      FROM financial_corrections fc
      JOIN sales s ON s.id = fc.target_sale_id
      JOIN sale_items si ON si.sale_id = s.id AND si.voided = 0
      WHERE fc.company_id = ${companyId}
        AND fc.branch_id = ${branchId}
        AND fc.target_kind = 'sale'
        AND fc.status = 'approved'
        AND fc.correction_date = ${day}
    `);
    const cancelled = lineTotals(cancelledLines, sharesBySale(shareLines(cancelledLines)));
    const cancelledRevenue = cancelled.revenue;
    const cancelledCogs = cancelled.cogs;
    const cancelledCount = new Set(cancelledLines.map((l) => l.correction_id.toString('hex'))).size;
    const cancelledQty = cancelled.qty;

    /**
     * Confirmed expenses REVERSED on this day (0079). `expenses` below is net of
     * them, so profit and every reader of the day's expenses see what was really
     * spent. `expensesCash` stays the cash that left: the reversal's cash comes
     * back as a correction leg, which the closing already counts — subtracting it
     * here as well would count it twice. The fixed and salary figures are net
     * of their own reversals for the same reason the total is.
     */
    const reversalRows = await this.prisma.$queryRaw<{ total: unknown; fixed: unknown; salary: unknown }[]>(Prisma.sql`
      SELECT COALESCE(SUM(fc.amount), 0)                                           AS total,
             COALESCE(SUM(CASE WHEN e.expense_class = 'fixed' THEN fc.amount END), 0) AS fixed,
             COALESCE(SUM(CASE WHEN e.is_salary = 1 THEN fc.amount END), 0)         AS salary
      FROM financial_corrections fc
      JOIN expenses e ON e.id = fc.target_expense_id
      WHERE fc.company_id = ${companyId}
        AND fc.branch_id = ${branchId}
        AND fc.target_kind = 'expense'
        AND fc.status = 'approved'
        AND fc.correction_date = ${day}
    `);
    const expenseReversals = round2(toNum(reversalRows[0].total));
    const expensesFixed = round2(toNum(expRows[0].expenses_fixed) - toNum(reversalRows[0].fixed));
    const expensesSalary = round2(toNum(expRows[0].expenses_salary) - toNum(reversalRows[0].salary));

    const revenue = totals.revenue;
    const cogs = totals.cogs;
    const grossProfit = round2(revenue - cogs);
    const expenses = round2(toNum(expRows[0].expenses) - expenseReversals);
    // Positive magnitudes, subtracted explicitly. A negative stored revenue
    // would leave every reader guessing whether the sign was already applied.
    const netProfit = round2(grossProfit - returnsGrossProfit - (cancelledRevenue - cancelledCogs) - expenses);

    /**
     * Two recomputes of the same branch-day at the same moment — a close and a
     * correction approval, or two taps — both find no row and both insert; the
     * loser meets the unique key. The row is derived and both computed the same
     * figures from the same records, so the loser simply writes again, now as an
     * update (docs/51 §12.6: a committed correction must never be reported as a
     * failure because its rollup lost a race).
     */
    const write = () =>
      this.prisma.dailyRollup.upsert({
        where: { branchId_day: { branchId, day: dayDate } },
        create: {
          id: newUuidV7Bin(),
          companyId,
          branchId,
          day: dayDate,
          revenue,
          cogs,
          grossProfit,
          salesCount,
          qtySold: totals.qty,
          expenses,
          netProfit,
          returnsRevenue,
          returnsCogs,
          returnsAdjustments,
          returnsGrossProfit,
          returnsCount,
          refundsPaidTotal,
          refundsPaidCash,
          refundsPaidCount,
          correctionsTotal,
          correctionsCash,
          correctionsCount,
          expensesCash,
          expensesCount,
          expensesFixed,
          expensesSalary,
          cancelledRevenue,
          cancelledCogs,
          cancelledCount,
          cancelledQty,
          expenseReversals,
          refreshedAt: now,
        },
        update: {
          revenue,
          cogs,
          grossProfit,
          salesCount,
          qtySold: totals.qty,
          expenses,
          netProfit,
          returnsRevenue,
          returnsCogs,
          returnsAdjustments,
          returnsGrossProfit,
          returnsCount,
          refundsPaidTotal,
          refundsPaidCash,
          refundsPaidCount,
          correctionsTotal,
          correctionsCash,
          correctionsCount,
          expensesCash,
          expensesCount,
          expensesFixed,
          expensesSalary,
          cancelledRevenue,
          cancelledCogs,
          cancelledCount,
          cancelledQty,
          expenseReversals,
          refreshedAt: now,
        },
      });
    try {
      await write();
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      await write();
    }

    // 2. Per-product fact — the same lines, the product resolved via COALESCE so serialized
    //    units (product_id NULL, unit_id set) and quantity lines aggregate the same, each at
    //    its share: the products of a day add up to the day's revenue.
    const byProduct = new Map<string, { productId: Buffer; categoryId: Buffer | null; trackingType: TrackingType; lines: DayLineRow[] }>();
    for (const l of dayLines) {
      if (!l.product_id || !l.tracking_type) continue;
      const key = l.product_id.toString('hex');
      const found = byProduct.get(key);
      if (found) found.lines.push(l);
      else byProduct.set(key, { productId: l.product_id, categoryId: l.category_id, trackingType: l.tracking_type, lines: [l] });
    }
    const rows = [...byProduct.values()].map((p) => ({ ...p, ...lineTotals(p.lines, dayShares) }));

    // Rebuild the branch-day product facts (delete + insert = current truth).
    await this.prisma.productDailyRollup.deleteMany({ where: { branchId, day: dayDate } });
    if (rows.length > 0) {
      await this.prisma.productDailyRollup.createMany({
        data: rows.map((r) => ({
          id: newUuidV7Bin(),
          companyId,
          branchId,
          day: dayDate,
          productId: r.productId,
          categoryId: r.categoryId ?? null,
          trackingType: r.trackingType,
          qtySold: r.qty,
          revenue: r.revenue,
          cogs: r.cogs,
          grossProfit: round2(r.revenue - r.cogs),
          refreshedAt: now,
        })),
      });
    }
  }

  /**
   * Current $ invested + expected profit per product at a branch, combining
   * BOTH storage shapes: in-stock individual units (units.cost, expected at
   * products.default_price) and quantity stock (stock_items.qty × cost, expected
   * at stock_items.price). Uniform across tracking types.
   */
  async recomputeInventoryValuation(companyId: Buffer, branchId: Buffer): Promise<void> {
    const now = new Date();

    /**
     * The same query the live report runs (H1.4.1). Both go through
     * `heldValueRows` so the stored figure and the reported figure cannot drift
     * into two different definitions of what stock is worth.
     */
    const rows = await heldValueRows(this.prisma, { companyId, branchId });

    const byProduct = new Map<string, ValuationAcc & { productId: Buffer }>();
    const merge = (r: ValuationSourceRow, isUnit: boolean) => {
      const key = r.product_id.toString('hex');
      const acc =
        byProduct.get(key) ??
        {
          productId: r.product_id,
          categoryId: r.category_id ?? null,
          trackingType: r.tracking_type,
          unitsCount: 0,
          quantity: 0,
          inventoryValue: 0,
          expectedRevenue: 0,
        };
      if (isUnit) acc.unitsCount += toNum(r.units_count);
      else acc.quantity += toNum(r.quantity);
      acc.inventoryValue += toNum(r.inv_value);
      acc.expectedRevenue += toNum(r.exp_rev);
      byProduct.set(key, acc);
    };
    rows.forEach((r) => merge(r, r.kind === 'unit'));

    await this.prisma.inventoryValuation.deleteMany({ where: { companyId, branchId } });
    if (byProduct.size > 0) {
      await this.prisma.inventoryValuation.createMany({
        data: [...byProduct.values()].map((a) => {
          const inventoryValue = round2(a.inventoryValue);
          const expectedRevenue = round2(a.expectedRevenue);
          return {
            id: newUuidV7Bin(),
            companyId,
            branchId,
            productId: a.productId,
            categoryId: a.categoryId,
            trackingType: a.trackingType,
            unitsCount: a.unitsCount,
            quantity: a.quantity,
            inventoryValue,
            expectedRevenue,
            expectedProfit: round2(expectedRevenue - inventoryValue),
            refreshedAt: now,
          };
        }),
      });
    }
  }

  /**
   * Refresh the branch's stock snapshot (valuation). How products are moving is no
   * longer a snapshot: `movement.ts` reads it from the sales that stand whenever it is
   * asked, so "the last 30 days" always ends today (docs/54 D39).
   */
  async refreshBranch(companyId: Buffer, branchId: Buffer): Promise<void> {
    await this.recomputeInventoryValuation(companyId, branchId);
  }
}
