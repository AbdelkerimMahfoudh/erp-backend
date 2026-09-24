import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * The rules a correction obeys, as pure functions.
 *
 * Kept out of the service so each can be read and tested on its own — these
 * decide whether already-settled money gets un-settled, which is the most
 * consequential judgement in the application.
 */

export type CorrectionKind = 'refund_payout' | 'supplier_settlement' | 'sale_payment';
export type CorrectionStatus = 'requested' | 'approved' | 'rejected';

/**
 * Only a CONFIRMED payment can be corrected.
 *
 * A merely reported one has moved no money and settled no liability, so there
 * is nothing to compensate — and it already has its own correction path
 * (`PATCH /returns/:id/refund`, `correctSettlement`). Routing a reported
 * payment through here would post a compensating movement for cash that never
 * left, inventing money.
 */
export function assertTargetCorrectable(target: { status: string } | null): void {
  if (!target) {
    throw new BadRequestException('That payment does not exist.');
  }
  if (target.status !== 'confirmed') {
    throw new ConflictException({
      code: 'not_confirmed',
      message:
        'Only a confirmed payment can be corrected. One that is still awaiting confirmation can be changed directly.',
    });
  }
}

/**
 * A correction is a one-shot. The database enforces this too — at most one
 * approved correction may exist per target — but failing here gives the caller
 * a sentence instead of a duplicate-key error.
 */
export function assertNotAlreadyCorrected(existing: { status: string }[] | null): void {
  const approved = (existing ?? []).some((c) => c.status === 'approved');
  if (approved) {
    throw new ConflictException({
      code: 'already_corrected',
      message: 'This payment has already been corrected. Record a replacement payment instead.',
    });
  }
}

/**
 * One open request at a time.
 *
 * Two people asking to correct the same payment is not an error worth a stack
 * trace, but letting both stand would leave an owner approving one and
 * wondering what the other was for.
 */
export function assertNoOpenRequest(existing: { status: string }[] | null): void {
  const open = (existing ?? []).some((c) => c.status === 'requested');
  if (open) {
    throw new ConflictException({
      code: 'request_pending',
      message: 'Someone has already asked for this payment to be corrected. That request is waiting for an owner.',
    });
  }
}

/** A reason that is only whitespace is not a reason. The DB agrees. */
export function assertReasonGiven(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) {
    throw new BadRequestException({
      code: 'reason_required',
      message: 'Say why this payment is being corrected.',
    });
  }
  return trimmed;
}

/**
 * Only a request that is still open can be decided.
 *
 * Deciding an already-decided one is not a retry — the first decision may have
 * moved money — so it is a conflict rather than a silent no-op.
 */
export function assertDecidable(current: { status: string }): void {
  if (current.status !== 'requested') {
    throw new ConflictException({
      code: 'already_decided',
      message:
        current.status === 'approved'
          ? 'This correction was already approved.'
          : 'This correction was already rejected.',
    });
  }
}

/**
 * The compensating movement lands on the CURRENT open business day, never on
 * the day of the original payment.
 *
 * If today is closed, the correction waits. Reopening a filed closing to slot a
 * movement into it would rewrite a day the shop has already counted and signed
 * off — which is the exact thing this whole design exists to avoid.
 */
export function assertDayOpen(closing: { isLocked: boolean } | null, day: string): void {
  if (closing?.isLocked) {
    // Same code and shape as the refund/settlement confirmation guard, so the
    // mobile conflict handler recognises it without a second branch.
    throw new ConflictException({
      code: 'day_already_closed',
      message: `${day} is already closed for this branch. A correction posts to the current open day, so this must wait until the next one opens.`,
    });
  }
}

/**
 * The payload fingerprint behind idempotency.
 *
 * Same key and same payload replays the original; same key and a DIFFERENT
 * payload is a conflict, because that is not a retry — it is a second
 * correction wearing the first one's id.
 */
export function fingerprintCorrection(input: {
  targetKind: CorrectionKind;
  targetId: string;
  reason: string;
  supportingReference?: string | null;
  toMethod?: 'cash' | 'account' | null;
  toAccountId?: string | null;
  amount?: number | null;
}): string {
  const parts = [input.targetKind, input.targetId, input.reason.trim(), (input.supportingReference ?? '').trim()];
  // A reclassification is also defined by where the money goes and how much of it (0078).
  if (input.targetKind === 'sale_payment') parts.push(input.toMethod ?? '', input.toAccountId ?? '', String(input.amount ?? ''));
  return createHash('sha256')
    .update(parts.join('|'))
    .digest('hex');
}

// ── Reclassifying a payment to the channel it really reached (0078, docs/51 D9) ──

export interface PaymentTarget {
  amount: number;
  /** Where the payment was recorded: cash, or an account (NULL = unattributed). */
  fromMethod: 'cash' | 'account';
  fromAccountId: string | null;
}

export interface Destination {
  toMethod: 'cash' | 'account';
  toAccountId: string | null;
  /** Whether the destination account is active; irrelevant for cash. */
  toAccountActive: boolean;
}

/**
 * A payment recorded against the wrong channel — Cash for Bankily, one account for
 * another, or part of it — is moved to the channel it really reached. Nothing else
 * about the sale changes: the amount collected stays the same, so what the customer
 * owes stays the same.
 *
 * Refused, by name: moving nothing or more than was paid; moving money to the
 * channel it is already in; cash that names an account or an account that names
 * none; an inactive account.
 */
export function assertReclassifiable(target: PaymentTarget, to: Destination, amount: number): void {
  if (!(amount > 0)) {
    throw new BadRequestException({ code: 'amount_required', message: 'Say how much of the payment went to another channel.' });
  }
  if (Math.round(amount * 100) > Math.round(target.amount * 100)) {
    throw new BadRequestException({ code: 'amount_above_payment', message: 'You cannot move more than the payment recorded.' });
  }
  if (to.toMethod === 'cash' && to.toAccountId) {
    throw new BadRequestException({ code: 'cash_has_no_account', message: 'Cash belongs to no account.' });
  }
  if (to.toMethod === 'account' && !to.toAccountId) {
    throw new BadRequestException({ code: 'account_required', message: 'Say which account the money reached.' });
  }
  if (to.toMethod === 'account' && !to.toAccountActive) {
    throw new BadRequestException({ code: 'account_inactive', message: 'That account is no longer active.' });
  }
  const same = to.toMethod === target.fromMethod && (to.toAccountId ?? null) === (target.fromAccountId ?? null);
  if (same) {
    throw new BadRequestException({ code: 'same_channel', message: 'The payment is already recorded in that channel.' });
  }
}
