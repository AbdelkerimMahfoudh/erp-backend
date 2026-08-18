import { createHash } from 'node:crypto';

/**
 * What is owed on a consignment, and what it does to the books (H-CP4).
 *
 * Two properties carry this file, and both are ways of counting once:
 *
 * 1. **The balance is derived from the ledger, never stored.** A stored balance
 *    can disagree with its own history, and in a two-company record that
 *    disagreement is a dispute nobody can settle from the data.
 *
 * 2. **Profit is recognised exactly once, at disposition.** The later payment
 *    moves cash and liability and must not touch profit again. This is the same
 *    trap Milestone E spent a checkpoint closing for the till: a movement that
 *    looks like income in two places is counted twice by whoever adds them up.
 */

export type LedgerKind =
  | 'receivable_raised'
  | 'payment_reported'
  | 'payment_confirmed'
  | 'payment_corrected'
  | 'forgiven'
  | 'settled';

/**
 * How each entry moves the outstanding balance.
 *
 * `payment_reported` is deliberately **zero**. A report is a claim that money
 * moved; until the creditor confirms it, nothing has settled. The same
 * two-party rule refunds (I3) and supplier settlements (J1) already follow.
 *
 * `payment_corrected` is **+1**: reversing a confirmed payment puts the debt
 * back, exactly as Milestone B's corrections restore a settled liability.
 */
export const BALANCE_EFFECT: Record<LedgerKind, -1 | 0 | 1> = {
  receivable_raised: 1,
  payment_reported: 0,
  payment_confirmed: -1,
  payment_corrected: 1,
  forgiven: -1,
  settled: 0,
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LedgerRow {
  kind: LedgerKind;
  amount: number;
}

/** What is still owed. Derived every time, stored nowhere. */
export function outstanding(rows: LedgerRow[]): number {
  return round2(rows.reduce((sum, r) => sum + BALANCE_EFFECT[r.kind] * r.amount, 0));
}

/** The parts, so a screen can explain a balance rather than assert it. */
export function breakdown(rows: LedgerRow[]) {
  const total = (kind: LedgerKind) =>
    round2(rows.filter((r) => r.kind === kind).reduce((s, r) => s + r.amount, 0));

  return {
    raised: total('receivable_raised'),
    confirmedPaid: total('payment_confirmed'),
    corrected: total('payment_corrected'),
    forgiven: total('forgiven'),
    /** Reported but not yet confirmed. Visible, and deliberately not deducted. */
    awaitingConfirmation: total('payment_reported'),
    outstanding: outstanding(rows),
  };
}

export class MoneyRefused extends Error {}

const refuse = (m: string): never => {
  throw new MoneyRefused(m);
};

export interface PaymentInput {
  amount: number;
  method: 'cash' | 'account';
  receivingAccountId?: string | null;
  /** What is owed before this entry. */
  outstanding: number;
}

/** Whether a payment may be reported or confirmed. */
export function assertPaymentAllowed(input: PaymentInput): void {
  if (!(input.amount > 0)) refuse('A payment is an amount above zero');
  if (round2(input.amount) > round2(input.outstanding)) {
    /**
     * Refusing to over-pay catches the ordinary mistake — the same payment
     * entered twice — before it turns into the creditor apparently owing the
     * debtor money.
     */
    refuse(`That is more than the ${round2(input.outstanding)} still owed`);
  }
  if (input.method === 'account' && !input.receivingAccountId) {
    refuse('Say which account the money went to');
  }
  if (input.method === 'cash' && input.receivingAccountId) {
    // Cash is the drawer and belongs to no account; the database agrees.
    refuse('Cash does not go to an account');
  }
}

export interface ForgivenessInput {
  amount: number;
  reason?: string | null;
  outstanding: number;
}

/**
 * Whether the creditor may write part of the balance off.
 *
 * Only the creditor can — checked by the caller through `assertSource`, because
 * "who may forgive" is a question about sides, not about amounts.
 */
export function assertForgivenessAllowed(input: ForgivenessInput): void {
  if (!input.reason?.trim()) {
    // Mandatory, every time. A write-off nobody can explain is indistinguishable
    // from money quietly going missing.
    refuse('Say why you are writing this off');
  }
  if (!(input.amount > 0)) refuse('Write off an amount above zero');
  if (round2(input.amount) > round2(input.outstanding)) {
    refuse(`There is only ${round2(input.outstanding)} left to write off`);
  }
}

/**
 * What a consignment does to the SOURCE company's books.
 *
 * Recognised once, at disposition — when the holding store reports the sale, or
 * an Owner confirms it for a manual counterparty. The payment that follows,
 * whenever it comes, moves cash and liability only.
 *
 * COGS is the source's own unit cost, which the destination never sees. Revenue
 * is the agreed amount, which is the only figure both sides share.
 */
export interface DispositionAccounting {
  /** What the source earns: the agreed amount, never Store 2's resale price. */
  revenue: number;
  /** The source's own immutable unit cost. */
  cogs: number;
  grossProfit: number;
}

export function sourceAccounting(agreedAmount: number, unitCost: number): DispositionAccounting {
  const revenue = round2(agreedAmount);
  const cogs = round2(unitCost);
  return { revenue, cogs, grossProfit: round2(revenue - cogs) };
}

/**
 * What the DESTINATION company's sale looks like.
 *
 * The agreed amount is its cost basis, so its margin is correct by
 * construction and the source's real cost never enters its database. There is
 * no `unitId`: that unit belongs to the source company, and referencing it
 * would create a foreign key from one tenant's sale into another's inventory.
 */
export function destinationCostBasis(agreedAmount: number): number {
  return round2(agreedAmount);
}

/**
 * Whether a payment affects profit. It does not, ever.
 *
 * Kept as a named function rather than a comment because it is the single thing
 * most likely to be "fixed" by somebody who sees cash arriving and assumes
 * income. Profit happened at disposition; this is settlement.
 */
export function paymentAffectsProfit(): false {
  return false;
}

/**
 * Whether forgiveness is cash. It is not.
 *
 * It reduces what is owed and appears as its own component. Treating it as cash
 * would make a till balance against money that never arrived; treating it as an
 * ordinary expense would bury a credit decision among electricity bills.
 */
export function forgivenessIsCash(): false {
  return false;
}

/**
 * The payload fingerprint behind idempotency (Milestone J).
 *
 * Same key and the same payload replays; same key with a different payload is a
 * conflict, because that is a second report wearing the first one's id — which
 * is precisely what a queued offline draft looks like after somebody edits it.
 *
 * Mirrors `fingerprintPayment` in the loan rules deliberately: the two ledgers
 * behave identically, and a shop should not have to learn which is which.
 */
export function fingerprintPayment(input: {
  consignmentId: string;
  amount: number;
  method: string;
  receivingAccountId?: string | null;
  reference?: string | null;
}): string {
  return createHash('sha256')
    .update(
      [
        input.consignmentId,
        input.amount.toFixed(2),
        input.method,
        input.receivingAccountId ?? '',
        (input.reference ?? '').trim(),
      ].join('|'),
    )
    .digest('hex');
}
