/**
 * What happens after a till does not balance (Milestone E, E-CP2).
 *
 * The E0 audit's third finding: `difference` was a number on a locked row. No
 * investigation, no decision, no record of who was held responsible, and no
 * ledger if somebody agreed to repay. So a shortage was either silently
 * absorbed or settled verbally — which is exactly the notebook this product
 * exists to replace.
 *
 * Pure on purpose: these are the rules with judgement in them, and they are
 * worth being able to read and test without a database in the way.
 */

export type DiscrepancyResolution = 'employee_debt' | 'store_absorbed' | 'error_corrected' | 'forgiven';
export type DebtEntryKind = 'charge' | 'repayment' | 'deduction' | 'forgiveness';

/** Which resolutions require naming a person. */
const NEEDS_A_PERSON: DiscrepancyResolution[] = ['employee_debt', 'forgiven'];

/** How each ledger kind moves what somebody owes. */
export const ENTRY_SIGN: Record<DebtEntryKind, 1 | -1> = {
  charge: 1,
  repayment: -1,
  deduction: -1,
  forgiveness: -1,
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export class RuleViolation extends Error {}

const refuse = (message: string): never => {
  throw new RuleViolation(message);
};

/**
 * What somebody owes, derived from their ledger and stored nowhere.
 *
 * A stored balance can disagree with its own history; a derived one cannot.
 * It is deliberately NOT clamped at zero: if repayments exceed charges the
 * balance goes negative, which means the shop owes them — visible, rather than
 * quietly swallowed by a `Math.max`.
 */
export function balanceOf(entries: { kind: DebtEntryKind; amount: number }[]): number {
  return round2(entries.reduce((sum, e) => sum + ENTRY_SIGN[e.kind] * e.amount, 0));
}

export interface ResolveInput {
  resolution: DiscrepancyResolution;
  reason?: string | null;
  responsibleUserId?: string | null;
  /** Signed: negative is a shortage, positive is a surplus. */
  amount: number;
}

/**
 * Whether a discrepancy may be resolved this way, and what it writes.
 *
 * Returns the ledger rows the resolution implies, so the caller never decides
 * that separately — a resolution and its ledger consequence must not be able
 * to drift apart.
 */
export function planResolution(input: ResolveInput): { kind: DebtEntryKind; amount: number }[] {
  const reason = input.reason?.trim();
  // Mandatory for every resolution, no exception. There is no resolving a
  // shortage silently, and "the Owner looked at it" is not a record.
  if (!reason) refuse('Resolving a discrepancy requires a reason');
  if (input.amount === 0) refuse('There is nothing to resolve');

  if (NEEDS_A_PERSON.includes(input.resolution) && !input.responsibleUserId) {
    refuse('Holding somebody responsible requires naming them');
  }
  if (!NEEDS_A_PERSON.includes(input.resolution) && input.responsibleUserId) {
    // Naming a person and then absorbing the loss records an accusation that
    // led to nothing. If somebody is responsible, say so in the reason.
    refuse('This resolution does not name a person');
  }

  /**
   * A SURPLUS can never become a debt. Somebody cannot owe the business money
   * for having too much of it — extra cash is a mis-recorded sale until proven
   * otherwise, which is an investigation, not a charge.
   */
  if (input.amount > 0 && input.resolution === 'employee_debt') {
    refuse('A surplus is not a debt: money was found, not lost');
  }

  const magnitude = round2(Math.abs(input.amount));
  switch (input.resolution) {
    case 'employee_debt':
      return [{ kind: 'charge', amount: magnitude }];
    case 'forgiven':
      /**
       * Both rows, deliberately. Recording only the waiver would leave no trace
       * that anything was ever short, and an owner looking back should be able
       * to see that this person came up short three times even though every
       * one was forgiven. The pair nets to zero owed and keeps the history.
       */
      return [
        { kind: 'charge', amount: magnitude },
        { kind: 'forgiveness', amount: magnitude },
      ];
    case 'store_absorbed':
    case 'error_corrected':
      return [];
  }
}

export interface EntryInput {
  kind: DebtEntryKind;
  amount: number;
  reason?: string | null;
  method?: 'cash' | 'account' | 'payroll' | null;
  /** What the person currently owes, before this entry. */
  outstanding: number;
}

/** Whether a standalone ledger entry may be written. */
export function assertEntryAllowed(input: EntryInput): void {
  if (!input.reason?.trim()) {
    // Every kind, no exception. A ledger row nobody can explain is worse than
    // no ledger at all.
    refuse('Every ledger entry requires a reason');
  }
  if (!(input.amount > 0)) {
    // `kind` carries the direction, so the amount is always a magnitude and no
    // row can be ambiguous about which way the money went.
    refuse('A ledger entry is a positive amount');
  }
  if (input.kind === 'charge') {
    /**
     * A charge only ever comes from resolving a discrepancy. Letting one be
     * written directly would be a way to make somebody owe money with no till,
     * no day and no shortage behind it.
     */
    refuse('A charge comes from resolving a discrepancy, never on its own');
  }
  if (input.kind === 'repayment' && !input.method) {
    refuse('A repayment must say how it arrived');
  }
  if (input.kind !== 'repayment' && input.method) {
    refuse('Only a repayment arrives by a method');
  }
  if (round2(input.amount) > round2(input.outstanding)) {
    /**
     * Refusing to over-settle catches the ordinary mistake — the same repayment
     * entered twice — before it turns into the shop apparently owing an
     * employee money.
     */
    refuse(`That is more than the ${round2(input.outstanding)} still owed`);
  }
}

/**
 * Whether a channel's difference is worth opening a discrepancy for.
 *
 * A skipped channel is not a discrepancy: nobody claimed a figure, so there is
 * nothing to disagree with. An uncounted one likewise.
 */
export function opensDiscrepancy(channel: {
  counted: number | null;
  isSkipped: boolean;
  difference: number | null;
}): boolean {
  if (channel.isSkipped || channel.counted === null) return false;
  return round2(channel.difference ?? 0) !== 0;
}
