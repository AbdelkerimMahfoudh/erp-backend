import { Prisma } from '@prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import {
  cashMovement,
  compare,
  precedingPeriod,
  profit,
  type Comparison,
} from './accounting-rules';

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface PeriodSummary {
  from: string;
  to: string;

  /** What the shop earned. */
  profit: ReturnType<typeof profit>;
  /** What actually moved. A different question, kept on different rows. */
  cash: ReturnType<typeof cashMovement> & {
    salesReceived: number;
    refundsPaid: number;
    supplierPaymentsConfirmed: number;
    expensesCash: number;
  };
  /** Expenses broken out, because a salary is not a taxi fare. */
  expenseDetail: { total: number; fixed: number; salaries: number; count: number };
  /**
   * Money CUSTOMERS actually handed over in the period, across every channel.
   *
   * A fourth question, and not answerable from any figure that existed before.
   * `cash.salesReceived` is net REVENUE used as a stand-in — it is what was
   * billed, not what was collected — so a credit sale inflated it and a deposit
   * against an older sale was missing from it entirely. This counts `payments`
   * rows, which is the only record of money arriving.
   *
   * Deliberately NOT netted against refunds. A refund is money going back out
   * and already has its own line (`cash.refundsPaid`); subtracting it here
   * would answer "collected" with a number that is neither what came in nor
   * what the shop kept, and a reader could not tell which.
   *
   * Never profit and never an available balance: collecting an old debt moves
   * no profit at all, and cash in hand is this less everything that went out.
   */
  collected: { total: number; cash: number; account: number; count: number };
  /** What is owed, in both directions, as of now rather than for the period. */
  balances: {
    loansReceivable: number;
    loansPayable: number;
    consignmentBalance: number;
  };
  /** Differences nobody has resolved. Never profit. */
  discrepancies: { open: number; total: number };
  /** Comparison with the immediately preceding period of equal length. */
  comparison: {
    period: { from: string; to: string };
    netRevenue: Comparison;
    grossProfit: Comparison;
    netOperatingProfit: Comparison;
  };
  /**
   * Metrics with no canonical source, named rather than defaulted to zero.
   * A zero claims something was measured; this says nothing was.
   */
  unavailable: string[];
}

/**
 * One consolidated period summary (Milestone L).
 *
 * Every figure is read from the source that already owns it — `daily_rollups`
 * for the day's trading, the ledgers for balances, the closing for differences.
 * Nothing here recomputes profit a second way: two ways of computing profit is
 * how a shop ends up with two answers and trusts neither.
 *
 * Uses the tenant-scoped client, so company and branch scoping are the same
 * ones every other read obeys, and `CostGatingInterceptor` strips cost and
 * margin from the response for anybody without the permission — this endpoint
 * must not become the hole that gating is missing from.
 */
@Injectable()
export class SummaryService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
  ) {}

  async forPeriod(fromISO: string, toISO: string): Promise<PeriodSummary> {
    const [current, previous] = await Promise.all([
      this.rollupTotals(fromISO, toISO),
      (async () => {
        const p = precedingPeriod(fromISO, toISO);
        return this.rollupTotals(p.from, p.to);
      })(),
    ]);

    const p = profit({
      grossSales: current.revenue,
      returnsRevenue: current.returnsRevenue,
      cogs: current.cogs,
      returnsCogs: current.returnsCogs,
      expenses: current.expenses,
    });

    const previousProfit = profit({
      grossSales: previous.revenue,
      returnsRevenue: previous.returnsRevenue,
      cogs: previous.cogs,
      returnsCogs: previous.returnsCogs,
      expenses: previous.expenses,
    });

    /*
      Sales received is net revenue less what was refunded in cash, because the
      rollup records money received against sales rather than a separate cash
      column. Where the source cannot answer precisely the figure is omitted
      rather than estimated — see `unavailable` below.
    */
    /*
      Paid for stock: purchases paid in full at receipt (first release) plus any
      historical supplier settlement confirmed in the window. This used to read
      `correctionsCash` — money coming BACK from corrections — so the outflow
      was wrong in both source and sign.
    */
    const stockPaid = await this.stockPaidInPeriod(fromISO, toISO);
    const cash = cashMovement({
      salesReceived: current.revenue,
      refundsPaid: current.refundsPaid,
      supplierPaymentsConfirmed: stockPaid,
      expensesCash: current.expensesCash,
      otherOutflows: 0,
    });

    const balances = await this.balances();
    const discrepancies = await this.openDiscrepancies();
    const collected = await this.collectedInPeriod(fromISO, toISO);
    const prev = precedingPeriod(fromISO, toISO);

    return {
      from: fromISO,
      to: toISO,
      profit: p,
      cash: {
        ...cash,
        salesReceived: current.revenue,
        refundsPaid: current.refundsPaid,
        supplierPaymentsConfirmed: stockPaid,
        expensesCash: current.expensesCash,
      },
      expenseDetail: {
        total: current.expenses,
        fixed: current.expensesFixed,
        salaries: current.expensesSalary,
        count: current.expensesCount,
      },
      collected,
      balances,
      discrepancies,
      comparison: {
        period: prev,
        netRevenue: compare(p.netRevenue, previousProfit.netRevenue),
        grossProfit: compare(p.grossProfit, previousProfit.grossProfit),
        netOperatingProfit: compare(p.netOperatingProfit, previousProfit.netOperatingProfit),
      },
      /*
        Named, not zeroed. A shop cannot tell a measured zero from a figure
        nobody computed, so anything without a canonical source says so.
      */
      unavailable: [
        'refund_liability',
        'commissions_and_fees',
        'per_channel_expected_movement',
        'unattributed_legacy_payments',
      ],
    };
  }

  /**
   * The canonical daily figures, summed over the window.
   *
   * Read from `daily_rollups` rather than recomputed from `sales`: the rollup
   * already encodes the decisions that matter — only confirmed expenses count,
   * returns carry both a revenue reversal and a COGS credit — and a second
   * query would encode them slightly differently.
   */
  private async rollupTotals(fromISO: string, toISO: string) {
    /*
      Branch scoping is EXPLICIT here. The tenant extension scopes by company
      only, so without this the summary reported every branch of the company
      whichever branch was selected — a two-shop owner would have read one
      shop's screen and seen both shops' figures, with nothing to indicate it.

      Null branch means a company-wide view, which is a legitimate thing to ask
      for and is what the absence of a branch header means everywhere else.
    */
    const branchId = this.tenant.branchId() ?? null;
    const rows = await this.db.dailyRollup.findMany({
      where: {
        day: { gte: new Date(`${fromISO}T00:00:00.000Z`), lte: new Date(`${toISO}T00:00:00.000Z`) },
        ...(branchId ? { branchId } : {}),
      },
    });

    const sum = (pick: (r: (typeof rows)[number]) => unknown): number =>
      round2(rows.reduce((acc, r) => acc + num(pick(r)), 0));

    return {
      revenue: sum((r) => r.revenue),
      cogs: sum((r) => r.cogs),
      expenses: sum((r) => r.expenses),
      expensesCash: sum((r) => r.expensesCash),
      expensesFixed: sum((r) => r.expensesFixed),
      expensesSalary: sum((r) => r.expensesSalary),
      expensesCount: rows.reduce((a, r) => a + Number(r.expensesCount ?? 0), 0),
      returnsRevenue: sum((r) => r.returnsRevenue),
      returnsCogs: sum((r) => r.returnsCogs),
      refundsPaid: sum((r) => r.refundsPaidTotal),
      correctionsCash: sum((r) => r.correctionsCash),
      days: rows.length,
    };
  }

  /**
   * Money customers actually handed over in the window.
   *
   * Counted from `payments`, which is the only record of money ARRIVING. The
   * rollup could not answer this: it stores revenue, and revenue is what was
   * billed — a credit sale raises it without a coin moving, and a customer
   * settling an older balance moves a coin without raising it.
   *
   * Split by channel because a shop reconciles them separately: cash is the
   * drawer, everything else landed in a named account. The split is `method`,
   * not `receiving_account_id` — an older non-cash payment can have no account
   * (they were "unattributed" before `0045`) and would otherwise vanish from
   * the total it belongs in.
   *
   * Branch scoping is EXPLICIT, exactly as `rollupTotals` does it: the tenant
   * client scopes by company alone, so without this a two-shop owner would read
   * one shop's screen and see both shops' money.
   *
   * Keyed on `paid_at` — the day the money ARRIVED. Until 0074 every payment
   * was taken with its sale in the same second, so this used the sale's own
   * timestamp to stay in the revenue's window. Part-payment against an older
   * sale now exists, and this is the change that comment asked for: a balance
   * collected on the 19th is money collected on the 19th, while its revenue
   * stays on the sale's day. The two figures are no longer compared directly —
   * "collected" can exceed "sales" on a day when old balances are paid.
   */
  private async collectedInPeriod(fromISO: string, toISO: string) {
    const branchId = this.tenant.branchId() ?? null;
    const start = new Date(`${fromISO}T00:00:00.000Z`);
    // Exclusive upper bound: `to` is an INCLUSIVE day, so the window runs to
    // the end of it. Comparing against midnight would silently drop the last
    // day's takings — the day a shopkeeper is most likely to be looking at.
    const end = new Date(new Date(`${toISO}T00:00:00.000Z`).getTime() + 86_400_000);

    const rows = await this.db.payment.groupBy({
      by: ['method'],
      where: {
        paidAt: { gte: start, lt: end },
        ...(branchId ? { sale: { branchId } } : {}),
      },
      _sum: { amount: true },
      _count: true,
    });

    const sumOf = (pick: (method: string) => boolean): number =>
      round2(rows.filter((r) => pick(r.method)).reduce((acc, r) => acc + num(r._sum.amount), 0));

    return {
      total: sumOf(() => true),
      cash: sumOf((m) => m === 'cash'),
      account: sumOf((m) => m !== 'cash'),
      count: rows.reduce((acc, r) => acc + r._count, 0),
    };
  }

  /**
   * Everything paid for stock in the window, all channels, branch-scoped.
   *
   * Purchases paid in full at receipt (first release), keyed on when they were
   * paid and scoped by the purchase's branch, plus any historical supplier
   * settlement confirmed in the window.
   */
  private async stockPaidInPeriod(fromISO: string, toISO: string): Promise<number> {
    const branchId = this.tenant.branchId() ?? null;
    const companyId = this.tenant.companyId();
    const start = new Date(`${fromISO}T00:00:00.000Z`);
    const end = new Date(new Date(`${toISO}T00:00:00.000Z`).getTime() + 86_400_000);
    const purchaseBranch = branchId ? Prisma.sql`AND p.branch_id = ${branchId}` : Prisma.empty;
    const settlementBranch = branchId ? Prisma.sql`AND branch_id = ${branchId}` : Prisma.empty;
    const rows = await this.db.$queryRaw<{ total: unknown }[]>(Prisma.sql`
      SELECT COALESCE(SUM(sp.amount), 0) AS total
        FROM supplier_payments sp
        JOIN purchases p ON p.id = sp.purchase_id
       WHERE sp.company_id = ${companyId}
         AND sp.paid_at >= ${start} AND sp.paid_at < ${end}
         ${purchaseBranch}
      UNION ALL
      SELECT COALESCE(SUM(amount), 0)
        FROM supplier_settlements
       WHERE company_id = ${companyId} AND status = 'confirmed'
         AND confirmation_date >= ${start} AND confirmation_date < ${end}
         ${settlementBranch}`);
    return round2(rows.reduce((a, r) => a + num(r.total), 0));
  }

  /**
   * What is owed right now, in both directions.
   *
   * Point-in-time rather than for the period: "we are owed 40 000" is a fact
   * about today, and presenting it inside a date window would invite somebody
   * to read it as money that moved last week.
   */
  private async balances() {
    const companyId = this.tenant.companyId();

    const loans = await this.db.$queryRaw<{ direction: string; remaining: unknown }[]>`
      SELECT l.direction,
             COALESCE(SUM(
               CASE le.kind
                 WHEN 'principal_accepted' THEN le.amount
                 WHEN 'payment_confirmed'  THEN -le.amount
                 WHEN 'payment_corrected'  THEN le.amount
                 WHEN 'forgiven'           THEN -le.amount
                 ELSE 0
               END), 0) AS remaining
      FROM loans l
      LEFT JOIN loan_ledger le ON le.loan_id = l.id
      WHERE l.company_id = ${companyId}
      GROUP BY l.direction
    `;

    const receivable = round2(
      loans.filter((r) => r.direction === 'they_owe_us').reduce((a, r) => a + num(r.remaining), 0),
    );
    const payable = round2(
      loans.filter((r) => r.direction === 'we_owe_them').reduce((a, r) => a + num(r.remaining), 0),
    );

    const consignment = await this.db.$queryRaw<{ balance: unknown }[]>`
      SELECT COALESCE(SUM(
               CASE ce.kind
                 WHEN 'receivable_raised'  THEN ce.amount
                 WHEN 'payment_confirmed'  THEN -ce.amount
                 WHEN 'payment_corrected'  THEN ce.amount
                 WHEN 'forgiven'           THEN -ce.amount
                 ELSE 0
               END), 0) AS balance
      FROM consignment_ledger ce
      WHERE ce.source_company_id = ${companyId}
    `;

    /*
      Refund and supplier liabilities are deliberately ABSENT rather than zero.
      Neither has a single canonical total — the returns workflow owns refund
      liability per case, and payables are per supplier — and inventing a query
      here would be the competing accounting system this milestone exists to
      avoid. They are named in `unavailable` instead, because a shop cannot
      tell a measured zero from a figure nobody computed.
    */
    return {
      loansReceivable: receivable,
      loansPayable: payable,
      consignmentBalance: round2(num(consignment[0]?.balance)),
    };
  }

  /** Counted differences nobody has resolved. Never rolled into profit. */
  private async openDiscrepancies() {
    const rows = await this.db.closingDiscrepancy.findMany({
      where: { resolvedAt: null },
      select: { amount: true },
    });
    return {
      open: rows.length,
      total: round2(rows.reduce((a, r) => a + num(r.amount), 0)),
    };
  }
}
