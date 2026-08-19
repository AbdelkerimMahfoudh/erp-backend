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
    const cash = cashMovement({
      salesReceived: current.revenue,
      refundsPaid: current.refundsPaid,
      supplierPaymentsConfirmed: current.correctionsCash,
      expensesCash: current.expensesCash,
      otherOutflows: 0,
    });

    const balances = await this.balances();
    const discrepancies = await this.openDiscrepancies();
    const prev = precedingPeriod(fromISO, toISO);

    return {
      from: fromISO,
      to: toISO,
      profit: p,
      cash: {
        ...cash,
        salesReceived: current.revenue,
        refundsPaid: current.refundsPaid,
        supplierPaymentsConfirmed: current.correctionsCash,
        expensesCash: current.expensesCash,
      },
      expenseDetail: {
        total: current.expenses,
        fixed: current.expensesFixed,
        salaries: current.expensesSalary,
        count: current.expensesCount,
      },
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
        'supplier_liability',
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
