import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { SalePayStatus } from '@prisma/client';

/**
 * The rules for a sale that is paid over time (0074).
 *
 * Kept pure — no database, no request — because every one of them is a money
 * rule, and a money rule is only trustworthy if it can be tested on its own.
 */

const EPSILON = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Status from what was RECEIVED, never from whether a request succeeded.
 *
 *   received = 0               → credit  (shown as "Unpaid")
 *   0 < received < total       → partial ("Partially paid")
 *   received = total           → paid    ("Paid in full")
 *
 * `credit` is the schema's historical name for a sale with nothing paid yet.
 */
export function payStatusOf(total: number, received: number): SalePayStatus {
  const remaining = round2(total - received);
  if (remaining <= EPSILON) return 'paid';
  if (received <= EPSILON) return 'credit';
  return 'partial';
}

export interface Balance {
  total: number;
  received: number;
}

/** What the sale looks like after `amount` more arrives. */
export function afterPayment(balance: Balance, amount: number) {
  const received = round2(balance.received + amount);
  const remaining = round2(balance.total - received);
  return { received, remaining, payStatus: payStatusOf(balance.total, received) };
}

/**
 * May this amount be recorded against this balance?
 *
 * A payment is money that arrived: never zero, never negative, and never more
 * than is still owed. Overpayment is refused rather than recorded as change or
 * credit — there is no customer credit in this model, and a shop that took too
 * much has a conversation to have, not a figure to hide.
 */
export function assertCollectable(balance: Balance, amount: number): void {
  if (!(amount > 0)) {
    throw new BadRequestException({ code: 'payment_not_positive', message: 'A payment must be more than zero' });
  }
  const remaining = round2(balance.total - balance.received);
  if (remaining <= EPSILON) {
    throw new ConflictException({ code: 'already_paid', message: 'This sale is already paid in full' });
  }
  if (amount > remaining + EPSILON) {
    throw new BadRequestException({
      code: 'overpayment',
      message: `Only ${remaining} is still owed on this sale`,
    });
  }
}

// ── who owes the balance ────────────────────────────────────────────────────

export type DebtorChoice =
  | { kind: 'none' }
  | { kind: 'customer_existing'; customerId: string }
  | { kind: 'customer_new'; name: string; phone: string | null }
  | { kind: 'store'; counterpartyId: string };

/**
 * Exactly one debtor, or none.
 *
 * A balance owed by a customer AND a store would be counted twice in every
 * outstanding list. Refused outright rather than one silently winning.
 */
export function chooseDebtor(input: {
  customerId?: string;
  customer?: { name: string; phone?: string };
  counterpartyId?: string;
}): DebtorChoice {
  const named = [input.customerId, input.customer, input.counterpartyId].filter((v) => v !== undefined && v !== null);
  if (named.length > 1) {
    throw new BadRequestException({
      code: 'one_debtor',
      message: 'A balance is owed by one customer or one store, not both',
    });
  }
  if (input.customerId) return { kind: 'customer_existing', customerId: input.customerId };
  if (input.counterpartyId) return { kind: 'store', counterpartyId: input.counterpartyId };
  if (input.customer) {
    const name = input.customer.name.trim();
    if (name.length === 0) {
      throw new BadRequestException({ code: 'customer_name_required', message: 'Enter the customer’s name' });
    }
    const phone = input.customer.phone?.trim() || null;
    return { kind: 'customer_new', name, phone };
  }
  return { kind: 'none' };
}

/** A sale that leaves money owing must say who owes it. */
export function assertDebtorForBalance(balanceDue: number, debtor: DebtorChoice): void {
  if (balanceDue > EPSILON && debtor.kind === 'none') {
    throw new BadRequestException({
      code: 'debtor_required',
      message: 'Say who owes the remaining balance — a customer or a partner store',
    });
  }
}

/** Only a store may owe a store balance: never a person or an employee. */
export const STORE_KINDS = ['connected_store', 'manual_store'] as const;

// ── when the money arrived ──────────────────────────────────────────────────

/**
 * The instant a later payment is recorded against.
 *
 * Defaults to now. It may be earlier — a shop often records the evening's
 * collections at closing — but never in the future, and never before the sale
 * it pays for.
 */
export function resolvePaidAt(requested: string | undefined, soldAt: Date, now: Date = new Date()): Date {
  if (!requested) return now;
  const at = new Date(requested);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException({ code: 'paid_at_invalid', message: 'That payment date is not a date' });
  }
  // A minute of grace for a phone whose clock is slightly ahead.
  if (at.getTime() > now.getTime() + 60_000) {
    throw new BadRequestException({ code: 'paid_at_future', message: 'A payment cannot be recorded in the future' });
  }
  if (at.getTime() < soldAt.getTime()) {
    throw new BadRequestException({
      code: 'paid_at_before_sale',
      message: 'A payment cannot be earlier than the sale it pays for',
    });
  }
  return at;
}

// ── idempotency ─────────────────────────────────────────────────────────────

/**
 * The payload a key is bound to.
 *
 * Everything that changes what is recorded goes in, so reusing a key for a
 * different amount, account or day is detected. The date is reduced to the
 * minute: a retry a few seconds later is the same payment.
 */
export function collectionFingerprint(input: {
  saleId: string;
  amount: number;
  method: string;
  receivingAccountId?: string | null;
  paidAt?: string | null;
  reference?: string | null;
  note?: string | null;
}): string {
  const canonical = JSON.stringify({
    saleId: input.saleId,
    amount: round2(input.amount).toFixed(2),
    method: input.method,
    account: input.receivingAccountId ?? null,
    paidAt: input.paidAt ? new Date(input.paidAt).toISOString().slice(0, 16) : null,
    reference: input.reference?.trim() || null,
    note: input.note?.trim() || null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
