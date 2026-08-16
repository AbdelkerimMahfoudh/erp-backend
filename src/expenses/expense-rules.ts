import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * The rules an expense obeys, as pure functions (Milestone D).
 *
 * Kept out of the service so each can be read and tested alone — these decide
 * when money is treated as having left the business, which is the whole point
 * of the workflow.
 */

export type ExpenseClass = 'variable' | 'fixed';
export type ExpenseMethod = 'cash' | 'account';

/**
 * A channel expense names its account; a cash one never does.
 *
 * The same rule refunds and supplier payments already follow, and it exists
 * because only cash touches the drawer — an expense with no channel cannot be
 * reconciled against anything.
 */
export function assertMethodAndAccount(method: ExpenseMethod, accountId?: string | null): void {
  if (method === 'cash' && accountId) {
    throw new BadRequestException({
      code: 'cash_with_account',
      message: 'A cash expense does not go through an account.',
    });
  }
  if (method === 'account' && !accountId) {
    throw new BadRequestException({
      code: 'account_required',
      message: 'Choose which account the money left from.',
    });
  }
}

/**
 * A fixed expense is recognised on a due date; a variable one is recognised on
 * the day it is confirmed and therefore has none.
 *
 * This is the distinction that stops rent being smeared across thirty days, and
 * stops a day's electricity bill being counted in a month it did not happen in.
 */
export function assertClassAndDueDate(cls: ExpenseClass, dueDate?: string | null): void {
  if (cls === 'variable' && dueDate) {
    throw new BadRequestException({
      code: 'variable_with_due_date',
      message: 'A variable expense belongs to the day it is confirmed, not to a due date.',
    });
  }
  if (cls === 'fixed' && !dueDate) {
    throw new BadRequestException({
      code: 'due_date_required',
      message: 'A fixed expense needs the date it is due.',
    });
  }
}

/** Salary is a kind of fixed cost, never a variable one. The database agrees. */
export function assertSalaryIsFixed(isSalary: boolean, cls: ExpenseClass): void {
  if (isSalary && cls !== 'fixed') {
    throw new BadRequestException({
      code: 'salary_must_be_fixed',
      message: 'A salary is a fixed cost.',
    });
  }
}

/** Money that left has to be a positive amount. */
export function assertAmount(amount: number): void {
  if (!(amount > 0)) {
    throw new BadRequestException({ code: 'amount_required', message: 'Enter an amount.' });
  }
}

/**
 * Only a reported expense can be decided.
 *
 * Deciding an already-decided one is not a retry — the first decision may have
 * moved money — so it is a conflict rather than a silent no-op.
 */
export function assertDecidable(current: { status: string }): void {
  if (current.status !== 'reported') {
    throw new ConflictException({
      code: 'already_decided',
      message:
        current.status === 'confirmed'
          ? 'This expense was already confirmed. Correct it instead.'
          : 'This expense was already rejected.',
    });
  }
}

/**
 * A confirmed expense is never edited or deleted.
 *
 * Correcting one goes through Milestone B's append-only correction workflow,
 * which posts a compensating movement on the current open day rather than
 * rewriting a day that has already been counted.
 */
export function assertNotConfirmed(current: { status: string }): void {
  if (current.status === 'confirmed') {
    throw new ConflictException({
      code: 'already_confirmed',
      message: 'A confirmed expense cannot be changed. Record a correction instead.',
    });
  }
}

/**
 * The compensating day for a variable expense is TODAY, and today must be open.
 *
 * Slotting a movement into a filed closing would rewrite a day the shop has
 * already counted and signed off.
 */
export function assertDayOpen(closing: { isLocked: boolean } | null, day: string): void {
  if (closing?.isLocked) {
    throw new ConflictException({
      code: 'day_already_closed',
      message: `${day} is already closed for this branch. Confirm this expense once the next day opens.`,
    });
  }
}

/**
 * Whether the Owner must be warned before confirming.
 *
 * An expense with no note and no category detail is money leaving the business
 * with nothing said about why. The Owner may still confirm it — small shops
 * genuinely have petty cash — but it is recorded as an explicit
 * `reasonOmitted` state rather than dressed up with placeholder copy.
 * "Miscellaneous" in a ledger is indistinguishable from a real category a year
 * later.
 */
export function needsReasonWarning(input: { note?: string | null }): boolean {
  return !(input.note ?? '').trim();
}

/**
 * The payload fingerprint behind idempotency. Same key and same payload
 * replays; same key and a different payload is a conflict, because that is not
 * a retry — it is a second expense wearing the first one's id.
 */
export function fingerprintExpense(input: {
  category: string;
  amount: number;
  method: ExpenseMethod;
  receivingAccountId?: string | null;
  expenseClass: ExpenseClass;
  dueDate?: string | null;
  note?: string | null;
}): string {
  return createHash('sha256')
    .update(
      [
        input.category.trim(),
        input.amount.toFixed(2),
        input.method,
        input.receivingAccountId ?? '',
        input.expenseClass,
        input.dueDate ?? '',
        (input.note ?? '').trim(),
      ].join('|'),
    )
    .digest('hex');
}
