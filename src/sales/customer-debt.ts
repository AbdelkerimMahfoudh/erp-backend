import { BadRequestException } from '@nestjs/common';
import { parsePayerNumber } from './payer-number';

/**
 * A sale's balance as a customer debt (the owner's brief of 2026-10-17).
 *
 * The receivable is the sale's own `balance_due`: no loan, no second record of
 * the same money. What this adds is the debt's terms — when it is due — and the
 * contact the shop will chase it on:
 *
 * - **Every sale that leaves money owing names its due date**, as a number of
 *   days. The server turns it into a date from the sale's own business day, so a
 *   phone's clock never decides it, and the existing overdue rule (`dueDate`
 *   before today, `anomalies.service.ts`, `health.service.ts`) reminds the Owner
 *   from the day after.
 * - **A customer who owes must have a phone number.** A new customer gives one;
 *   an existing customer with none gets the one typed at the counter. An
 *   existing customer's saved number is never changed from a sale — that is the
 *   customer's own screen. A partner store is reached through its connection and
 *   needs no number here.
 *
 * A fully paid sale has no due date, whatever was sent.
 */

/** A debt is due within a year. The app offers days; nothing longer is a sale on credit. */
export const DEBT_DUE_MAX_DAYS = 365;
/** Digits a phone number must have: the shortest local number (8) to an international one (15). */
const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 15;

const EPSILON = 0.005;

export type CustomerPhone = { ok: true; value: string } | { ok: false; reason: 'customer_phone_required' | 'customer_phone_invalid' };

/**
 * A customer's phone number as stored: the payer-number normalisation (digits,
 * an optional leading +, Arabic-Indic digits read as digits, separators
 * dropped), held to a phone's length.
 */
export function parseCustomerPhone(raw: string | null | undefined): CustomerPhone {
  const parsed = parsePayerNumber(raw);
  if (!parsed.ok) return { ok: false, reason: 'customer_phone_invalid' };
  if (parsed.value === null) return { ok: false, reason: 'customer_phone_required' };
  const digits = parsed.value.replace('+', '').length;
  if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) return { ok: false, reason: 'customer_phone_invalid' };
  return { ok: true, value: parsed.value };
}

/** The refusal for a phone that cannot be the debtor's contact. Names the problem, never the number. */
export function phoneRefusal(reason: 'customer_phone_required' | 'customer_phone_invalid'): BadRequestException {
  return new BadRequestException({
    code: reason,
    message: reason === 'customer_phone_required' ? 'Enter the customer’s phone number' : 'Enter a valid phone number for the customer',
  });
}

/**
 * The days until a balance is due, checked against the balance: required when
 * money is owed, ignored when nothing is.
 */
export function debtDueDays(balanceDue: number, dueInDays: number | undefined): number | null {
  if (balanceDue <= EPSILON) return null;
  if (dueInDays === undefined || dueInDays === null) {
    throw new BadRequestException({ code: 'due_days_required', message: 'Say in how many days the balance is due' });
  }
  if (!Number.isInteger(dueInDays) || dueInDays < 1 || dueInDays > DEBT_DUE_MAX_DAYS) {
    throw new BadRequestException({
      code: 'due_days_invalid',
      message: `The balance is due in 1 to ${DEBT_DUE_MAX_DAYS} days`,
      max: DEBT_DUE_MAX_DAYS,
    });
  }
  return dueInDays;
}

/** The due date: the sale's business day plus the days, as a calendar date (`YYYY-MM-DD`). */
export function dueDateFor(businessDate: string, days: number): string {
  const [y, m, d] = businessDate.split('-').map(Number);
  const due = new Date(Date.UTC(y, m - 1, d + days));
  return due.toISOString().slice(0, 10);
}
