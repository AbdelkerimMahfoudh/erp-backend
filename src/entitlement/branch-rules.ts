import { GRACE_MS } from './grace-rules';
import type { OfferMonths } from '../billing/period-offers';

/**
 * A store branch's own entitlement (0132; the owner's brief of 2026-11-06; docs/122). Pure and clock-injected.
 *
 * Each branch is its own subscription: a trial end (the business's first branch only), a paid end, a grant. The
 * business keeps only what is the account's: suspension or refusal by the Super Admin, and closure.
 */
export type BranchState =
  | 'suspended'
  | 'locked'
  | 'complimentary'
  | 'trial_active'
  | 'active'
  | 'grace'
  | 'trial_expired'
  | 'expired';

export interface BranchFacts {
  trialEndsAt: Date | null;
  paidUntil: Date | null;
  complimentary: boolean;
  complimentaryUntil: Date | null;
}

/** The grace recorded (or about to be) for the branch's current paid end: granted until `endsAt`, or refused. */
export interface BranchGrace {
  periodEnd: Date;
  decision: 'granted' | 'refused';
  endsAt: Date;
}

export interface BranchInputs {
  /** No row: a branch never opened by a payment, a trial or a grant. */
  facts: BranchFacts | null;
  /** The business is suspended, refused or closed: every branch stops, whatever it paid. */
  accountStopped: boolean;
  /** The decision for `facts.paidUntil`, when one is recorded. Undecided ends read as granted while it is due (see below). */
  grace: BranchGrace | null;
  /** Granted grace starts in the branch's rolling 12 months before this end — for an end not yet decided. */
  graceUsesBefore?: number;
}

export const BRANCH_GRACE_ALLOWANCE = 3;

/** The state. The first rule that matches decides (docs/122 §3). */
export function branchState(input: BranchInputs, now: Date): BranchState {
  if (input.accountStopped) return 'suspended';
  const f = input.facts;
  if (!f) return 'locked';
  const t = now.getTime();
  if (f.complimentary && (!f.complimentaryUntil || t < f.complimentaryUntil.getTime())) return 'complimentary';
  if (f.trialEndsAt && t < f.trialEndsAt.getTime()) return 'trial_active';
  if (f.paidUntil && t < f.paidUntil.getTime()) return 'active';
  if (f.paidUntil) {
    const end = f.paidUntil.getTime();
    const recorded = input.grace && input.grace.periodEnd.getTime() === end ? input.grace : null;
    const granted = recorded ? recorded.decision === 'granted' : (input.graceUsesBefore ?? 0) < BRANCH_GRACE_ALLOWANCE;
    if (granted && t < end + GRACE_MS) return 'grace';
    return 'expired';
  }
  if (f.trialEndsAt) return 'trial_expired';
  // A grant that ended, and nothing else.
  return 'expired';
}

/** Writes are allowed in these states only. Reads are refused only while the account is stopped or the branch locked. */
export function branchCanWrite(state: BranchState): boolean {
  return state === 'active' || state === 'grace' || state === 'complimentary' || state === 'trial_active';
}

export function branchCanRead(state: BranchState): boolean {
  return state !== 'suspended' && state !== 'locked';
}

/** When a payment's months start for this branch: from its paid end while active or in grace, else at approval (docs/122 §5). */
export function paidPeriodStart(facts: BranchFacts | null, state: BranchState, approvedAt: Date): Date {
  if (!facts) return approvedAt;
  // A first branch paid during its trial goes on from the trial's end: the trial is never shortened.
  if (state === 'trial_active' && facts.trialEndsAt) return later(facts.trialEndsAt, facts.paidUntil);
  if ((state === 'active' || state === 'grace') && facts.paidUntil) return facts.paidUntil;
  // A running grant: the paid months follow it, never overlap it.
  if (state === 'complimentary' && facts.complimentaryUntil) return later(facts.complimentaryUntil, facts.paidUntil);
  return approvedAt;
}

/** Calendar months, UTC, the day clamped to the month's end — as MySQL's `+ INTERVAL n MONTH`. */
export function addMonths(from: Date, months: OfferMonths | number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

function later(a: Date, b: Date | null): Date {
  return b && b.getTime() > a.getTime() ? b : a;
}
