/**
 * Time, as a dependency (Milestone K).
 *
 * Every entitlement boundary is a moment: the instant a period ends, the instant
 * 72 hours later. A feature whose boundaries can only be exercised by waiting
 * three days — or worse, by moving the host clock — is a feature nobody tests.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = {
  now: () => new Date(),
};
