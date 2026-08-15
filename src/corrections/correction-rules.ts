import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * The rules a correction obeys, as pure functions.
 *
 * Kept out of the service so each can be read and tested on its own — these
 * decide whether already-settled money gets un-settled, which is the most
 * consequential judgement in the application.
 */

export type CorrectionKind = 'refund_payout' | 'supplier_settlement';
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
}): string {
  return createHash('sha256')
    .update(
      [
        input.targetKind,
        input.targetId,
        input.reason.trim(),
        (input.supportingReference ?? '').trim(),
      ].join('|'),
    )
    .digest('hex');
}
