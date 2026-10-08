/**
 * What a branch is subscribed to do (D154, D156; docs/73).
 *
 * Three activities, chosen per branch on the subscription website: the
 * electronics store, the money services agent counter, or both. The type
 * mirrors the `BranchActivity` enum of `prisma/schema.prisma`; every branch
 * that existed before migration 0088 is `electronics`, so nothing a shop could
 * do yesterday changes today.
 *
 * Pure. What each activity COSTS lives in `billing/pricing-rules.ts`; what each
 * activity lets a branch DO lives in `activity-gate.ts`. This file is the one
 * word the two share, so neither can spell it differently.
 */

export type Activity = 'electronics' | 'money_agent' | 'both';

/** Every activity, for validation (`@IsIn`) and for tables that must cover them all. */
export const ACTIVITIES: readonly Activity[] = ['electronics', 'money_agent', 'both'] as const;

export function isActivity(value: unknown): value is Activity {
  return typeof value === 'string' && (ACTIVITIES as readonly string[]).includes(value);
}

/**
 * What a gated route needs: the electronics store, or the agent counter.
 *
 * `both` satisfies either. A need is never `both`: no route needs a branch to
 * be two things at once.
 */
export type ActivityNeed = 'electronics' | 'money_agent';

/**
 * Whether a branch of this activity may do what the route needs.
 *
 * Fails closed on a value that is none of the three — this MySQL server runs
 * with an empty `sql_mode`, so a bad ENUM written outside Prisma is coerced to
 * `''` rather than refused, and `''` must not read as "allowed".
 */
export function activityAllows(activity: Activity, need: ActivityNeed): boolean {
  return activity === 'both' || activity === need;
}

/** The stable code a client keys on when a branch's activity refuses a route (D156). Never parsed English. */
export const ACTIVITY_NOT_SUBSCRIBED = 'activity_not_subscribed';

/** The activity in plain words, for a refusal a person reads. */
export function activityLabel(activity: Activity): string {
  switch (activity) {
    case 'money_agent':
      return 'money services';
    case 'both':
      return 'the electronics store and money services';
    case 'electronics':
      return 'the electronics store';
    default:
      return 'unknown';
  }
}
