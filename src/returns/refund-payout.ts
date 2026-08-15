import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * The rules of settling a refund, as pure functions.
 *
 * The application never moves money. It records that the shop says money moved,
 * and separates two claims that are easy to confuse:
 *
 *   the REPORT        somebody handed the cash over and says so
 *   the CONFIRMATION  a manager or owner agrees that they did
 *
 * Only the second is the record. Everything here exists to keep the first from
 * being mistaken for it.
 */

export type RefundMethod = 'cash' | 'account';

/**
 * Cash carries no account; a configured channel must have one.
 *
 * Enforced here rather than by a CHECK because `receiving_account_id` is a
 * foreign key, and MySQL error 3823 forbids a CHECK over a column that
 * participates in one — the limitation `0002` documents.
 */
export function assertMethodAndAccount(method: RefundMethod, receivingAccountId?: string | null): void {
  if (method === 'cash' && receivingAccountId) {
    throw new BadRequestException('A cash refund has no account. Choose an account, or leave it out.');
  }
  if (method === 'account' && !receivingAccountId) {
    throw new BadRequestException('Choose which account the money went out of');
  }
}

/**
 * The amount is the shop's own immutable figure, not the client's.
 *
 * I3 has no partial payout: reporting anything other than what was owed is a
 * different product decision, and inventing customer debt is another. Both are
 * refused rather than rounded towards.
 */
export function assertAmountMatchesDue(reported: number, netAmountDue: number): void {
  const cents = (n: number) => Math.round(n * 100);
  if (cents(reported) !== cents(netAmountDue)) {
    throw new BadRequestException(
      `The refund must be exactly ${netAmountDue.toFixed(2)}. Partial refunds are not supported.`,
    );
  }
}

/**
 * A canonical fingerprint of the report, so an offline retry returns the
 * original record and a DIFFERENT report under the same key is a conflict
 * rather than a silent overwrite.
 */
export function fingerprintPayout(payload: {
  returnRequestId: string;
  method: RefundMethod;
  receivingAccountId?: string | null;
  reportedAmount: number;
  transactionReference?: string | null;
  note?: string | null;
}): string {
  const canonical = [
    payload.returnRequestId.toLowerCase(),
    payload.method,
    (payload.receivingAccountId ?? '').toLowerCase(),
    Math.round(payload.reportedAmount * 100).toString(),
    (payload.transactionReference ?? '').trim(),
    (payload.note ?? '').trim(),
  ].join(' ');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Everything after confirmation is read-only. */
export function assertCorrectable(status: 'reported_pending_confirmation' | 'confirmed'): void {
  if (status === 'confirmed') {
    throw new ConflictException({
      code: 'already_confirmed',
      message: 'This refund has been confirmed and can no longer be changed.',
    });
  }
}

/**
 * Whether a return is in a state where its refund can be reported at all.
 *
 * A refund cannot be reported before it is owed. `approved_refund_due` is the
 * only status that means "the shop owes this money and has not settled it".
 */
export function assertReportable(returnStatus: string, hasReversal: boolean): void {
  if (returnStatus !== 'approved_refund_due') {
    throw new ConflictException({
      code: 'not_awaiting_refund',
      message:
        returnStatus === 'rejected'
          ? 'This return was rejected, so no refund is owed.'
          : 'This return has not been approved yet, so no refund is owed.',
    });
  }
  if (!hasReversal) {
    // Belt and braces: an approved return always has one, and a payout without
    // it would have no immutable amount to be measured against.
    throw new ConflictException({
      code: 'missing_reversal',
      message: 'This return has no approved refund record.',
    });
  }
}

/**
 * A refund of zero is a real outcome — adjustments can consume the whole refund
 * — but there is nothing to hand over, so a settlement record would assert a
 * payment that never happened.
 */
export function assertWorthSettling(netAmountDue: number): void {
  if (Math.round(netAmountDue * 100) === 0) {
    throw new BadRequestException({
      code: 'nothing_to_refund',
      message:
        'The withheld charges cover the whole refund, so nothing is owed. There is no payment to record.',
    });
  }
}
