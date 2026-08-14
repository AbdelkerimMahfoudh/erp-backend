import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RETURN_WINDOW_MAX_HOURS, RETURN_WINDOW_NONE } from '../settings/settings.constants';

/**
 * The return policy a sale is sold under, and whether a return is still open.
 *
 * ## Why the policy is snapshotted onto the sale
 *
 * `company_settings.return_window_hours` is what the shop offers **today**.
 * Eligibility computed from it would move under the customer's feet: shortening
 * the window tomorrow would retroactively cancel a right already promised, and
 * lengthening it would silently grant one nobody offered. So the sale carries
 * the policy it was sold under, written once and never updated.
 *
 * ## Why the server decides
 *
 * A phone's clock can be wrong, deliberately or otherwise. Eligibility is
 * computed here, from the server's own time, and the client is told the answer
 * rather than asked for it. The object returned is informational — in I1
 * nothing acts on it, and in I2 the return endpoint will recompute rather than
 * trust what a screen was showing.
 */

/**
 * The bounds come from the Settings module rather than being restated here.
 * The same numbers already govern what an Owner may save, and
 * `settings.constants` says why in its own header: a rule enforced in several
 * places drifts, and a maximum that drifts is a maximum that is not enforced.
 * A sale must never be able to carry a window the shop could not have set.
 */
/** `0` means the shop accepts no returns at all. */
export const NO_RETURNS = RETURN_WINDOW_NONE;
/** A year. Beyond this a "window" is not a policy, it is a liability. */
export const MAX_WINDOW_HOURS = RETURN_WINDOW_MAX_HOURS;

export interface ReturnPolicySnapshot {
  windowHours: number;
  /** `null` when the window is 0 — never a date in the past standing in for it. */
  deadlineAt: Date | null;
}

/**
 * Work out what a new sale should carry.
 *
 * `soldAt` is the server's own timestamp for the sale; the deadline is derived
 * from it so the two can never disagree.
 */
export function snapshotPolicy(soldAt: Date, windowHours: number): ReturnPolicySnapshot {
  if (!Number.isInteger(windowHours) || windowHours < NO_RETURNS || windowHours > MAX_WINDOW_HOURS) {
    throw new BadRequestException(`Return window must be a whole number of hours between 0 and ${MAX_WINDOW_HOURS}`);
  }
  return {
    windowHours,
    deadlineAt: windowHours === NO_RETURNS ? null : new Date(soldAt.getTime() + windowHours * 3_600_000),
  };
}

export interface OverrideRequest {
  /** What the caller wants this sale's window to be. */
  windowHours: number;
  reason?: string;
}

/**
 * Decide the window for one sale, enforcing who may change it.
 *
 * Three rules, and the third is the one worth stating plainly:
 *
 *  - Without `return.policy.override` the company default is used, and asking
 *    for anything else is refused rather than silently ignored. An employee who
 *    thinks they set a different policy must not be told the sale succeeded
 *    under it.
 *  - A change needs a reason. "Why is this sale different?" is the question an
 *    Owner will ask in three months, and the answer has to be recorded now.
 *  - **A positive default may not be shortened to another positive value.**
 *    Trimming 48 hours to 2 is quietly selling a worse promise under the same
 *    banner. Removing the window entirely (`0`) stays allowed, because that is
 *    an explicit, visible decision the customer is told about at the till —
 *    and lengthening is always allowed, since it only ever favours the
 *    customer.
 */
export function resolveWindowForSale(input: {
  companyDefaultHours: number;
  requested?: OverrideRequest;
  canOverride: boolean;
}): { windowHours: number; overrideReason: string | null; overridden: boolean } {
  const { companyDefaultHours, requested, canOverride } = input;

  if (!requested || requested.windowHours === companyDefaultHours) {
    // Re-stating the default is not an override, so it needs no authority and
    // no reason — the sale simply carries what the shop offers.
    return { windowHours: companyDefaultHours, overrideReason: null, overridden: false };
  }

  if (!canOverride) {
    throw new ForbiddenException('Only a manager or the owner may change the return policy for a sale');
  }

  const reason = requested.reason?.trim();
  if (!reason) {
    throw new BadRequestException('Say why this sale has a different return policy');
  }

  if (
    !Number.isInteger(requested.windowHours) ||
    requested.windowHours < NO_RETURNS ||
    requested.windowHours > MAX_WINDOW_HOURS
  ) {
    throw new BadRequestException(`Return window must be a whole number of hours between 0 and ${MAX_WINDOW_HOURS}`);
  }

  const shorteningAPositiveDefault =
    companyDefaultHours > NO_RETURNS &&
    requested.windowHours > NO_RETURNS &&
    requested.windowHours < companyDefaultHours;

  if (shorteningAPositiveDefault) {
    throw new BadRequestException(
      'A return window can be removed entirely or extended, but not quietly shortened. ' +
        'Set it to 0 to sell with no returns, or choose a longer window.',
    );
  }

  return { windowHours: requested.windowHours, overrideReason: reason, overridden: true };
}

/** Why a return is or is not open, in terms a screen can explain. */
export type EligibilityReason =
  | 'no_return_policy'
  | 'within_window'
  | 'window_expired'
  | 'already_returned'
  | 'quantity_not_supported'
  | 'sale_reversed';

export interface ReturnEligibility {
  eligibleByPolicy: boolean;
  deadlineAt: Date | null;
  /** Milliseconds left, or `null` when there is no deadline to count down to. */
  remainingMs: number | null;
  reason: EligibilityReason;
  /** True when only an Owner exception could still let this through (I2). */
  requiresOwnerException: boolean;
}

/**
 * Is this sale still returnable, as of `now` on the server?
 *
 * Deliberately reports one reason rather than a list: a screen needs a sentence
 * to show the customer, and the order below is the order that matters. A
 * reversed sale is settled, a policy of "no returns" is absolute, an expired
 * deadline can still be rescued by an Owner, and everything else is open.
 */
export function evaluateEligibility(input: {
  windowHours: number;
  deadlineAt: Date | null;
  now: Date;
  isReversed?: boolean;
  hasReturn?: boolean;
  quantityOnly?: boolean;
}): ReturnEligibility {
  const { windowHours, deadlineAt, now } = input;
  const base = { deadlineAt, remainingMs: null as number | null };

  if (input.isReversed) {
    return { ...base, eligibleByPolicy: false, reason: 'sale_reversed', requiresOwnerException: false };
  }
  if (input.hasReturn) {
    return { ...base, eligibleByPolicy: false, reason: 'already_returned', requiresOwnerException: false };
  }
  if (windowHours === NO_RETURNS || deadlineAt === null) {
    // An Owner exception could still authorise this, but it is not "expired" —
    // nothing was ever promised, and the screen should say so differently.
    return { ...base, eligibleByPolicy: false, reason: 'no_return_policy', requiresOwnerException: true };
  }
  if (input.quantityOnly) {
    // Accessory-only returns are I2+ work; saying so beats a vague refusal.
    return { ...base, eligibleByPolicy: false, reason: 'quantity_not_supported', requiresOwnerException: false };
  }

  const remainingMs = deadlineAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return { deadlineAt, remainingMs: 0, eligibleByPolicy: false, reason: 'window_expired', requiresOwnerException: true };
  }
  return { deadlineAt, remainingMs, eligibleByPolicy: true, reason: 'within_window', requiresOwnerException: false };
}
