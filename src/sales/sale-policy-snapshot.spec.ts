import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETURN_WINDOW_MAX_HOURS, RETURN_WINDOW_NONE } from '../settings/settings.constants';
import { MAX_WINDOW_HOURS, NO_RETURNS } from './return-policy';

/**
 * How the snapshot reaches a sale (I1-CP4).
 *
 * `createSale` is a single long transaction over eight collaborators, and a
 * double for it proves mostly that the double agrees with itself. The
 * decisions worth pinning are the ones a future edit could quietly undo, and
 * each is checkable directly:
 *
 *   - the window bounds are the Settings module's, not a second copy;
 *   - the sale and its deadline come from ONE server timestamp;
 *   - the company default is read inside the transaction;
 *   - an ordinary sale records no override, and a real one is audited;
 *   - an offline retry replays the ORIGINAL policy.
 *
 * The rules themselves — who may override, what may be shortened, when a
 * return is still open — are exhaustively tested in `return-policy.spec.ts`
 * against the pure functions this path calls.
 */

const SRC = join(__dirname);
const service = readFileSync(join(SRC, 'sales.service.ts'), 'utf8');
const dto = readFileSync(join(SRC, 'dto', 'create-sale.dto.ts'), 'utf8');

describe('one set of window bounds, not two', () => {
  /**
   * `settings.constants` says it in its own header: a rule enforced in several
   * places drifts, and a maximum that drifts is a maximum that is not enforced.
   * A sale must not be able to carry a window the Owner could never have saved.
   */
  it('the sale policy uses the same bounds the Settings API enforces', () => {
    expect(NO_RETURNS).toBe(RETURN_WINDOW_NONE);
    expect(MAX_WINDOW_HOURS).toBe(RETURN_WINDOW_MAX_HOURS);
  });

  it('the DTO validates against those same constants rather than literals', () => {
    expect(dto).toContain('settings.constants');
    expect(dto).toMatch(/@Min\(RETURN_WINDOW_NONE\)/);
    expect(dto).toMatch(/@Max\(RETURN_WINDOW_MAX_HOURS\)/);
  });

  it('accepts a per-sale window and the reason for it', () => {
    expect(dto).toMatch(/returnWindowHours\?: number;/);
    expect(dto).toMatch(/returnPolicyReason\?: string;/);
  });
});

describe('the sale and its deadline come from one server clock', () => {
  it('takes a single soldAt and writes it, rather than calling new Date() twice', () => {
    expect(service).toMatch(/const soldAt = new Date\(\);/);
    expect(service).toMatch(/snapshotPolicy\(soldAt, resolvedPolicy\.windowHours\)/);
    // The old code built the row with an inline `soldAt: new Date()`. Two
    // instants a few milliseconds apart would put the deadline out of step with
    // the sale it was measured from.
    expect(service).not.toMatch(/soldAt: new Date\(\)/);
  });

  it('never takes the deadline from the request', () => {
    expect(service).not.toMatch(/dto\.returnDeadlineAt/);
    expect(service).not.toMatch(/dto\.soldAt/);
  });
});

describe('the company default is read inside the transaction', () => {
  it('reads settings from the transaction client, not the ambient one', () => {
    expect(service).toMatch(/tx\.companySettings\.findUnique/);
    expect(service).not.toMatch(/this\.db\.companySettings/);
  });

  /**
   * A company with no settings row has never chosen a policy. Defaulting to
   * anything other than "no returns" would invent a promise the shop never
   * made — the same reasoning that made migration 0035 backfill 0/NULL.
   */
  it('treats a missing settings row as "no returns", not as an unset value', () => {
    expect(service).toMatch(/settings\?\.returnWindowHours \?\? NO_RETURNS/);
  });
});

describe('the override is recorded only when there was one', () => {
  it('stamps the overriding user only for a real change', () => {
    expect(service).toMatch(/returnPolicyOverriddenById: resolvedPolicy\.overridden \? userId : null/);
  });

  it('writes its own audit row, in the same transaction as the sale', () => {
    const block = service.slice(service.indexOf('if (resolvedPolicy.overridden)'));
    expect(block).toMatch(/this\.audit\.recordTx\(tx, \{/);
    expect(block).toMatch(/reason: resolvedPolicy\.overrideReason/);
    // Distinguishable from the below-cost override, which shares the action.
    expect(block).toMatch(/field: 'returnPolicy'/);
    // Both sides, so the row answers what it was and what it became.
    expect(block).toMatch(/before: \{ field: 'returnPolicy', returnWindowHours/);
  });

  it('asks the caller’s permissions rather than trusting a flag in the request', () => {
    expect(service).toMatch(/canOverride: this\.cls\.get\('permissions'\)\?\.has\('return\.policy\.override'\)/);
    expect(service).not.toMatch(/dto\.canOverride/);
  });
});

describe('the response carries the policy the customer was sold', () => {
  it('returns the snapshot, so the receipt can state it', () => {
    expect(service).toMatch(/returnPolicy: \{\s*windowHours: result\.returnWindowHours/);
  });

  /**
   * An offline retry must reprint the SAME promise. Re-deriving it from
   * today's setting would let the second attempt hand the customer a different
   * receipt from the first.
   */
  it('replays the original sale’s policy on an idempotent retry', () => {
    const replay = service.slice(service.indexOf('private toResponse'));
    expect(replay).toMatch(/windowHours: sale\.returnWindowHours/);
    expect(replay).toMatch(/deadlineAt: sale\.returnDeadlineAt/);
    expect(replay).not.toMatch(/companySettings/);
  });
});
