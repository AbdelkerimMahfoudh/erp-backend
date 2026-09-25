/**
 * How a goal is doing (Milestone F).
 *
 * Pure on purpose. "Am I on target" is the whole product value of a goal, and
 * getting it subtly wrong — telling somebody they are behind on the first
 * morning of the month — is worse than not showing it at all.
 *
 * Nothing here is stored. Progress is derived from the rollup every time a goal
 * is read, the same rule the employee debt balance follows: a stored figure can
 * disagree with the sales it claims to summarise, and it would need
 * invalidating on every sale, return, refund and correction.
 */

/**
 * What a goal's state is, in a word.
 *
 * The word is the point. Colour never carries meaning alone, and "you are 62%
 * of the way there" does not tell somebody whether that is good on the 20th of
 * the month.
 */
export type GoalState =
  /** The period has not begun. */
  | 'not_started'
  /** Running, and at or ahead of where the days elapsed would put it. */
  | 'on_track'
  /** Running, and behind that pace. Still reachable. */
  | 'behind'
  /** The target has been reached. Says so even if the period is still running. */
  | 'met'
  /** The period ended short. A different word from `behind`, deliberately. */
  | 'missed';

export interface Progress {
  target: number;
  achieved: number;
  /** Uncapped: 118% is a real and useful thing to know. */
  percent: number;
  /** Never negative — once met, nothing is remaining. */
  remaining: number;
  state: GoalState;
  daysTotal: number;
  daysElapsed: number;
  daysRemaining: number;
  /**
   * Where a steady pace would have put this by now. `null` before the period
   * starts, because pace against zero elapsed days is not a number.
   */
  expectedByNow: number | null;
  /**
   * What is needed per remaining day to still make it. `null` once met, and
   * `null` after the period ends — there is no catching up on a closed month.
   */
  neededPerRemainingDay: number | null;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Whole days between two YYYY-MM-DD keys, inclusive of both ends. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

export interface ProgressInput {
  target: number;
  achieved: number;
  periodStart: string;
  periodEnd: string;
  /** Today, as a YYYY-MM-DD key. Passed in so this stays pure and testable. */
  today: string;
}

export function computeProgress(input: ProgressInput): Progress {
  const { target, achieved, periodStart, periodEnd, today } = input;

  const daysTotal = daysBetween(periodStart, periodEnd);
  const started = today >= periodStart;
  const ended = today > periodEnd;

  /**
   * Today counts as elapsed while the period is running: somebody looking at
   * their target at midday is part-way through today, not finished with it.
   * Once the period ends, every day has elapsed and none remain.
   */
  const daysElapsed = !started ? 0 : ended ? daysTotal : daysBetween(periodStart, today);
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  const percent = target > 0 ? round2((achieved / target) * 100) : 0;
  const remaining = round2(Math.max(0, target - achieved));

  const expectedByNow = !started ? null : round2((target / daysTotal) * daysElapsed);

  let state: GoalState;
  if (achieved >= target) {
    // Checked first, so a target hit early reads as met rather than as ahead of
    // pace. Reaching it is the news.
    state = 'met';
  } else if (!started) {
    state = 'not_started';
  } else if (ended) {
    /**
     * `missed`, not `behind`. Nothing can be done about a closed period, and
     * telling somebody they are "behind" on a month that has ended asks them to
     * catch up on days that no longer exist.
     */
    state = 'missed';
  } else {
    state = achieved >= (expectedByNow as number) ? 'on_track' : 'behind';
  }

  const neededPerRemainingDay =
    state === 'met' || ended || daysRemaining === 0 ? null : round2(remaining / daysRemaining);

  return {
    target: round2(target),
    achieved: round2(achieved),
    percent,
    remaining,
    state,
    daysTotal,
    daysElapsed,
    daysRemaining,
    expectedByNow,
    neededPerRemainingDay,
  };
}

/**
 * What comes off each branch metric in the period, from the rollup's own columns, on the day it
 * was approved — never by rewriting the sale's own period, which its Daily closing has shown:
 *
 *   a cancelled sale (0079; units 0080) — its revenue, its profit, one sale, its units;
 *   a returned item (docs/53 R2) — revenue by its net refund due (gross − adjustments kept),
 *   profit by gross − adjustments − cost credited (`returns_gross_profit`, the rollup's own),
 *   and its unit (docs/54 D37): a return is one identified unit, so `returns_count` is the
 *   units returned.
 *
 * The sales count takes cancellations only: a returned item is not a cancelled invoice (R5).
 */
export const ADJUSTMENT: Readonly<Record<GoalMetricKey, string>> = {
  gross_profit: '(`cancelled_revenue` - `cancelled_cogs`) + `returns_gross_profit`',
  revenue: '`cancelled_revenue` + (`returns_revenue` - `returns_adjustments`)',
  sales_count: '`cancelled_count`',
  units_sold: '`cancelled_qty` + `returns_count`',
};

/**
 * Which rollup column each metric reads.
 *
 * The single mapping, in one place. `daily_rollups` already accounts for
 * returns, so a goal and the day's analytics cannot disagree about the same
 * period — which is the drift Milestone E spent a whole checkpoint pinning shut
 * for the reconciliation equation.
 */
export const METRIC_COLUMN = {
  gross_profit: 'gross_profit',
  revenue: 'revenue',
  sales_count: 'sales_count',
  units_sold: 'qty_sold',
} as const;

export type GoalMetricKey = keyof typeof METRIC_COLUMN;

/** Whether a metric counts money, so a screen knows to format it as such. */
export function isMoneyMetric(metric: GoalMetricKey): boolean {
  return metric === 'gross_profit' || metric === 'revenue';
}
