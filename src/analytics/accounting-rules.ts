/**
 * What each figure means, and when it moves (Milestone L).
 *
 * Pure, so every accounting identity below is testable without a database. The
 * point of the file is not arithmetic — it is that the arithmetic is written
 * down **once**, with the reason, instead of being re-derived slightly
 * differently in a rollup, a dashboard and a summary endpoint.
 *
 * The two mistakes it exists to prevent:
 *
 * 1. **Counting a return twice** — once when it is approved and again when the
 *    refund is paid. Approval is where profit moves; payment is only cash.
 * 2. **Treating a loan or consignment principal as revenue or expense.** Both
 *    are balance-sheet movements. A shop that lent 20 000 is not 20 000 poorer,
 *    and one that borrowed it is not 20 000 richer.
 */

/** The seven kinds of number, kept apart because a shop reads them differently. */
export type FigureKind =
  | 'profit'
  | 'cash'
  | 'liability'
  | 'receivable'
  | 'inventory'
  | 'discrepancy'
  | 'workflow';

export type BusinessEvent =
  | 'sale'
  | 'return_approved'
  | 'refund_reported'
  | 'refund_confirmed'
  | 'purchase_received'
  | 'supplier_payment_confirmed'
  | 'expense_confirmed'
  | 'consignment_disposition'
  | 'consignment_payment_confirmed'
  | 'loan_principal'
  | 'loan_payment_confirmed'
  | 'closing_discrepancy';

export interface EventEffect {
  /** Does this change what the shop earned? */
  profit: boolean;
  /** Did money physically move? */
  cash: boolean;
  /** Does it change what is owed, either way? */
  balance: boolean;
  why: string;
}

/**
 * The timing table, as data.
 *
 * Every row here is a decision somebody could otherwise get wrong in a query,
 * and the tests below assert the ones that actually cost money.
 */
export const EFFECT_OF: Record<BusinessEvent, EventEffect> = {
  sale: {
    profit: true,
    cash: true,
    balance: false,
    why: 'Revenue and COGS both land on the sale date, and the received amount moves cash',
  },
  return_approved: {
    profit: true,
    cash: false,
    balance: true,
    why: 'Profit reverses here — revenue back out, COGS credited — and a refund liability is created. No money has moved yet',
  },
  refund_reported: {
    profit: false,
    cash: false,
    balance: false,
    why: 'A claim that a refund was paid. Until somebody confirms it, nothing has happened at all',
  },
  refund_confirmed: {
    profit: false,
    cash: true,
    balance: true,
    why: 'Cash leaves and the liability settles. Profit already moved at approval, and counting it again would double the loss',
  },
  purchase_received: {
    profit: false,
    cash: false,
    balance: true,
    why: 'Receiving stock creates what the shop owes its supplier. Buying inventory is not an expense',
  },
  supplier_payment_confirmed: {
    profit: false,
    cash: true,
    balance: true,
    why: 'Cash out against a payable. The cost reaches profit through COGS when the goods sell, never here',
  },
  expense_confirmed: {
    profit: true,
    cash: true,
    balance: false,
    why: 'A confirmed operating expense reduces profit and moves cash, per the existing expense model. Only CONFIRMED ones count',
  },
  consignment_disposition: {
    profit: true,
    cash: false,
    balance: true,
    why: 'Profit is recognised when the consigned unit sells, and the amount owed between the two shops is created at the same moment',
  },
  consignment_payment_confirmed: {
    profit: false,
    cash: true,
    balance: true,
    why: 'Settling a consignment balance moves cash only. The profit was taken at disposition',
  },
  loan_principal: {
    profit: false,
    cash: true,
    balance: true,
    why: 'Lending or borrowing moves money and creates a receivable or payable. It is never revenue and never an expense',
  },
  loan_payment_confirmed: {
    profit: false,
    cash: true,
    balance: true,
    why: 'Repayment moves cash and reduces the balance. There was no profit in the principal to reverse',
  },
  closing_discrepancy: {
    profit: false,
    cash: false,
    balance: false,
    why: 'A difference between what was counted and what was expected. It is a question, not a movement, and never profit',
  },
};

export function affectsProfit(event: BusinessEvent): boolean {
  return EFFECT_OF[event].profit;
}

export function affectsCash(event: BusinessEvent): boolean {
  return EFFECT_OF[event].cash;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface ProfitInput {
  grossSales: number;
  /** Revenue reversed by returns APPROVED in the period. */
  returnsRevenue: number;
  cogs: number;
  /** COGS credited back by those same approved returns. */
  returnsCogs: number;
  /** Confirmed operating expenses, including fixed and salaries. */
  expenses: number;
}

export interface ProfitBreakdown {
  grossSales: number;
  returnsRevenue: number;
  netRevenue: number;
  cogs: number;
  returnsCogs: number;
  netCogs: number;
  grossProfit: number;
  expenses: number;
  netOperatingProfit: number;
}

/**
 * Profit, counted once.
 *
 * A return reduces revenue **and** gives the cost back — a phone that came back
 * is a phone the shop still has, so charging its cost against a sale that was
 * undone would understate profit twice over.
 */
export function profit(input: ProfitInput): ProfitBreakdown {
  const netRevenue = round2(input.grossSales - input.returnsRevenue);
  const netCogs = round2(input.cogs - input.returnsCogs);
  const grossProfit = round2(netRevenue - netCogs);
  return {
    grossSales: round2(input.grossSales),
    returnsRevenue: round2(input.returnsRevenue),
    netRevenue,
    cogs: round2(input.cogs),
    returnsCogs: round2(input.returnsCogs),
    netCogs,
    grossProfit,
    expenses: round2(input.expenses),
    netOperatingProfit: round2(grossProfit - input.expenses),
  };
}

export interface CashInput {
  salesReceived: number;
  refundsPaid: number;
  supplierPaymentsConfirmed: number;
  expensesCash: number;
  otherOutflows: number;
}

/**
 * Cash, which is a different question from profit.
 *
 * A shop can be profitable and short of cash in the same week — it sold well,
 * paid three suppliers and refunded a customer. Presenting one as the other is
 * the single most misleading thing a retail report can do.
 */
export function cashMovement(input: CashInput): { inflow: number; outflow: number; net: number } {
  const outflow = round2(
    input.refundsPaid + input.supplierPaymentsConfirmed + input.expensesCash + input.otherOutflows,
  );
  const inflow = round2(input.salesReceived);
  return { inflow, outflow, net: round2(inflow - outflow) };
}

/**
 * Comparison against the preceding period of equal length.
 *
 * When the base is zero the answer is **unavailable**, not infinity and not a
 * percentage computed against nothing. "Up 100%" from a base of zero is a
 * division nobody checked, and a shop would read it as a result.
 */
export type Comparison =
  | { available: true; previous: number; change: number; changePercent: number }
  | { available: false; previous: number; reason: 'no_previous_activity' };

export function compare(current: number, previous: number): Comparison {
  if (previous === 0) {
    return { available: false, previous: 0, reason: 'no_previous_activity' };
  }
  const change = round2(current - previous);
  return {
    available: true,
    previous: round2(previous),
    change,
    changePercent: round2((change / Math.abs(previous)) * 100),
  };
}

/**
 * The preceding window of the same length, ending where this one begins.
 *
 * Inclusive dates, so a 7-day window compares against the 7 days before it
 * rather than against a window that overlaps it by a day — an off-by-one here
 * would quietly count one day twice in every comparison the app shows.
 */
export function precedingPeriod(fromISO: string, toISO: string): { from: string; to: string } {
  const from = new Date(`${fromISO}T00:00:00.000Z`);
  const to = new Date(`${toISO}T00:00:00.000Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const prevTo = new Date(from.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}
