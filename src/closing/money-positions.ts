import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { shiftDate } from '../common/business-day';
import { parseMoney } from '../common/money/money';
import { COMPONENT_SIGN, type AccountRow, type MovementRow } from './channels';

/**
 * The money each method holds as this app tracks it (Money's top card, 2026-09-27).
 *
 * A position is an anchor — an amount known to be true at one moment — plus the
 * net of every movement recorded after that moment. It is carried across
 * midnight: nothing resets at the day's boundary, so 3 400 in the drawer and
 * 3 600 in the accounts at night are still 7 000 the next morning when nothing
 * moved.
 *
 * What it never does: invent an opening amount, read a day's net movement as a
 * position, or claim a provider's balance (rule 26a). A method with no anchor is
 * unknown — `position` null, never 0 — and then there is no grand total.
 *
 * - **Cash** is the branch's drawer, anchored by the Daily closing's own counted
 *   close, so Money and the closing cannot disagree about it.
 * - **An account** belongs to the company, anchored by the latest amount the
 *   Owner recorded for it (`money_anchors`), plus its movements at every branch.
 *
 * Pure on purpose: which methods are listed, what each holds and when a total
 * exists are rules, testable without a database.
 */

export type TrackedChannel = 'cash' | 'account';
export type UnknownReason = 'no_counted_close' | 'no_anchor';

export interface TrackedAnchor {
  source: 'counted_close' | 'declared';
  amount: number;
  /** ISO instant; null only for a counted close that recorded neither a count time nor a close time. */
  at: string | null;
  businessDate: string;
  byName: string | null;
}

export interface TrackedMethod {
  /** `cash`, or `account:<uuid>`. */
  key: string;
  channel: TrackedChannel;
  accountId: string | null;
  /** The account's label; '' for cash, which the phone names in its own language. */
  label: string;
  /** The drawer is this branch's; an account is the company's, whichever branch moved it. */
  scope: 'branch' | 'company';
  isActive: boolean;
  known: boolean;
  position: number | null;
  unknownReason: UnknownReason | null;
  anchor: TrackedAnchor | null;
  sinceAnchorNet: number | null;
}

export interface TrackedMoney {
  asOf: string;
  businessDate: string;
  basis: 'anchor_plus_recorded_movement';
  branchCount: number;
  /**
   * Whether the accounts are listed. Their positions are the company's, moved by
   * every branch, so only someone who may record them (the Owner) sees them;
   * anyone else sees this branch's drawer and no total.
   */
  accountsVisible: boolean;
  methods: TrackedMethod[];
  total: number | null;
  unknownKeys: string[];
}

/** A locked close whose drawer was counted — the only close that anchors cash. */
export interface CountedClose {
  closingDate: string;
  countedCash: number;
  /** The drawer count's time, else the close's. */
  at: Date | null;
  /** Who counted, else who closed. */
  byName: string | null;
}

export interface DrawerInputs {
  /** The current business day's close, when it is locked with a counted drawer. */
  countedToday: CountedClose | null;
  /** The close the day's opening is carried from (`openingCashDetail`), or null when no drawer was ever counted. */
  openingAnchor: CountedClose | null;
  /** The drawer's expected figure for the current business day — the overview's `cashNow`. */
  expected: number;
}

/** The latest amount the Owner recorded for an account. */
export interface DeclaredAnchor {
  accountId: string;
  amount: number;
  at: Date;
  businessDate: string;
  byName: string | null;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const countedAnchor = (close: CountedClose): TrackedAnchor => ({
  source: 'counted_close',
  amount: round2(close.countedCash),
  at: close.at ? close.at.toISOString() : null,
  businessDate: close.closingDate,
  byName: close.byName,
});

/**
 * The drawer. A day closed with its drawer counted holds exactly what was
 * counted. Otherwise it holds the closing's own expected figure — the last
 * counted close carried forward by every recorded cash movement since — and
 * only when such a close exists: an attested, not-verified, skipped, counting or
 * reopened day anchors nothing, and a shop that never counted a closed drawer
 * does not know what it holds.
 */
export function cashMethod(input: DrawerInputs): TrackedMethod {
  const base = { key: 'cash', channel: 'cash' as const, accountId: null, label: '', scope: 'branch' as const, isActive: true };
  if (input.countedToday) {
    const anchor = countedAnchor(input.countedToday);
    return { ...base, known: true, position: anchor.amount, unknownReason: null, anchor, sinceAnchorNet: 0 };
  }
  if (!input.openingAnchor) {
    return { ...base, known: false, position: null, unknownReason: 'no_counted_close', anchor: null, sinceAnchorNet: null };
  }
  const anchor = countedAnchor(input.openingAnchor);
  const position = round2(input.expected);
  return { ...base, known: true, position, unknownReason: null, anchor, sinceAnchorNet: round2(position - anchor.amount) };
}

/**
 * Which movements count after an anchor: those whose effective instant is
 * strictly after it. The date bound is only there so the database can use its
 * date indexes — it reaches one day back because another branch may still be on
 * the previous business date (an early start moves one branch's date, not the
 * company's), so a movement after the anchor can carry the day before its date.
 * `day` is the anchor's own business day: a movement dated by day only (a fixed
 * expense's due day) counts when its day is a later one.
 */
export function movementWindow(anchor: Pick<DeclaredAnchor, 'at' | 'businessDate'>): { after: Date; fromDate: string; day: string } {
  return { after: anchor.at, fromDate: shiftDate(anchor.businessDate, -1), day: anchor.businessDate };
}

/**
 * One account: its anchor plus the net of the movements after it, with the
 * closing's own signs. `movements` are that window's sums per component; money
 * that named no account belongs to no method and never arrives here.
 */
export function accountMethod(account: AccountRow, anchor: DeclaredAnchor | null, movements: MovementRow[]): TrackedMethod {
  const base = {
    key: `account:${account.id}`,
    channel: 'account' as const,
    accountId: account.id,
    label: account.label,
    scope: 'company' as const,
    isActive: account.isActive,
  };
  if (!anchor) {
    return { ...base, known: false, position: null, unknownReason: 'no_anchor', anchor: null, sinceAnchorNet: null };
  }
  const net = movements
    .filter((m) => m.channel === 'account' && m.accountId === account.id)
    .reduce((sum, m) => sum + COMPONENT_SIGN[m.component] * m.amount, 0);
  const amount = round2(anchor.amount);
  const position = round2(amount + net);
  return {
    ...base,
    known: true,
    position,
    unknownReason: null,
    anchor: { source: 'declared', amount, at: anchor.at.toISOString(), businessDate: anchor.businessDate, byName: anchor.byName },
    sinceAnchorNet: round2(position - amount),
  };
}

/**
 * The card: cash first, then every active account in the shop's order, then a
 * deactivated account only if an amount was ever recorded for it — its money
 * did not vanish when it was switched off. The total is the sum of exactly the
 * rows listed, each already rounded, and exists only when every one of them is
 * known: a total over an unknown method would be a made-up number.
 */
export function trackedMoney(input: {
  asOf: Date;
  businessDate: string;
  branchCount: number;
  drawer: DrawerInputs;
  accounts: AccountRow[];
  anchors: DeclaredAnchor[];
  movements: MovementRow[];
  /** Deactivated accounts that ever recorded money: they may still hold it, so they are listed. */
  withMovement: ReadonlySet<string>;
  accountsVisible: boolean;
}): TrackedMoney {
  const anchorOf = new Map(input.anchors.map((a) => [a.accountId, a]));
  const byOrder = (a: AccountRow, b: AccountRow) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label);
  // A deactivated account with money recorded and no amount is unknown, never silently left out of a total.
  const listed = input.accountsVisible
    ? [
        ...input.accounts.filter((a) => a.isActive).sort(byOrder),
        ...input.accounts.filter((a) => !a.isActive && (anchorOf.has(a.id) || input.withMovement.has(a.id))).sort(byOrder),
      ]
    : [];
  const methods = [
    cashMethod(input.drawer),
    ...listed.map((a) => accountMethod(a, anchorOf.get(a.id) ?? null, input.movements)),
  ];
  const unknownKeys = methods.filter((m) => !m.known).map((m) => m.key);
  return {
    asOf: input.asOf.toISOString(),
    businessDate: input.businessDate,
    basis: 'anchor_plus_recorded_movement',
    branchCount: input.branchCount,
    accountsVisible: input.accountsVisible,
    methods,
    // Without the accounts the drawer alone is not the money held: no total.
    total: input.accountsVisible && unknownKeys.length === 0 ? round2(methods.reduce((sum, m) => sum + (m.position as number), 0)) : null,
    unknownKeys,
  };
}

// ── Recording an account's amount ─────────────────────────────────────────────

/**
 * What an account holds is never negative here, and it is money: two decimals
 * at most, within the column. Refused with a code the phone can act on.
 */
export function assertAnchorAmount(amount: number): void {
  const parsed = parseMoney(amount);
  if (!parsed.ok || parsed.decimal.isNegative()) {
    throw new BadRequestException({
      code: 'amount_invalid',
      message: 'Enter the amount the account holds: zero or more, with at most two decimals.',
    });
  }
}

/**
 * The payload a request id is bound to. The same id with the same account,
 * amount and note is a retry; with anything else it is a different anchor.
 */
export function anchorFingerprint(input: { accountId: string; amount: number; note?: string | null }): string {
  const canonical = JSON.stringify({
    accountId: input.accountId.toLowerCase(),
    amount: round2(input.amount).toFixed(2),
    note: input.note?.trim() || null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
