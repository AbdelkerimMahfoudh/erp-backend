/**
 * Money owed, in both directions (Milestone I).
 *
 * Three properties carry this file:
 *
 * 1. **Direction is data, never a sign.** `they_owe_us` and `we_owe_them` are
 *    stored explicitly. A negative amount becomes ambiguous the moment somebody
 *    corrects a payment, and a sign flip is a silent reversal of who owes whom —
 *    the worst possible silent change in a two-party money record.
 *
 * 2. **The principal is agreed, not asserted.** Nothing becomes a debt because
 *    one side said so; the other accepts, counters or disputes it first.
 *
 * 3. **A loan principal is neither revenue nor expense.** Lending money is a
 *    balance-sheet movement. Recognising it as income would make a shop that
 *    lent 20 000 look 20 000 more profitable, which is exactly backwards.
 */

export type Direction = 'they_owe_us' | 'we_owe_them';

export type LoanStatus =
  | 'proposed'
  | 'counter_proposed'
  | 'disputed'
  | 'accepted'
  | 'partially_paid'
  | 'payment_awaiting_confirmation'
  | 'settled'
  | 'forgiven_settled'
  | 'cancelled';

export type StatusGroup = 'pending' | 'accepted' | 'confirmed';

/**
 * The three groups the screens show.
 *
 * `confirmed` means the balance reached zero — paid, written off, or closed
 * with nothing outstanding. Agreeing a loan exists is `accepted`, never
 * confirmed: a shop reading "confirmed" must not discover it only meant the
 * debt was acknowledged.
 */
export const GROUP_OF: Record<LoanStatus, StatusGroup> = {
  proposed: 'pending',
  counter_proposed: 'pending',
  disputed: 'pending',

  accepted: 'accepted',
  partially_paid: 'accepted',
  payment_awaiting_confirmation: 'accepted',

  settled: 'confirmed',
  forgiven_settled: 'confirmed',
  cancelled: 'confirmed',
};

/**
 * The direction as the OTHER party sees it.
 *
 * Stored relative to the company that created the row, so one row serves both
 * sides. Two mirrored rows could disagree about who owes whom, and no amount of
 * care would make that safe.
 */
export function invert(direction: Direction): Direction {
  return direction === 'they_owe_us' ? 'we_owe_them' : 'they_owe_us';
}

/** The direction from a given company's point of view. */
export function directionFor(
  loan: { companyId: string; direction: Direction },
  viewerCompanyId: string,
): Direction {
  return loan.companyId === viewerCompanyId ? loan.direction : invert(loan.direction);
}

/**
 * Who is owed the money, as a side rather than a sign.
 *
 * Used to decide who may confirm a payment and who may forgive: both are the
 * creditor's alone, and "creditor" depends on the direction rather than on who
 * created the record.
 */
export function creditorIs(
  loan: { companyId: string; direction: Direction },
): 'owner' | 'counterparty' {
  return loan.direction === 'they_owe_us' ? 'owner' : 'counterparty';
}

export type LedgerKind =
  | 'principal_accepted'
  | 'payment_reported'
  | 'payment_confirmed'
  | 'payment_corrected'
  | 'forgiven'
  | 'settled';

/**
 * How each entry moves what remains.
 *
 * `payment_reported` is **zero**: a report is a claim, and until the creditor
 * confirms it nothing has settled. `payment_corrected` is **+1**: reversing a
 * confirmed payment puts the debt back rather than erasing the claim.
 */
export const BALANCE_EFFECT: Record<LedgerKind, -1 | 0 | 1> = {
  principal_accepted: 1,
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

/** What remains. Derived every time, stored nowhere. */
export function remaining(rows: LedgerRow[]): number {
  return round2(rows.reduce((sum, r) => sum + BALANCE_EFFECT[r.kind] * r.amount, 0));
}

/** The parts, so a screen can explain a balance rather than assert it. */
export function breakdown(rows: LedgerRow[]) {
  const total = (kind: LedgerKind) =>
    round2(rows.filter((r) => r.kind === kind).reduce((s, r) => s + r.amount, 0));
  return {
    principal: total('principal_accepted'),
    confirmedPaid: total('payment_confirmed'),
    corrected: total('payment_corrected'),
    forgiven: total('forgiven'),
    /** Reported but not confirmed. Visible, and deliberately not deducted. */
    awaitingConfirmation: total('payment_reported'),
    remaining: remaining(rows),
  };
}

export class LoanRefused extends Error {}

const refuse = (m: string): never => {
  throw new LoanRefused(m);
};

export type Action = 'accept' | 'counter' | 'dispute' | 'reject' | 'cancel';

interface Rule {
  from: LoanStatus[];
  to: LoanStatus;
}

export const TRANSITIONS: Record<Action, Rule> = {
  accept: { from: ['proposed', 'counter_proposed', 'disputed'], to: 'accepted' },
  counter: { from: ['proposed', 'counter_proposed', 'disputed'], to: 'counter_proposed' },
  dispute: { from: ['proposed', 'counter_proposed'], to: 'disputed' },
  reject: { from: ['proposed', 'counter_proposed', 'disputed'], to: 'cancelled' },
  cancel: { from: ['proposed', 'counter_proposed', 'disputed'], to: 'cancelled' },
};

export interface DecideInput {
  action: Action;
  from: LoanStatus;
  /** Whether the party acting is the one whose offer is on the table. */
  isOwnOffer: boolean;
  amount?: number | null;
  reason?: string | null;
}

/**
 * Whether this party may take this action now.
 *
 * The rule worth stating: **nobody accepts or counters their own offer.**
 * Without it, one side could propose 20 000 and immediately "accept" it,
 * producing a debt the other party never agreed to — which is the entire thing
 * the proposal step exists to prevent.
 */
export function assertDecision(input: DecideInput): LoanStatus {
  const rule = TRANSITIONS[input.action];
  if (!rule) refuse('That is not something you can do to a loan');
  if (!rule.from.includes(input.from)) {
    refuse(`That cannot be done while the loan is ${readable(input.from)}`);
  }

  if ((input.action === 'accept' || input.action === 'counter') && input.isOwnOffer) {
    refuse('You are waiting on the other side to answer your offer');
  }
  if (input.action === 'counter' && !(input.amount && input.amount > 0)) {
    refuse('A counter-offer needs an amount');
  }
  if (input.action === 'dispute' && !input.reason?.trim()) {
    // "I disagree" with no reason is not a conversation the other side can act on.
    refuse('Say what you disagree with');
  }
  return rule.to;
}

export interface PaymentInput {
  amount: number;
  method: 'cash' | 'account';
  receivingAccountId?: string | null;
  remaining: number;
}

export function assertPaymentAllowed(input: PaymentInput): void {
  if (!(input.amount > 0)) refuse('A payment is an amount above zero');
  if (round2(input.amount) > round2(input.remaining)) {
    // Catches the same payment entered twice, before it turns into the creditor
    // apparently owing the debtor money.
    refuse(`That is more than the ${round2(input.remaining)} still owed`);
  }
  if (input.method === 'account' && !input.receivingAccountId) {
    refuse('Say which account the money went to');
  }
  if (input.method === 'cash' && input.receivingAccountId) {
    refuse('Cash does not go to an account');
  }
}

export interface ForgivenessInput {
  amount: number;
  reason?: string | null;
  remaining: number;
}

export function assertForgivenessAllowed(input: ForgivenessInput): void {
  if (!input.reason?.trim()) {
    refuse('Say why you are writing this off');
  }
  if (!(input.amount > 0)) refuse('Write off an amount above zero');
  if (round2(input.amount) > round2(input.remaining)) {
    refuse(`There is only ${round2(input.remaining)} left to write off`);
  }
}

/**
 * A loan principal is neither revenue nor expense.
 *
 * Named functions rather than comments, because these are the two mistakes
 * somebody will eventually "fix": money arriving looks like income, and money
 * going out looks like a cost. Both are balance-sheet movements — the shop is
 * no richer for having lent 20 000, and no poorer for having been repaid.
 */
export function principalAffectsProfit(): false {
  return false;
}

export function paymentAffectsProfit(): false {
  return false;
}

/**
 * Forgiveness is not cash and never was.
 *
 * It changes what is owed. Recording it as a customer sale would invent
 * revenue; recording it as an operating expense would bury a credit decision
 * among electricity bills. It needs its own line, or none.
 */
export function forgivenessIsCash(): false {
  return false;
}

/** Plain wording for a state, for messages a shopkeeper reads. */
export function readable(status: LoanStatus): string {
  switch (status) {
    case 'proposed':
      return 'waiting for an answer';
    case 'counter_proposed':
      return 'waiting on a counter-offer';
    case 'disputed':
      return 'disputed';
    case 'accepted':
      return 'agreed and outstanding';
    case 'partially_paid':
      return 'part paid';
    case 'payment_awaiting_confirmation':
      return 'waiting for a payment to be confirmed';
    case 'settled':
      return 'paid off';
    case 'forgiven_settled':
      return 'written off';
    case 'cancelled':
      return 'cancelled';
  }
}
