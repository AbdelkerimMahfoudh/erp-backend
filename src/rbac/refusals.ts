import { ForbiddenException } from '@nestjs/common';

/**
 * The two access refusals, each with a stable code (docs/73 §11.4, D161).
 *
 * They were bare sentences, and a phone replaying a queued write after
 * reconnecting met them before its key was ever looked up: it had to parse
 * English to tell "this person may no longer do this" from "this person is no
 * longer at this branch". The sentences are unchanged; the codes are what a
 * client branches on.
 */

export const PERMISSION_DENIED = 'permission_denied';
export const BRANCH_ACCESS_DENIED = 'branch_access_denied';

/** 403: the keys the caller lacks, by name, so a client can say which and stop retrying. */
export function permissionDenied(missing: readonly string[], message = `Missing permission(s): ${missing.join(', ')}`): ForbiddenException {
  return new ForbiddenException({ code: PERMISSION_DENIED, message, missing: [...missing] });
}

/**
 * 403: the caller is not assigned to the branch asked about. One wording for
 * every place that checks, so a caller cannot tell from the answer whether the
 * branch exists, only that it is not theirs.
 */
export function branchAccessDenied(): ForbiddenException {
  return new ForbiddenException({ code: BRANCH_ACCESS_DENIED, message: 'No access to the requested branch' });
}
