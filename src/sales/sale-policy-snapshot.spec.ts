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

  /*
   * The sale screen no longer chooses a policy (the owner's brief of
   * 2026-10-28). An older app may still send a window: it is still validated,
   * accepted, and IGNORED — the branch's configured policy decides.
   */
  it('keeps the legacy per-sale fields only as ignored, validated input', () => {
    expect(dto).toMatch(/returnWindowHours\?: number;/);
    expect(dto).toMatch(/LEGACY — accepted and IGNORED/);
    expect(service).not.toMatch(/dto\.returnWindowHours|dto\.returnPolicyReason/);
  });
});

describe('the sale and its deadline come from one server clock', () => {
  it('takes a single soldAt and writes it, rather than calling new Date() twice', () => {
    expect(service).toMatch(/const soldAt = new Date\(\);/);
    expect(service).toMatch(/snapshotPolicy\(soldAt, policy\.windowHours\)/);
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

describe('the configured policy is resolved by the server, inside the transaction (0108)', () => {
  it('reads the branch policy, else the company window, from the transaction client', () => {
    expect(service).toMatch(/const policy = await effectivePolicy\(tx as never, companyId, branchId\);/);
    expect(service).not.toMatch(/this\.db\.companySettings/);
  });

  it('records no override: the screen cannot depart from the policy any more', () => {
    expect(service).toMatch(/returnPolicyOverriddenById: null,/);
    expect(service).not.toMatch(/resolvedPolicy|return\.policy\.override/);
  });

  it('snapshots the written conditions, their language and version, and the customer as named', () => {
    for (const field of ['returnPolicyTextEn: policy.textEn', 'returnPolicyTextFr: policy.textFr', 'returnPolicyTextAr: policy.textAr', 'returnPolicyLanguage: policy.defaultLanguage', 'returnPolicyVersion: policy.version', 'customerNameSnapshot: named?.name?.trim() || null']) {
      expect(service).toContain(field);
    }
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
    expect(replay).toMatch(/\.\.\.policyTexts\(sale\)/);
    expect(replay).toMatch(/customer: sale\.customerNameSnapshot/);
    expect(replay).not.toMatch(/companySettings|branchReturnPolicy/);
  });
});
