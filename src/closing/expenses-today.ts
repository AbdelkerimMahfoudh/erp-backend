import { binToUuid } from '../common/utils/uuid.util';

/**
 * The Money screen's "today's expenses" (docs/53 D33): the confirmed expenses whose own date is
 * today — a variable one confirmed today, a fixed one due today — and each reversal approved today
 * as its own negative row, so a day whose only movement is a reversal reads as a negative total
 * that says why. Pure, so the rows and the total are tested without a database.
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface TodayExpense {
  id: Buffer;
  category: string;
  amount: unknown;
  method: string;
  accountLabelSnapshot: string | null;
  reference: string | null;
  receiptKey: string | null;
  confirmedAt: Date | null;
}

export interface TodayReversal {
  id: Buffer;
  amount: unknown;
  method: string | null;
  accountLabelSnapshot: string | null;
  decidedAt: Date | null;
  targetExpense: { id: Buffer; category: string } | null;
}

export interface TodayExpenseRow {
  /** `expense`: recorded today; `reversal`: part of an expense reversed today. */
  kind: 'expense' | 'reversal';
  /** The row's own record: the expense, or the correction that reversed it. */
  id: string;
  /** The expense the row opens. */
  expenseId: string | null;
  description: string;
  /** Signed: a reversal is negative, so the rows add up to the total. */
  amount: number;
  method: string | null;
  accountLabel: string | null;
  reference: string | null;
  hasReceipt: boolean;
  paidAt: Date | null;
}

export function expensesTodayOf(expenses: TodayExpense[], reversals: TodayReversal[]) {
  const rows: TodayExpenseRow[] = [
    ...expenses.map((e) => ({
      kind: 'expense' as const,
      id: binToUuid(e.id),
      expenseId: binToUuid(e.id),
      description: e.category,
      amount: round2(num(e.amount)),
      method: e.method,
      accountLabel: e.accountLabelSnapshot,
      reference: e.reference,
      hasReceipt: e.receiptKey !== null,
      paidAt: e.confirmedAt,
    })),
    ...reversals.map((r) => ({
      kind: 'reversal' as const,
      id: binToUuid(r.id),
      expenseId: r.targetExpense ? binToUuid(r.targetExpense.id) : null,
      description: r.targetExpense?.category ?? '',
      amount: -round2(num(r.amount)),
      method: r.method,
      accountLabel: r.accountLabelSnapshot,
      reference: null,
      hasReceipt: false,
      paidAt: r.decidedAt,
    })),
  ];
  const recorded = round2(expenses.reduce((n, e) => n + num(e.amount), 0));
  const reversed = round2(reversals.reduce((n, r) => n + num(r.amount), 0));
  return { total: round2(recorded - reversed), recorded, reversed, rows };
}
