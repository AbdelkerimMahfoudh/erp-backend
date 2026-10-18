/**
 * Limited grace after a paid period (0099; the owner's brief of 2026-10-18; docs/101).
 *
 * Until 0099 every paid period that ended was followed by exactly 72 hours of grace, derived from the period's end.
 * The brief keeps the 72 hours and limits them: a company receives at most three grace activations in any rolling
 * 12 months, an activation is consumed the moment it starts (renewing five minutes later gives nothing back), and the
 * fourth paid expiry inside the window receives none. A free trial's end never receives grace (`stateOf` never asks).
 *
 * So each paid period end gets ONE decision — granted or refused — recorded once in `grace_episodes` and never
 * changed. These rules decide it and read it. They are pure and clock-injected, like the entitlement rules they feed.
 *
 * **The window.** An activation at instant T counts the granted activations that started after T minus 12 calendar
 * months, by UTC calendar arithmetic with the day clamped to the month's end — exactly MySQL's
 * `T - INTERVAL 12 MONTH` (the migration's CHECK holds the application to it). Activations that started after T count
 * too: they can exist only if a period end was moved back into the past, and counting them is what keeps an edited
 * expiry from earning a fourth activation. In normal, forward time there are none, and the rule is the plain rolling
 * window.
 *
 * **Company-wide.** The subscription is one per company, with one timeline for every store (D133, D135): every store
 * expires together at the company's period end, so one expiry is one decision, and the allowance belongs to the
 * company — never to a store, a plan, a person or an employee.
 */

/** Exactly 72 hours, from the paid period's end. */
export const GRACE_HOURS = 72;
export const GRACE_MS = GRACE_HOURS * 60 * 60 * 1000;
/** Granted activations allowed in any rolling window. */
export const GRACE_ALLOWANCE = 3;
/** The rolling window, in calendar months. */
export const GRACE_WINDOW_MONTHS = 12;

export type GraceDecision = 'granted' | 'refused';

/** One period end's recorded decision (`grace_episodes`). */
export interface RecordedGrace {
  periodEnd: Date;
  decision: GraceDecision;
  startedAt: Date;
  endsAt: Date;
}

/**
 * What the entitlement reads about grace on every evaluation: the decision recorded for the current period end, and
 * the granted activations counted against it — so a period end not recorded yet is decided exactly as it will be.
 */
export interface GraceFacts {
  /** The decision recorded for the subscription's current period end; null when none is recorded (yet). */
  recorded: RecordedGrace | null;
  /** Granted activations counted against the current period end: started after its window start, its own excluded. */
  usesBefore: number;
  /**
   * The starts of the company's granted activations of the last 12 months and later, oldest first — read by the full
   * evaluation for display (uses in the window, when one returns), never by the write gate. Absent: not read.
   */
  recentStarts?: Date[];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * `at` moved by whole calendar months in UTC, the day clamped to the target month's last day — MySQL's
 * `DATE_ADD`/`DATE_SUB` with `INTERVAL n MONTH` (29 Feb minus 12 months is 28 Feb). The time of day is kept.
 */
export function shiftMonths(at: Date, months: number): Date {
  const total = at.getUTCFullYear() * 12 + at.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(at.getUTCDate(), daysInMonth(year, month));
  return new Date(
    Date.UTC(year, month, day, at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds()),
  );
}

/** The start of the window an activation at `at` is counted in: 12 calendar months earlier, exclusive. */
export function graceWindowStart(at: Date): Date {
  return shiftMonths(at, -GRACE_WINDOW_MONTHS);
}

/** Granted with fewer than three activations counted against it; refused otherwise. */
export function decideGrace(usesBefore: number): GraceDecision {
  return usesBefore < GRACE_ALLOWANCE ? 'granted' : 'refused';
}

/** A decision's span: a granted one runs exactly 72 hours from the period end; a refused one starts and ends there. */
export function graceSpan(periodEnd: Date, decision: GraceDecision): { startedAt: Date; endsAt: Date } {
  return {
    startedAt: periodEnd,
    endsAt: decision === 'granted' ? new Date(periodEnd.getTime() + GRACE_MS) : periodEnd,
  };
}

/** The subscription facts that decide whether a paid period end receives a decision at all. */
export interface GraceSubject {
  status?: string;
  currentPeriodEnd: Date | null;
  isComplimentary: boolean;
  complimentaryUntil: Date | null;
}

/**
 * Whether the platform's grant covered the paid period's end: then nothing lapsed at that instant, no grace was
 * needed, and none is decided. A grant that outlasts the paid period ends into `expired` with no grace — a grant is
 * not a paid subscription (docs/101 §3).
 */
export function grantCovers(sub: GraceSubject, at: Date): boolean {
  return sub.isComplimentary && sub.complimentaryUntil !== null && sub.complimentaryUntil.getTime() > at.getTime();
}

/**
 * Whether the current paid period end is owed a decision at `now`: a paid relationship — `activated`, or `suspended`
 * (a suspension blocks; it stops no clock, exactly as it stops no trial's) — whose period end has passed, with no
 * grant covering it. Cancelled, refused and pending businesses never receive one.
 */
export function graceDue(sub: GraceSubject, now: Date): boolean {
  const status = sub.status ?? 'activated';
  if (status !== 'activated' && status !== 'suspended') return false;
  const end = sub.currentPeriodEnd;
  if (!end || end.getTime() > now.getTime()) return false;
  return !grantCovers(sub, end);
}

/** The grace that follows a paid period end, as the server decides it: granted until `endsAt`, or none. */
export interface PeriodGrace {
  decision: GraceDecision;
  startedAt: Date;
  endsAt: Date;
  /** Whether the decision is the recorded one, rather than computed for a period end not recorded yet. */
  recorded: boolean;
}

/**
 * The grace decision for the subscription's current period end — whether or not it has passed — or null when no
 * decision applies: no paid period end, or a grant covering it.
 *
 *  - the recorded decision, when there is one for this period end;
 *  - otherwise the decision the rules make from the activations counted against it — exactly what will be recorded,
 *    because every earlier period end was recorded before the period could move (the lifecycle records it first).
 *
 * `facts` absent is a caller written before 0099 (the console's tallies, older specs): it reads as an activation still
 * available, which is what every paid expiry received before the limit.
 */
export function periodGraceOf(sub: GraceSubject, facts: GraceFacts | null | undefined): PeriodGrace | null {
  const end = sub.currentPeriodEnd;
  if (!end) return null;
  const recorded = facts?.recorded ?? null;
  if (recorded && recorded.periodEnd.getTime() === end.getTime()) {
    return { decision: recorded.decision, startedAt: recorded.startedAt, endsAt: recorded.endsAt, recorded: true };
  }
  if (grantCovers(sub, end)) return null;
  const decision = decideGrace(facts?.usesBefore ?? 0);
  return { ...graceSpan(end, decision), decision, recorded: false };
}

/** Whether grace is running at `now`: a granted decision for a period end that has passed, before its end. */
export function graceRunning(grace: PeriodGrace | null, now: Date): boolean {
  return (
    grace !== null &&
    grace.decision === 'granted' &&
    grace.startedAt.getTime() <= now.getTime() &&
    now.getTime() < grace.endsAt.getTime()
  );
}

/** Granted activations counted in the window ending at `now`. */
export function usesInWindow(starts: readonly Date[], now: Date): number {
  const from = graceWindowStart(now).getTime();
  return starts.filter((s) => s.getTime() > from && s.getTime() <= now.getTime()).length;
}

/**
 * When an activation that started at `start` stops counting: the first instant whose window start is at or after it.
 * Twelve calendar months later — except after a 29 February, where the clamped month arithmetic keeps it counted
 * until 1 March 00:00 the next year.
 */
export function useRestoredAt(start: Date): Date {
  const candidate = shiftMonths(start, GRACE_WINDOW_MONTHS);
  if (graceWindowStart(candidate).getTime() >= start.getTime()) return candidate;
  return new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate() + 1));
}

/** The grace as every client is told it, on the entitlement. Rendered, never recomputed. */
export interface GraceView {
  /**
   * `none` — no paid period has ended into a decision (active, never paid, covered by a grant, trial, pending);
   * `active` — 72 hours of grace are running; `ended` — they ran out; `unavailable` — the period ended with the
   * company's three activations in 12 months already used.
   */
  status: 'none' | 'active' | 'ended' | 'unavailable';
  /** UTC ISO; set for `active` and `ended` (the period end), and for `unavailable` (when it ended). */
  startedAt: string | null;
  /** UTC ISO; the grace's own end, for `active` and `ended`. */
  endsAt: string | null;
  /** Whole hours left, rounded up, while `active`; 0 otherwise. */
  hoursRemaining: number;
  /**
   * While a paid period runs: whether its end, passing unrenewed, would start 72 hours of grace — decided by the
   * server from the company's history, never by a client. Null when no paid period runs.
   */
  availableAtPeriodEnd: boolean | null;
  allowance: typeof GRACE_ALLOWANCE;
  windowMonths: typeof GRACE_WINDOW_MONTHS;
  durationHours: typeof GRACE_HOURS;
  /** Granted activations in the 12 months before now. Null when the evaluation did not read the history. */
  usesInWindow: number | null;
  /** The allowance minus those, never below zero. Null when the history was not read. */
  usesRemaining: number | null;
  /** When the oldest activation in the window stops counting; null when none counts or the history was not read. */
  nextUseRestoredAt: string | null;
}

/** The view, from the period's decision, the state and the history read with it. */
export function graceViewOf(sub: GraceSubject, facts: GraceFacts | null | undefined, now: Date, paidRunning: boolean): GraceView {
  const grace = periodGraceOf(sub, facts);
  const end = sub.currentPeriodEnd;
  const passed = end !== null && end.getTime() <= now.getTime();
  const starts = facts?.recentStarts;
  const used = starts ? usesInWindow(starts, now) : null;
  const counted = starts ? starts.filter((s) => s.getTime() > graceWindowStart(now).getTime() && s.getTime() <= now.getTime()) : [];
  const oldest = counted.length > 0 ? counted.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b)) : null;
  const base = {
    allowance: GRACE_ALLOWANCE,
    windowMonths: GRACE_WINDOW_MONTHS,
    durationHours: GRACE_HOURS,
    usesInWindow: used,
    usesRemaining: used === null ? null : Math.max(0, GRACE_ALLOWANCE - used),
    nextUseRestoredAt: oldest ? useRestoredAt(oldest).toISOString() : null,
  } as const;

  if (!grace || !passed) {
    return {
      ...base,
      status: 'none',
      startedAt: null,
      endsAt: null,
      hoursRemaining: 0,
      availableAtPeriodEnd: paidRunning && grace ? grace.decision === 'granted' : paidRunning ? false : null,
    };
  }
  if (grace.decision === 'refused') {
    return { ...base, status: 'unavailable', startedAt: grace.startedAt.toISOString(), endsAt: null, hoursRemaining: 0, availableAtPeriodEnd: null };
  }
  const running = graceRunning(grace, now);
  return {
    ...base,
    status: running ? 'active' : 'ended',
    startedAt: grace.startedAt.toISOString(),
    endsAt: grace.endsAt.toISOString(),
    hoursRemaining: running ? Math.max(0, Math.ceil((grace.endsAt.getTime() - now.getTime()) / 3_600_000)) : 0,
    availableAtPeriodEnd: null,
  };
}
