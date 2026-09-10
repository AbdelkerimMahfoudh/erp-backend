import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../../prisma/prisma.module';
import { TenantPrisma } from '../../prisma/tenant.extension';
import { AppClsStore } from '../context/request-context';
import { WarningReference } from './warning.types';

/**
 * The references an order-of-magnitude check compares against (A1).
 *
 * **Every figure here already exists.** A resolved price, a daily rollup, a
 * stored valuation, a balance. Nothing in this file computes revenue, profit,
 * cost or inventory value in a new way — a second definition of any of those is
 * the failure this project guards against hardest, and a typo check is a
 * spectacularly bad reason to introduce one.
 *
 * ## Sample sizes
 *
 * A median needs observations. Below the minimum the reference is returned with
 * its real `sample`, and `magnitudeWarning` declines to warn — the count
 * travels rather than being silently swallowed here, so a test can prove *why*
 * nothing was raised.
 *
 * ## Cost, and who may see it
 *
 * Two references are cost-derived. For a caller without `cost.view` the
 * `amount` comes back **null**: the warning then never fires, which is correct.
 * A caution the reader cannot be shown the basis of is a caution they cannot
 * act on, and quoting the figure anyway would make the typo check a hole in the
 * cost gate.
 */

/** 90 days of sales, per A1. Long enough to smooth a slow product. */
export const SALE_PRICE_WINDOW_DAYS = 90;
/** Five sales before a median is a median. */
export const SALE_PRICE_MIN_SAMPLE = 5;
/** 180 days of the same expense category. */
export const EXPENSE_WINDOW_DAYS = 180;
/** Three of the same expense before there is a normal. */
export const EXPENSE_MIN_SAMPLE = 3;

/** Exactly the models this service reads — so a transaction client fits too. */
export type MagnitudeReads = Pick<TenantPrisma, 'productDailyRollup' | 'inventoryValuation' | 'expense'>;
type Client = MagnitudeReads;

@Injectable()
export class MagnitudeService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  private maySeeCost(): boolean {
    return this.cls.get('permissions')?.has('cost.view') ?? false;
  }

  /** The shop's own decision about what this sells for. Not a sample. */
  configuredPrice(amount: number | null): WarningReference | null {
    if (amount === null) return null;
    return { kind: 'configured_price', amount, sample: null };
  }

  /** The price this one is replacing — already sent, as `version`'s subject. */
  previousPrice(amount: number | null): WarningReference | null {
    if (amount === null) return null;
    return { kind: 'previous_price', amount, sample: null };
  }

  /** What is still owed. Zero is not a reference — nothing is outstanding. */
  outstandingBalance(amount: number | null): WarningReference | null {
    if (amount === null || amount <= 0) return null;
    return { kind: 'outstanding_balance', amount, sample: null };
  }

  /**
   * What this product has actually been selling for at this branch.
   *
   * Read from `ProductDailyRollup`, the same rollup the dashboards read. Each
   * day contributes its own average unit price (`revenue / qtySold`) and the
   * median is taken **across days**, so one busy afternoon at an odd price
   * cannot drag the reference — while `sample` counts the units sold, because
   * that is what "five sales" means.
   */
  async medianSalePrice(
    tx: Client,
    productId: Buffer,
    branchId: Buffer,
    now: Date = new Date(),
  ): Promise<WarningReference | null> {
    const since = new Date(now.getTime() - SALE_PRICE_WINDOW_DAYS * 86_400_000);
    const rows = await tx.productDailyRollup.findMany({
      where: { productId, branchId, day: { gte: since }, qtySold: { gt: 0 } },
      select: { qtySold: true, revenue: true },
    });
    if (rows.length === 0) return null;

    const perDay = rows
      .map((r) => Number(r.revenue) / r.qtySold)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (perDay.length === 0) return null;

    const sample = rows.reduce((s, r) => s + r.qtySold, 0);
    return { kind: 'median_sale_price', amount: median(perDay), sample };
  }

  /**
   * The weighted average of what this branch paid for what it is holding.
   *
   * `InventoryValuation` already carries the value and the count; the average
   * is their quotient and nothing more. Cost-derived, so it is withheld from a
   * caller without `cost.view`.
   */
  async weightedAverageCost(
    tx: Client,
    productId: Buffer,
    branchId: Buffer,
  ): Promise<WarningReference | null> {
    const row = await tx.inventoryValuation.findFirst({
      where: { productId, branchId },
      select: { unitsCount: true, quantity: true, inventoryValue: true },
    });
    if (!row) return null;
    const held = row.unitsCount + row.quantity;
    if (held <= 0) return null;
    const amount = Number(row.inventoryValue) / held;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return {
      kind: 'weighted_average_cost',
      amount: this.maySeeCost() ? round2(amount) : null,
      sample: held,
    };
  }

  /**
   * What this company usually spends on this kind of thing.
   *
   * Company-wide rather than per branch: an expense category is a company
   * habit, and splitting it by branch would starve the sample at exactly the
   * shops that file the fewest expenses.
   */
  async medianExpense(
    tx: Client,
    category: string,
    now: Date = new Date(),
  ): Promise<WarningReference | null> {
    const since = new Date(now.getTime() - EXPENSE_WINDOW_DAYS * 86_400_000);
    const rows = await tx.expense.findMany({
      where: { category, spentOn: { gte: since }, status: 'confirmed' },
      select: { amount: true },
      take: 500,
    });
    const amounts = rows
      .map((r) => Number(r.amount))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (amounts.length === 0) return null;
    return { kind: 'median_expense', amount: round2(median(amounts)), sample: amounts.length };
  }

  /** The default client, for callers not already inside a transaction. */
  get client(): Client {
    return this.db;
  }
}

/** The middle value; the mean of the middle two when the count is even. */
export function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

