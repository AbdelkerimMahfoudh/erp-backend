import type { AccountDeletionKind, AccountDeletionStatus, OtpPurpose, OtpStatus } from '@prisma/client';

/**
 * The rules of account deletion, as pure functions (docs/64 §2).
 *
 * Everything here is decided from server-held facts and nothing from the
 * client: who may close a business, how recent the password proof must be,
 * what the executor accepts as proof that the account holder typed the code,
 * and what a de-identified login looks like.
 */

/** A request older than this needs the password again. "Recent reauthentication" has a number. */
export const REQUEST_MAX_AGE_MS = 30 * 60 * 1000;

/** The executor accepts a verification no older than this. A stale proof is no proof. */
export const VERIFIED_PROOF_MAX_AGE_MS = 15 * 60 * 1000;

export const DELETED_USER_NAME = 'Deleted user';

/**
 * A hash no password verifies against. Argon2 refuses to parse it, and
 * `HashingService.verify` turns that refusal into `false`, so a de-identified
 * login can never be signed into even if `isActive` were flipped back by hand.
 */
export const UNUSABLE_PASSWORD_HASH = '$deleted$';

export const OPEN_STATUSES: readonly AccountDeletionStatus[] = ['awaiting_code', 'confirmed', 'processing'];

export function isOpen(status: AccountDeletionStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/**
 * What a person's deletion deletes.
 *
 * The last active Owner closes the business — there is nobody left to run it.
 * An Owner who is not the last one, and everybody else, deletes their own
 * login and the business continues. Decided from the role table, never from
 * the request body.
 */
export function deletionKindFor(input: { holdsOwnerRole: boolean; otherActiveOwners: number }): AccountDeletionKind {
  return input.holdsOwnerRole && input.otherActiveOwners === 0 ? 'company_closure' : 'personal_login';
}

export function requestIsFresh(reauthenticatedAt: Date, now: Date): boolean {
  return now.getTime() - reauthenticatedAt.getTime() <= REQUEST_MAX_AGE_MS;
}

/** The login a de-identified user keeps. Unique per company because the id is. */
export function deidentifiedLogin(userId: Buffer): string {
  return `deleted-${userId.toString('hex')}`;
}

export interface ProofChallenge {
  id: Buffer;
  companyId: Buffer;
  userId: Buffer;
  purpose: OtpPurpose;
  status: OtpStatus;
  verifiedAt: Date | null;
  destination: string;
}

export interface ProofRequest {
  id: Buffer;
  companyId: Buffer;
  userId: Buffer;
  status: AccountDeletionStatus;
  challengeId: Buffer | null;
}

/**
 * Whether the executor may act. Every clause is a separate refusal so a test
 * can name the one it is checking, and so a log line says exactly what was
 * wrong rather than "refused".
 */
export function proofProblem(request: ProofRequest, challenge: ProofChallenge | null, now: Date): string | null {
  if (request.status !== 'confirmed') return `request is ${request.status}, not confirmed`;
  if (!request.challengeId || !challenge) return 'request has no challenge';
  if (!challenge.id.equals(request.challengeId)) return 'challenge is not the request\'s';
  if (!challenge.companyId.equals(request.companyId)) return 'challenge belongs to another company';
  if (!challenge.userId.equals(request.userId)) return 'challenge belongs to another user';
  if (challenge.purpose !== 'account_deletion') return `challenge purpose is ${challenge.purpose}`;
  if (challenge.status !== 'verified' || !challenge.verifiedAt) return 'challenge was not verified';
  if (now.getTime() - challenge.verifiedAt.getTime() > VERIFIED_PROOF_MAX_AGE_MS) return 'verification is too old';
  return null;
}
