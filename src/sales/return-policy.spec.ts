import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  evaluateEligibility,
  MAX_WINDOW_HOURS,
  NO_RETURNS,
  resolveWindowForSale,
  snapshotPolicy,
} from './return-policy';

/**
 * The return policy a sale is sold under (I1).
 *
 * Two guarantees matter more than the rest, and both are about a promise made
 * to a customer who is no longer standing in the shop:
 *
 *  1. The policy is **snapshotted** onto the sale, so changing the company
 *     setting later cannot reach back and alter what was promised.
 *  2. Eligibility is decided by the **server's** clock, never the phone's.
 */

const SOLD_AT = new Date('2026-08-14T10:00:00.000Z');

describe('snapshotting the policy onto a sale', () => {
  it('turns a positive window into a deadline measured from the sale', () => {
    const snap = snapshotPolicy(SOLD_AT, 48);
    expect(snap.windowHours).toBe(48);
    expect(snap.deadlineAt?.toISOString()).toBe('2026-08-16T10:00:00.000Z');
  });

  /**
   * "No returns" and "the deadline has passed" are different facts. Storing a
   * past date for the first would make an expired sale and a no-returns sale
   * indistinguishable, and the screen has to say different things about them.
   */
  it('stores NO deadline for a zero window, rather than a date in the past', () => {
    const snap = snapshotPolicy(SOLD_AT, NO_RETURNS);
    expect(snap.windowHours).toBe(0);
    expect(snap.deadlineAt).toBeNull();
  });

  it('handles the common 24-hour case exactly', () => {
    expect(snapshotPolicy(SOLD_AT, 24).deadlineAt?.toISOString()).toBe('2026-08-15T10:00:00.000Z');
  });

  it('refuses a negative, fractional or absurd window', () => {
    for (const bad of [-1, 1.5, MAX_WINDOW_HOURS + 1]) {
      expect(() => snapshotPolicy(SOLD_AT, bad)).toThrow(BadRequestException);
    }
    expect(() => snapshotPolicy(SOLD_AT, MAX_WINDOW_HOURS)).not.toThrow();
  });
});

describe('who may change the policy at sale time', () => {
  const def = (over: Partial<Parameters<typeof resolveWindowForSale>[0]> = {}) =>
    resolveWindowForSale({ companyDefaultHours: 24, canOverride: false, ...over });

  it('uses the company default when nothing is requested', () => {
    expect(def()).toEqual({ windowHours: 24, overrideReason: null, overridden: false });
  });

  /**
   * Re-stating the default is not an override. An employee's Sell screen sends
   * the policy it displayed, and that must not be read as an attempt to change
   * anything — otherwise every ordinary sale would need a reason.
   */
  it('treats "the same as the default" as no override, needing no authority', () => {
    expect(def({ requested: { windowHours: 24 } })).toEqual({
      windowHours: 24,
      overrideReason: null,
      overridden: false,
    });
  });

  it('refuses an employee who asks for something different, rather than ignoring them', () => {
    // Silently falling back to the default would tell the employee the sale
    // succeeded under a policy it does not have.
    expect(() => def({ requested: { windowHours: 0, reason: 'damaged box' } })).toThrow(ForbiddenException);
  });

  it('lets a manager or owner keep the default, remove it, or extend it', () => {
    const can = { canOverride: true };
    expect(def({ ...can, requested: { windowHours: 24 } }).overridden).toBe(false);
    expect(def({ ...can, requested: { windowHours: 0, reason: 'clearance, sold as seen' } })).toEqual({
      windowHours: 0,
      overrideReason: 'clearance, sold as seen',
      overridden: true,
    });
    expect(def({ ...can, requested: { windowHours: 72, reason: 'regular customer travelling' } })).toEqual({
      windowHours: 72,
      overrideReason: 'regular customer travelling',
      overridden: true,
    });
  });

  /**
   * The rule worth stating plainly: trimming 48 hours to 2 sells a worse
   * promise under the same banner. Removing the window entirely is allowed,
   * because it is explicit and the customer is told at the till.
   */
  it('refuses to quietly SHORTEN a positive default to another positive value', () => {
    expect(() =>
      resolveWindowForSale({
        companyDefaultHours: 48,
        canOverride: true,
        requested: { windowHours: 2, reason: 'nearly out of policy' },
      }),
    ).toThrow(/not quietly shortened/);
  });

  it('but allows removing it entirely, and allows lengthening', () => {
    const base = { companyDefaultHours: 48, canOverride: true };
    expect(resolveWindowForSale({ ...base, requested: { windowHours: 0, reason: 'sold as seen' } }).windowHours).toBe(0);
    expect(resolveWindowForSale({ ...base, requested: { windowHours: 96, reason: 'goodwill' } }).windowHours).toBe(96);
  });

  it('extending from a zero default is not "shortening" and is allowed', () => {
    expect(
      resolveWindowForSale({
        companyDefaultHours: 0,
        canOverride: true,
        requested: { windowHours: 24, reason: 'exception for a regular' },
      }).windowHours,
    ).toBe(24);
  });

  it('demands a reason for any real change', () => {
    for (const reason of [undefined, '', '   ']) {
      expect(() =>
        resolveWindowForSale({ companyDefaultHours: 24, canOverride: true, requested: { windowHours: 0, reason } }),
      ).toThrow(/Say why/);
    }
  });

  it('rejects an out-of-range override even from an owner', () => {
    expect(() =>
      resolveWindowForSale({
        companyDefaultHours: 24,
        canOverride: true,
        requested: { windowHours: MAX_WINDOW_HOURS + 1, reason: 'forever' },
      }),
    ).toThrow(BadRequestException);
  });
});

describe('eligibility, decided by the server clock', () => {
  const deadline = new Date('2026-08-16T10:00:00.000Z');
  const evaluate = (over: Partial<Parameters<typeof evaluateEligibility>[0]> = {}) =>
    evaluateEligibility({ windowHours: 48, deadlineAt: deadline, now: new Date('2026-08-15T10:00:00.000Z'), ...over });

  it('is open inside the window, and reports how long is left', () => {
    const e = evaluate();
    expect(e.eligibleByPolicy).toBe(true);
    expect(e.reason).toBe('within_window');
    expect(e.remainingMs).toBe(24 * 3_600_000);
    expect(e.requiresOwnerException).toBe(false);
  });

  it('is closed once the deadline passes, and only an Owner could rescue it', () => {
    const e = evaluate({ now: new Date('2026-08-16T10:00:00.001Z') });
    expect(e.eligibleByPolicy).toBe(false);
    expect(e.reason).toBe('window_expired');
    expect(e.requiresOwnerException).toBe(true);
    expect(e.remainingMs).toBe(0);
  });

  it('treats the exact deadline instant as closed', () => {
    expect(evaluate({ now: deadline }).reason).toBe('window_expired');
  });

  /**
   * A sale with no policy is NOT "expired" — nothing was ever promised — and
   * the screen must say something different about it.
   */
  it('distinguishes "no policy" from "expired"', () => {
    const e = evaluate({ windowHours: 0, deadlineAt: null });
    expect(e.reason).toBe('no_return_policy');
    expect(e.requiresOwnerException).toBe(true);
    expect(e.deadlineAt).toBeNull();
  });

  it('reports a settled sale and an already-returned line before anything else', () => {
    expect(evaluate({ isReversed: true }).reason).toBe('sale_reversed');
    expect(evaluate({ hasReturn: true }).reason).toBe('already_returned');
    // Neither is rescuable by an Owner: they are finished, not refused.
    expect(evaluate({ isReversed: true }).requiresOwnerException).toBe(false);
    expect(evaluate({ hasReturn: true }).requiresOwnerException).toBe(false);
  });

  it('says accessory-only returns are not supported yet, rather than refusing vaguely', () => {
    expect(evaluate({ quantityOnly: true }).reason).toBe('quantity_not_supported');
  });

  /**
   * The whole point of snapshotting: a company setting changed after the sale
   * cannot reach this calculation, because it takes the sale's own numbers.
   */
  it('reads only the sale’s snapshot, so a later settings change cannot touch it', () => {
    const soldUnder48 = evaluate({ windowHours: 48, deadlineAt: deadline });
    expect(soldUnder48.eligibleByPolicy).toBe(true);
    // The shop switching to "no returns" today changes nothing here, because
    // nothing in this function can see the company setting at all.
    expect(evaluate({ windowHours: 48, deadlineAt: deadline }).deadlineAt).toEqual(deadline);
  });
});
