/**
 * The values the Settings API accepts.
 *
 * Kept in one file because the validator, the service and the tests must agree
 * — a rule enforced in three places drifts, and a security maximum that drifts
 * is a security maximum that is not enforced.
 */

/** No returns at all. Not "unset": the Owner chose not to accept returns. */
export const RETURN_WINDOW_NONE = 0;

/** One year. A window longer than this is a data-entry mistake, not a policy. */
export const RETURN_WINDOW_MAX_HOURS = 8760;

/**
 * Auto-lock choices, in seconds, as a business maximum.
 *
 * `0` means lock immediately. There is deliberately no "never" — the approved
 * decision forbids it (docs/21 §12), and the way to forbid an option is to make
 * it unrepresentable rather than to rely on every future caller remembering.
 */
export const AUTO_LOCK_CHOICES = [0, 30, 60, 300, 900] as const;

export type AutoLockSeconds = (typeof AUTO_LOCK_CHOICES)[number];

export function isAutoLockChoice(value: number): value is AutoLockSeconds {
  return (AUTO_LOCK_CHOICES as readonly number[]).includes(value);
}
