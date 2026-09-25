import { Prisma } from '@prisma/client';
import { binToUuid } from '../common/utils/uuid.util';
import type {
  CancellationFigures,
  ChannelSplit,
  CollectedForSales,
  ExpenseLine,
  ExpenseReversalLine,
  ReturnFigures,
  SalesFigures,
} from './closing-report';
import { MISSING_COST_EPSILON } from './closing-report';

/**
 * The reads behind the Daily closing report (docs/51 §3). Every query filters the
 * company explicitly — a raw query is not scoped by the tenant extension — and
 * reaches the branch the way the record itself does: `sales.branch_id` for a
 * payment, `purchases.branch_id` for a purchase payment, its own `branch_id`
 * otherwise. Every date is the STORED business date (or the confirmation / due /
 * approval date the record already carried), never a timestamp's calendar day.
 */

/** Anything that can run a raw query: the tenant client or a transaction. */
export interface RawRunner {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v as Prisma.Decimal));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** S1 — the date's completed sales: count, value, items, recorded cost, lines with no cost. */
export async function salesFigures(db: RawRunner, companyId: Buffer, branchId: Buffer, date: string): Promise<SalesFigures> {
  const [head] = await db.$queryRaw<{ n: bigint; value: unknown; cost: unknown }[]>(Prisma.sql`
    SELECT COUNT(*) AS n, COALESCE(SUM(s.total), 0) AS value, COALESCE(SUM(s.total_cost), 0) AS cost
      FROM sales s
     WHERE s.company_id = ${companyId} AND s.branch_id = ${branchId}
       AND s.business_date = ${date} AND s.is_reversed = 0`);
  const [lines] = await db.$queryRaw<{ items: unknown; missing: bigint }[]>(Prisma.sql`
    SELECT COALESCE(SUM(si.quantity), 0) AS items,
           COALESCE(SUM(si.cost <= ${MISSING_COST_EPSILON}), 0) AS missing
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
     WHERE s.company_id = ${companyId} AND s.branch_id = ${branchId}
       AND s.business_date = ${date} AND s.is_reversed = 0 AND si.voided = 0`);
  return {
    count: Number(head?.n ?? 0),
    value: round2(num(head?.value)),
    cost: round2(num(head?.cost)),
    itemsSold: Number(num(lines?.items)),
    missingCostLines: Number(lines?.missing ?? 0),
  };
}

/** S2 — returns approved on the date (they may concern earlier sales). */
export async function returnFigures(db: RawRunner, companyId: Buffer, branchId: Buffer, date: string): Promise<ReturnFigures> {
  const [r] = await db.$queryRaw<{ n: bigint; gross: unknown; adj: unknown; net: unknown; cost: unknown; missing: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(gross_refund), 0) AS gross,
           COALESCE(SUM(adjustment_total), 0) AS adj,
           COALESCE(SUM(net_refund_due), 0) AS net,
           COALESCE(SUM(line_cost), 0) AS cost,
           COALESCE(SUM(line_cost <= ${MISSING_COST_EPSILON}), 0) AS missing
      FROM return_reversals
     WHERE company_id = ${companyId} AND branch_id = ${branchId} AND approval_date = ${date}`);
  return {
    count: Number(r?.n ?? 0),
    grossRefund: round2(num(r?.gross)),
    adjustments: round2(num(r?.adj)),
    netRefundDue: round2(num(r?.net)),
    costCredited: round2(num(r?.cost)),
    missingCostLines: Number(r?.missing ?? 0),
  };
}

/**
 * S3 — money held against the date's OWN sales as it stood at the end of the date:
 * taken at the till, and collected later the same date. A payment on a later date
 * does not belong to this date's report, however soon it came.
 */
export async function collectedForSales(db: RawRunner, companyId: Buffer, branchId: Buffer, date: string): Promise<CollectedForSales> {
  const rows = await db.$queryRaw<{ kind: string; total: unknown }[]>(Prisma.sql`
    SELECT p.kind AS kind, COALESCE(SUM(p.amount), 0) AS total
      FROM payments p
      JOIN sales s ON s.id = p.sale_id
     WHERE p.company_id = ${companyId} AND s.branch_id = ${branchId}
       AND s.business_date = ${date} AND s.is_reversed = 0
       AND p.business_date <= ${date}
     GROUP BY p.kind`);
  const of = (k: string) => round2(num(rows.find((r) => r.kind === k)?.total));
  /**
   * What corrections posted by the end of the date did to that money (0079): the legs
   * of the date's sales' payments — a payment never received and a cancelled sale's
   * money given back take it out; a move between channels puts it back in elsewhere
   * and nets to zero. A correction on a later day belongs to that day, never here.
   */
  const [adj] = await db.$queryRaw<{ total: unknown }[]>(Prisma.sql`
    SELECT COALESCE(SUM(IF(l.direction = 'in', l.amount, -l.amount)), 0) AS total
      FROM financial_correction_legs l
      JOIN financial_corrections fc ON fc.id = l.correction_id
      JOIN payments p ON p.id = l.source_payment_id
      JOIN sales s ON s.id = p.sale_id
     WHERE fc.company_id = ${companyId} AND s.branch_id = ${branchId}
       AND s.business_date = ${date} AND s.is_reversed = 0
       AND fc.status = 'approved' AND fc.correction_date <= ${date}`);
  return { atCheckout: of('at_sale'), laterSameDay: of('collection'), corrections: round2(num(adj?.total)) };
}

/**
 * Sales cancelled ON the date (0079), whatever day they were sold: their value and
 * recorded cost come off this date's result, never off the day they were sold. The
 * lines of a cancelled sale with no recorded cost make the result incalculable here
 * too, exactly as they did on their own day.
 */
export async function cancellationFigures(db: RawRunner, companyId: Buffer, branchId: Buffer, date: string): Promise<CancellationFigures> {
  const [head] = await db.$queryRaw<{ n: bigint; value: unknown; cost: unknown; own: unknown }[]>(Prisma.sql`
    SELECT COUNT(*) AS n, COALESCE(SUM(s.total), 0) AS value, COALESCE(SUM(s.total_cost), 0) AS cost,
           COALESCE(SUM(IF(s.business_date = ${date}, s.total, 0)), 0) AS own
      FROM financial_corrections fc
      JOIN sales s ON s.id = fc.target_sale_id
     WHERE fc.company_id = ${companyId} AND fc.branch_id = ${branchId}
       AND fc.target_kind = 'sale' AND fc.status = 'approved' AND fc.correction_date = ${date}`);
  const [lines] = await db.$queryRaw<{ items: unknown; missing: unknown }[]>(Prisma.sql`
    SELECT COALESCE(SUM(si.quantity), 0) AS items,
           COALESCE(SUM(si.cost <= ${MISSING_COST_EPSILON}), 0) AS missing
      FROM financial_corrections fc
      JOIN sale_items si ON si.sale_id = fc.target_sale_id AND si.voided = 0
     WHERE fc.company_id = ${companyId} AND fc.branch_id = ${branchId}
       AND fc.target_kind = 'sale' AND fc.status = 'approved' AND fc.correction_date = ${date}`);
  return {
    count: Number(head?.n ?? 0),
    value: round2(num(head?.value)),
    cost: round2(num(head?.cost)),
    items: Number(num(lines?.items)),
    missingCostLines: Number(num(lines?.missing)),
    ofTheseSales: round2(num(head?.own)),
  };
}

/** Confirmed expenses reversed ON the date (0079), whatever day they were recorded. */
export async function expenseReversalLines(db: RawRunner, companyId: Buffer, branchId: Buffer, date: string): Promise<ExpenseReversalLine[]> {
  const rows = await db.$queryRaw<
    { id: Buffer; expense_id: Buffer; category: string; expense_class: string; is_salary: number; amount: unknown; method: string; label: string | null }[]
  >(Prisma.sql`
    SELECT fc.id, e.id AS expense_id, e.category, e.expense_class, e.is_salary, fc.amount, fc.method, fc.account_label_snapshot AS label
      FROM financial_corrections fc
      JOIN expenses e ON e.id = fc.target_expense_id
     WHERE fc.company_id = ${companyId} AND fc.branch_id = ${branchId}
       AND fc.target_kind = 'expense' AND fc.status = 'approved' AND fc.correction_date = ${date}
     ORDER BY fc.amount DESC, fc.id`);
  return rows.map((r) => ({
    correctionId: binToUuid(r.id),
    expenseId: binToUuid(r.expense_id),
    category: r.category,
    expenseClass: r.expense_class === 'fixed' ? 'fixed' : 'variable',
    isSalary: Number(r.is_salary) === 1,
    amount: round2(num(r.amount)),
    method: r.method === 'cash' ? 'cash' : 'account',
    accountLabel: r.label,
  }));
}

/**
 * The date's payments per channel, split by whose sale they settle: the date's own
 * sales, or an earlier date's (an older debt collected today). Split on the sale's
 * business date, never on `payments.kind` — a balance paid later the same day is a
 * `collection` of today's sale, not an old debt.
 */
export async function channelSplits(db: RawRunner, companyId: Buffer, branchId: Buffer, date: string): Promise<Map<string, ChannelSplit>> {
  const rows = await db.$queryRaw<{ channel: string; account_id: Buffer | null; todays: unknown; older: unknown }[]>(Prisma.sql`
    SELECT IF(p.method = 'cash', 'cash', 'account') AS channel,
           IF(p.method = 'cash', NULL, p.receiving_account_id) AS account_id,
           COALESCE(SUM(IF(s.business_date = ${date}, p.amount, 0)), 0) AS todays,
           COALESCE(SUM(IF(s.business_date < ${date}, p.amount, 0)), 0) AS older
      FROM payments p
      JOIN sales s ON s.id = p.sale_id
     WHERE p.company_id = ${companyId} AND s.branch_id = ${branchId} AND p.business_date = ${date}
     GROUP BY IF(p.method = 'cash', 'cash', 'account'), IF(p.method = 'cash', NULL, p.receiving_account_id)`);
  const map = new Map<string, ChannelSplit>();
  for (const r of rows) {
    const key = `${r.channel}:${r.account_id ? binToUuid(r.account_id) : 'NONE'}`;
    map.set(key, { todaysSales: round2(num(r.todays)), olderDebts: round2(num(r.older)) });
  }
  return map;
}

/** Confirmed expenses of the date, keyed exactly as the rollup and the channels key them. */
export async function expenseLines(db: RawRunner, companyId: Buffer, branchId: Buffer, date: string): Promise<ExpenseLine[]> {
  const rows = await db.$queryRaw<
    { id: Buffer; category: string; expense_class: string; is_salary: number; amount: unknown; method: string; label: string | null }[]
  >(Prisma.sql`
    SELECT id, category, expense_class, is_salary, amount, method, account_label_snapshot AS label
      FROM expenses
     WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'confirmed'
       AND IF(expense_class = 'fixed', due_date, confirmation_date) = ${date}
     ORDER BY amount DESC, id`);
  return rows.map((r) => ({
    id: binToUuid(r.id),
    category: r.category,
    expenseClass: r.expense_class === 'fixed' ? 'fixed' : 'variable',
    isSalary: Number(r.is_salary) === 1,
    amount: round2(num(r.amount)),
    method: r.method === 'cash' ? 'cash' : 'account',
    accountLabel: r.label,
  }));
}

/**
 * What is waiting for confirmation at the branch NOW. A report is a claim with no
 * business date, so it belongs to no day's figures — it is shown as a warning on
 * today's report and moves nothing.
 */
export async function pendingReports(db: RawRunner, companyId: Buffer, branchId: Buffer) {
  const [refunds] = await db.$queryRaw<{ n: bigint; amount: unknown }[]>(Prisma.sql`
    SELECT COUNT(*) AS n, COALESCE(SUM(reported_amount), 0) AS amount
      FROM refund_payouts
     WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'reported_pending_confirmation'`);
  const [expenses] = await db.$queryRaw<{ n: bigint; amount: unknown }[]>(Prisma.sql`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
      FROM expenses
     WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'reported'`);
  return {
    refundReports: { count: Number(refunds?.n ?? 0), amount: round2(num(refunds?.amount)) },
    expenseReports: { count: Number(expenses?.n ?? 0), amount: round2(num(expenses?.amount)) },
  };
}

/** Differences at the branch still waiting for a decision, on any date. */
export async function openDiscrepancies(db: RawRunner, companyId: Buffer, branchId: Buffer): Promise<number> {
  const [r] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS n FROM closing_discrepancies
     WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'pending_investigation'`);
  return Number(r?.n ?? 0);
}

/**
 * Whether ANYTHING was recorded on (branch, date) — the test between "Needs review"
 * and "No activity recorded" for a day nobody closed (docs/51 D8). EXISTS only,
 * never a sum: a cash sale is both a sale and a payment, and must count once.
 *
 * Activity: a closing row (a count creates one); a closing event (an opening, a
 * count, a close, a reopen, an early start stored under this date); a sale; a
 * payment dated here, including one collecting an older debt; a return approved,
 * a refund confirmed, a purchase paid, a supplier settlement confirmed, an expense
 * confirmed (a fixed one on its due date), a correction approved. A pending report
 * is not activity: it has no date.
 */
export async function dayActivity(db: RawRunner, companyId: Buffer, branchId: Buffer, date: string): Promise<boolean> {
  const [r] = await db.$queryRaw<{ active: bigint | number }[]>(Prisma.sql`
    SELECT (
         EXISTS (SELECT 1 FROM daily_closings WHERE company_id = ${companyId} AND branch_id = ${branchId} AND closing_date = ${date})
      OR EXISTS (SELECT 1 FROM closing_events WHERE company_id = ${companyId} AND branch_id = ${branchId} AND business_date = ${date})
      OR EXISTS (SELECT 1 FROM sales WHERE company_id = ${companyId} AND branch_id = ${branchId} AND business_date = ${date} AND is_reversed = 0)
      OR EXISTS (SELECT 1 FROM payments p JOIN sales s ON s.id = p.sale_id
                  WHERE p.company_id = ${companyId} AND s.branch_id = ${branchId} AND p.business_date = ${date})
      OR EXISTS (SELECT 1 FROM return_reversals WHERE company_id = ${companyId} AND branch_id = ${branchId} AND approval_date = ${date})
      OR EXISTS (SELECT 1 FROM refund_payouts WHERE company_id = ${companyId} AND branch_id = ${branchId}
                  AND status = 'confirmed' AND confirmation_date = ${date})
      OR EXISTS (SELECT 1 FROM supplier_payments sp JOIN purchases pu ON pu.id = sp.purchase_id
                  WHERE sp.company_id = ${companyId} AND pu.branch_id = ${branchId} AND sp.business_date = ${date})
      OR EXISTS (SELECT 1 FROM supplier_settlements WHERE company_id = ${companyId} AND branch_id = ${branchId}
                  AND status = 'confirmed' AND confirmation_date = ${date})
      OR EXISTS (SELECT 1 FROM expenses WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'confirmed'
                  AND IF(expense_class = 'fixed', due_date, confirmation_date) = ${date})
      OR EXISTS (SELECT 1 FROM financial_corrections WHERE company_id = ${companyId} AND branch_id = ${branchId}
                  AND status = 'approved' AND correction_date = ${date})
    ) AS active`);
  return Number(r?.active ?? 0) === 1;
}

/**
 * A fingerprint of every money movement of (branch, date). Read before the report
 * is built and again inside the close's transaction, after the closing row is
 * locked: if they differ, something landed in between and the close is refused
 * with the fresh report rather than locking a day without it (docs/51 §12.6).
 */
export async function movementFingerprint(db: RawRunner, companyId: Buffer, branchId: Buffer, date: string): Promise<string> {
  const [r] = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    SELECT
      (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(total), 0)) FROM sales
        WHERE company_id = ${companyId} AND branch_id = ${branchId} AND business_date = ${date}) AS s,
      (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(p.amount), 0)) FROM payments p JOIN sales x ON x.id = p.sale_id
        WHERE p.company_id = ${companyId} AND x.branch_id = ${branchId} AND p.business_date = ${date}) AS p,
      (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(amount), 0)) FROM expenses
        WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'confirmed'
          AND IF(expense_class = 'fixed', due_date, confirmation_date) = ${date}) AS e,
      (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(reported_amount), 0)) FROM refund_payouts
        WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'confirmed' AND confirmation_date = ${date}) AS r,
      (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(sp.amount), 0)) FROM supplier_payments sp JOIN purchases pu ON pu.id = sp.purchase_id
        WHERE sp.company_id = ${companyId} AND pu.branch_id = ${branchId} AND sp.business_date = ${date}) AS sp,
      (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(amount), 0)) FROM financial_corrections
        WHERE company_id = ${companyId} AND branch_id = ${branchId} AND status = 'approved' AND correction_date = ${date}) AS c,
      (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(net_refund_due), 0)) FROM return_reversals
        WHERE company_id = ${companyId} AND branch_id = ${branchId} AND approval_date = ${date}) AS rr,
      (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(l.amount), 0)) FROM financial_correction_legs l
         JOIN financial_corrections fc ON fc.id = l.correction_id
        WHERE fc.company_id = ${companyId} AND fc.branch_id = ${branchId} AND fc.status = 'approved' AND fc.correction_date = ${date}) AS l`);
  return JSON.stringify(r ?? {});
}
