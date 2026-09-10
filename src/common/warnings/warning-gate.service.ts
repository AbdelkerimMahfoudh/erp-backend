import { ConflictException, Injectable } from '@nestjs/common';
import { TenantContext } from '../tenant/tenant-context.service';
import { binToUuid } from '../utils/uuid.util';
import {
  AcknowledgementFailure,
  issueAcknowledgement,
  verifyAcknowledgement,
} from './acknowledgement';
import { Warning, WarningResponse } from './warning.types';

/**
 * The one place a mutation asks "may I proceed past what I just found?".
 *
 * Every warned mutation follows the same three lines: build the warnings,
 * ask this, and either return the response it hands back or carry on. Putting
 * the decision in one object is what stops five call sites from each inventing
 * a slightly different idea of what an expired acknowledgement means.
 *
 * ## Two very different failures
 *
 * A token that does not verify is either **someone must look again** or
 * **something is wrong**, and they must not be conflated:
 *
 * - *expired*, *payload_changed*, *warnings_changed* and a missing token are the
 *   first. The answer is a **fresh warning response** — the person is shown what
 *   the server thinks now and answers it. `reissuedBecause` says which, so an
 *   interactive user sees "please confirm again" while the offline queue can
 *   tell that the world moved under a request it was holding.
 * - *bad_signature*, *wrong_actor*, *wrong_tenant* and *wrong_operation* are the
 *   second. No client reaches those by being slow: a token was forged, replayed
 *   from another person, carried between shops, or reused for a different
 *   operation. Re-issuing would quietly launder it, so it is a **409** naming
 *   what failed.
 *
 * ## Why a warned mutation writes nothing
 *
 * The caller must ask this **before its first write**. Warning after the row
 * exists makes the warning decorative — the mistake is already recorded and
 * the person is being told about their own history.
 */

/** Failures that mean "ask the person again", not "something is wrong". */
const REISSUE: ReadonlySet<AcknowledgementFailure> = new Set([
  'malformed',
  'expired',
  'payload_changed',
  'warnings_changed',
]);

export interface WarningGateResult {
  /** True when the mutation may proceed. */
  ok: boolean;
  /** Present when it may not — return this to the caller, unchanged. */
  response?: WarningResponse;
}

/** A warning response, plus why an earlier acknowledgement no longer covers it. */
export interface ReissuedWarningResponse extends WarningResponse {
  reissuedBecause?: Extract<
    AcknowledgementFailure,
    'expired' | 'payload_changed' | 'warnings_changed'
  >;
}

@Injectable()
export class WarningGate {
  constructor(private readonly tenant: TenantContext) {}

  /**
   * @param operation the offline policy's own name for it — `sale.create`.
   * @param payload the request body **without** the token, so adding one does
   *   not change the hash the token is bound to.
   * @param warnings what the server found. Empty means proceed.
   * @param token what the caller sent back, if anything.
   */
  check(params: {
    operation: string;
    payload: unknown;
    warnings: readonly Warning[];
    token: string | undefined;
  }): WarningGateResult {
    if (params.warnings.length === 0) return { ok: true };

    const userId = this.tenant.userId();
    const branchId = this.tenant.branchId() ?? null;
    const subject = {
      actorId: userId ? binToUuid(userId) : '-',
      companyId: binToUuid(this.tenant.companyId()),
      branchId: branchId ? binToUuid(branchId) : null,
      operation: params.operation,
    };

    const verdict = verifyAcknowledgement(
      params.token,
      subject,
      params.payload,
      params.warnings,
    );
    if (verdict.ok) return { ok: true };

    if (!REISSUE.has(verdict.reason)) {
      throw new ConflictException({
        code: 'acknowledgement_rejected',
        reason: verdict.reason,
        message: 'That confirmation does not belong to this request. Please try again.',
      });
    }

    const issued = issueAcknowledgement(subject, params.payload, params.warnings);
    const response: ReissuedWarningResponse = {
      status: 'warnings_pending',
      warnings: [...params.warnings],
      acknowledgementToken: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
    };
    /*
     * A first look is not a re-issue. `malformed` here means no token at all,
     * which is simply the first time the caller has seen this — saying "your
     * confirmation expired" to someone who never gave one would be a lie.
     */
    if (params.token && verdict.reason !== 'malformed') {
      response.reissuedBecause = verdict.reason as ReissuedWarningResponse['reissuedBecause'];
    }
    return { ok: false, response };
  }
}
