import { createHash } from 'node:crypto';
import { parseMoney } from '../common/money/money';
import type { TrackedMethod } from './money-positions';

/**
 * The money a shop opens with (docs/63, the user's brief of 2026-09-28) — pure rules.
 *
 * Opening the boutique records a decision about the shop's cash, in the same
 * transaction as the opening itself:
 *
 * - **keep** — the Owner keeps the drawer as the app tracks it. Nothing new is
 *   anchored. Since the user's brief of 2026-10-06 there must be something to
 *   keep: a drawer the records cannot establish is never carried into an open
 *   day as "unknown" — `withDrawerKnown` refuses keep then, and the Owner sets
 *   what is in the drawer, 0 included.
 * - **set** — the Owner says what is in the drawer now. That amount is a
 *   position, never a sale or an expense, and it is true from the decision's
 *   instant: the drawer then holds it plus what the day records after it. A
 *   sale made before the opening is never added twice, and nothing is backdated.
 * - **carried** — somebody else who may open did so. The tracked amounts carry
 *   forward, and the day awaits the Owner's review — they are never presented as
 *   the Owner's or as checked. The Owner's review is its own decision, keep or
 *   set, true from its own instant.
 *
 * The company's receiving accounts are never set by a shop's opening: they carry
 * forward, and changing one is the Owner's separate, company-wide action
 * (`POST /money/anchors`). The decision only records what each one showed.
 */

export type OpeningChoice = 'keep' | 'set';
export type OpeningDecisionValue = OpeningChoice | 'carried';

export interface OpeningMoneyInput {
  clientUuid?: string;
  decision?: OpeningChoice;
  cashAmount?: number | null;
}

export type OpeningVerdict =
  | { ok: true; decision: 'keep' | 'carried'; cashAmount: null }
  | { ok: true; decision: 'set'; cashAmount: number }
  | {
      ok: false;
      status: 400 | 403;
      code: 'opening_amounts_required' | 'opening_amounts_owner_only' | 'amount_invalid' | 'amount_not_expected' | 'opening_cash_unknown';
    };

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Zero or more, at most two decimals, within the column — the rule every amount of money here follows. */
export function isValidCashAmount(amount: unknown): amount is number {
  if (typeof amount !== 'number') return false;
  const parsed = parseMoney(amount);
  return parsed.ok && !parsed.decimal.isNegative();
}

/**
 * What an opening decides, for the person opening. The Owner (who may record
 * money positions) must choose, explicitly — nothing is kept or zeroed on their
 * behalf. Anybody else opens with the tracked amounts, awaiting the Owner's
 * review; setting an amount is not theirs to do.
 */
export function openingDecisionFor(input: OpeningMoneyInput | undefined, isOwner: boolean): OpeningVerdict {
  const decision = input?.decision;
  const amount = input?.cashAmount;
  if (!isOwner) {
    if (decision === 'set') return { ok: false, status: 403, code: 'opening_amounts_owner_only' };
    return { ok: true, decision: 'carried', cashAmount: null };
  }
  if (decision === 'keep') {
    if (amount !== undefined && amount !== null) return { ok: false, status: 400, code: 'amount_not_expected' };
    return { ok: true, decision: 'keep', cashAmount: null };
  }
  if (decision === 'set') {
    if (!isValidCashAmount(amount)) return { ok: false, status: 400, code: 'amount_invalid' };
    return { ok: true, decision: 'set', cashAmount: round2(amount) };
  }
  return { ok: false, status: 400, code: 'opening_amounts_required' };
}

/** The Owner's review of a carried opening: the same two choices, always explicit. */
export function reviewDecisionFor(input: OpeningMoneyInput | undefined): OpeningVerdict {
  return openingDecisionFor(input, true);
}

/**
 * Keep needs something to keep (the user's brief of 2026-10-06). While the
 * drawer's amount is unknown — no counted close, no earlier amount — keeping it
 * would open the boutique on a figure nobody has, for the whole day. The Owner
 * sets the cash instead, 0 included when the drawer is empty. A decision that
 * sets an amount, or carries the drawer for the Owner's review, passes through.
 */
export function withDrawerKnown(verdict: OpeningVerdict, drawerKnown: boolean): OpeningVerdict {
  if (verdict.ok && verdict.decision === 'keep' && !drawerKnown) return { ok: false, status: 400, code: 'opening_cash_unknown' };
  return verdict;
}

/**
 * What the Owner may review on the current day (docs/63 §4.3, widened by the
 * brief of 2026-10-06): the day's opening when it was carried by somebody else,
 * or when it left the drawer unknown — the Owner's own keep from before the rule
 * above, or a carried unknown drawer; or, when no decision was recorded at all
 * (an older phone opened the day) while the day is open and the drawer unknown,
 * the day itself. Reviewed once; a known amount the Owner decided is not revised here.
 */
export function reviewableOpening(
  opening: { decision: OpeningDecisionValue; cashKnown: boolean; reviewed: boolean } | null,
  day: { opened: boolean; drawerKnown: boolean },
): 'opening' | 'day' | null {
  if (opening) {
    if (opening.reviewed) return null;
    return opening.decision === 'carried' || !opening.cashKnown ? 'opening' : null;
  }
  return day.opened && !day.drawerKnown ? 'day' : null;
}

/**
 * The payload a request key is bound to. The same key with the same request is a
 * retry and answers with what was recorded; with anything else it is refused. An
 * opening and a reopen share one kind: an older phone's reopen of a day nobody
 * opened is answered as the opening, and its retry must find it either way.
 */
export function openingFingerprint(input: {
  op: 'opening' | 'review';
  date: string | null;
  mode: string | null;
  decision: OpeningDecisionValue;
  cashAmount: number | null;
}): string {
  const canonical = JSON.stringify({
    op: input.op,
    date: input.date,
    mode: input.mode,
    decision: input.decision,
    cashAmount: input.cashAmount === null ? null : round2(input.cashAmount).toFixed(2),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** A set amount as the drawer's rules need it. */
export interface CashSet {
  amount: number;
  /** The business day's recorded net cash movement at the decision's instant. */
  dayNetAt: number;
}

/**
 * The term a set amount adds to its own day's cash equation. With it, the day's
 * expected cash — opening + the day's net + this — comes to the set amount plus
 * what the day recorded after the decision; the opening cancels out, so the
 * figure never depends on what the day had been carried from.
 */
export function setAdjustment(set: CashSet, opening: number): number {
  return round2(set.amount - set.dayNetAt - opening);
}

/**
 * The drawer at the start of a later day, carried from a set amount: the amount,
 * plus what its own day recorded after it, plus every whole day between.
 * `netsFromSetDay` is the recorded net cash movement from the set amount's day
 * through the day before the one being opened.
 */
export function openingFromSet(set: CashSet, netsFromSetDay: number): number {
  return round2(set.amount - set.dayNetAt + netsFromSetDay);
}

/** One method as the person saw it when the opening was confirmed. */
export interface OpeningMethodRecord {
  key: string;
  channel: 'cash' | 'account';
  accountId: string | null;
  label: string;
  scope: 'branch' | 'company';
  previous: number | null;
  amount: number | null;
  set: boolean;
}

/**
 * The record of every method at the opening, and the total shown before
 * confirming. Cash takes the decision; every account carries its tracked
 * position. The total exists only when every method is known.
 */
export function openingMethods(
  methods: readonly Pick<TrackedMethod, 'key' | 'channel' | 'accountId' | 'label' | 'scope' | 'position'>[],
  cash: { decision: OpeningDecisionValue; amount: number | null },
): { methods: OpeningMethodRecord[]; total: number | null } {
  const records = methods.map((m): OpeningMethodRecord => {
    const previous = m.position === null ? null : round2(m.position);
    if (m.channel === 'cash') {
      const set = cash.decision === 'set';
      return { key: m.key, channel: 'cash', accountId: null, label: m.label, scope: 'branch', previous, amount: set ? cash.amount : previous, set };
    }
    return { key: m.key, channel: 'account', accountId: m.accountId, label: m.label, scope: 'company', previous, amount: previous, set: false };
  });
  const total = records.every((r) => r.amount !== null) ? round2(records.reduce((sum, r) => sum + (r.amount as number), 0)) : null;
  return { methods: records, total };
}

export type OpeningState = 'none' | 'owner_decided' | 'awaiting_owner_review' | 'reviewed';

/**
 * Where the current day's opening stands: not recorded with its money (an
 * opening before 0083, or none yet), decided by the Owner, awaiting the Owner's
 * review, or reviewed.
 */
export function openingStateOf(latest: { decision: OpeningDecisionValue; reviewed: boolean } | null): OpeningState {
  if (!latest) return 'none';
  if (latest.decision !== 'carried') return 'owner_decided';
  return latest.reviewed ? 'reviewed' : 'awaiting_owner_review';
}
