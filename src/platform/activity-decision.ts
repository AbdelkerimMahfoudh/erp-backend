import { activityChange, type ActivityChange, type ActivityPrices } from '../billing/pricing-rules';
import type { Activity } from '../entitlement/activity';

/**
 * What asking for another activity at one branch does (D154, docs/73 §3.2), decided once — so the request itself
 * and the Owner's page that explains it before anything is sent can never disagree. Pure.
 *
 *  - the activity the branch already has, while a change waits for the renewal → **keep**: that change is withdrawn,
 *    free; with nothing scheduled → **unchanged**, refused (`activity_unchanged`);
 *  - a target already asked for → **requested**: the same request answers;
 *  - an upgrade while a paid month runs on an activated subscription → **charge_now**: the difference, at the
 *    chargeable prices (the running period's own) — or **apply_now** when the branch replaced a store archived this
 *    period and its credit covers the dearer fee (D158): nothing to pay, so nothing waits for a payment;
 *  - a downgrade, or an upgrade with no paid month to charge against → **at_renewal**;
 *  - except that an unpaid upgrade blocks any other target, and a scheduled change blocks anything but an upgrade
 *    in force now → **blocked** (`activity_request_pending`).
 */
export type ActivityDecision =
  | { kind: 'keep' }
  | { kind: 'unchanged' }
  | { kind: 'requested'; status: 'pending_payment' | 'granted' }
  | { kind: 'blocked'; by: Activity }
  | { kind: 'charge_now'; change: ActivityChange }
  | { kind: 'apply_now'; change: ActivityChange }
  | { kind: 'at_renewal'; change: ActivityChange };

export interface ActivityDecisionInput {
  from: Activity;
  to: Activity;
  /** The target of an upgrade awaiting payment at this branch, if any. */
  unpaidTo: Activity | null;
  /** The target of a change waiting for the renewal at this branch, if any. */
  scheduledTo: Activity | null;
  /** The prices a change made now is charged at: the running period's own, else today's plan. */
  pricing: ActivityPrices;
  /** A paid month is running. */
  running: boolean;
  /** The subscription is activated. */
  activated: boolean;
  /** What the running period already paid for this branch's location when it replaced an archived store (D158). */
  credit?: number;
}

export function decideActivityChange(i: ActivityDecisionInput): ActivityDecision {
  if (i.from === i.to) return i.scheduledTo ? { kind: 'keep' } : { kind: 'unchanged' };
  if (i.unpaidTo === i.to) return { kind: 'requested', status: 'pending_payment' };
  if (i.scheduledTo === i.to) return { kind: 'requested', status: 'granted' };
  const change = activityChange(i.from, i.to, i.pricing, i.credit ?? 0);
  const payNow = change.kind === 'upgrade' && i.running && i.activated;
  const blocking = i.unpaidTo ?? (payNow ? null : i.scheduledTo);
  if (blocking) return { kind: 'blocked', by: blocking };
  if (!payNow) return { kind: 'at_renewal', change };
  // A request awaiting a payment of nothing would wait for a confirmation nobody needs to give.
  return change.amountNow > 0 ? { kind: 'charge_now', change } : { kind: 'apply_now', change };
}
