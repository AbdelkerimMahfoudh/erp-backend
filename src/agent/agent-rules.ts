import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { parsePayerNumber } from '../sales/payer-number';

/**
 * The rules of the agent ledger (docs/73 §4, D154, D164): the commission an
 * employee types for an exchange, the legs an exchange moves between the drawer
 * and the provider's float, the counter-legs of a reversal, when a rebalancing
 * balances, what a float holds, and the customer number.
 *
 * D164 (the owner, 2026-10-12) supersedes the configured rate of D154 and
 * docs/73 §4.2: there is no rate. The customer pays the commission to the
 * operator, the employee types it for every exchange, it is the business's
 * revenue — in the drawer — and it never touches the provider's credit.
 * Exchanges recorded under the rate keep exactly what they stored
 * (`commission_source = legacy_rate`); nothing here recomputes them.
 *
 * Pure on purpose, like `channels.ts` and `money-positions.ts`: every figure a
 * transaction records is computed here from its inputs, so the accounting can
 * be checked without a database — and nothing here guesses.
 */

export type AgentDirection = 'cash_in_credit_out' | 'cash_out_credit_in';
export type CommissionDestination = 'cash' | 'provider_float' | 'held_separately';
export type PrincipalFeeMode = 'separate' | 'deducted';
export type ReferenceRule = 'required' | 'optional' | 'none';
export type CommissionSource = 'manual' | 'legacy_rate';
export type LegAccount = 'cash' | 'provider' | 'commission_held' | 'external';
export type LegDirection = 'inflow' | 'outflow';
export type LegKind = 'principal' | 'commission' | 'reversal' | 'rebalancing';
export type ExternalCounterparty = 'owner_capital' | 'provider_settlement' | 'other';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * A provider's configuration version as it is stored. Since D164 the only field a new version sets is
 * `referenceRule`; the rates, the destination and the fee mode remain on the versions written before it, read back
 * for history only — never to price an exchange.
 */
export interface ProviderConfig {
  rateInBp: number | null;
  rateOutBp: number | null;
  sameRateBothDirections: boolean;
  commissionDestination: CommissionDestination | null;
  principalFeeMode: PrincipalFeeMode | null;
  referenceRule: ReferenceRule | null;
}

/**
 * The provider's reference rule in force. A provider with no version, or one that left it blank, takes a reference
 * when one is given and asks for none: a provider is usable as soon as it is switched on (D164).
 */
export function referenceRuleOf(config: Pick<ProviderConfig, 'referenceRule'> | null | undefined): ReferenceRule {
  return config?.referenceRule ?? 'optional';
}

// ── The commission, typed for every exchange (D164) ─────────────────────────

export type CommissionRefusal = 'commission_required' | 'commission_invalid' | 'commission_exceeds_amount';

/**
 * The commission the employee typed, refused when it is not one: absent (an empty field is never zero — the employee
 * types 0), not a whole MRU amount, below zero, or — giving cash — more than the amount, which would hand the
 * customer a negative sum. Receiving cash has no ceiling: the customer pays it on top of the amount.
 */
export function commissionRefusal(direction: AgentDirection, amount: number, commission: unknown): CommissionRefusal | null {
  if (commission === undefined || commission === null || commission === '') return 'commission_required';
  if (typeof commission !== 'number' || !Number.isInteger(commission) || commission < 0) return 'commission_invalid';
  if (direction === 'cash_out_credit_in' && commission > amount) return 'commission_exceeds_amount';
  return null;
}

export const COMMISSION_REFUSAL_MESSAGES: Record<CommissionRefusal, string> = {
  commission_required: 'Enter the commission the customer pays for this exchange; type 0 when there is none. Nothing was recorded.',
  commission_invalid: 'The commission is a whole number of MRU, zero or more. Nothing was recorded.',
  commission_exceeds_amount: 'The commission cannot be more than the amount: the customer would be handed a negative sum. Nothing was recorded.',
};

/**
 * What one exchange does, as the review shows it before it is confirmed: receiving cash, the customer hands over the
 * amount plus the commission and the credit sent is the amount; giving cash, the credit received is the amount and
 * the customer is handed the amount less the commission. The commission is the business's revenue either way.
 */
export function exchangeEffects(direction: AgentDirection, amount: number, commission: number): { cash: number; credit: number; commission: number } {
  const a = round2(amount);
  const c = round2(commission);
  return { cash: direction === 'cash_in_credit_out' ? round2(a + c) : round2(a - c), credit: a, commission: c };
}

// ── Legs ────────────────────────────────────────────────────────────────────

export interface Leg {
  account: LegAccount;
  /** The provider whose float or held commission moved; null for the drawer and the outside world. */
  providerId: string | null;
  direction: LegDirection;
  amount: number;
  kind: LegKind;
}

export interface ExchangeInput {
  direction: AgentDirection;
  amount: number;
  /** The commission the employee typed (D164), in whole MRU. */
  commission: number;
  providerId: string;
}

/**
 * The legs an exchange posts at completion (D164, docs/73 §4.3). Receive cash / Send credit (amount A, commission
 * C): cash in A — the drawer's `agentIn` — the float out A, and the commission in C on the drawer: the drawer gains
 * A + C. Give cash / Receive credit: cash out A — the drawer's `agentOut` — the float in A, and the commission in C on
 * the drawer: the drawer hands over A − C. The float moves by the amount only; the commission is only ever cash. A
 * leg of zero moves nothing and is not written. An exchange recorded under the rate keeps the legs it wrote; they are
 * never recomputed here.
 */
export function exchangeLegs(input: ExchangeInput): Leg[] {
  const amount = round2(input.amount);
  const commission = round2(input.commission);
  const cashIn = input.direction === 'cash_in_credit_out';
  const legs: Leg[] = [
    { account: 'cash', providerId: null, direction: cashIn ? 'inflow' : 'outflow', amount, kind: 'principal' },
    { account: 'provider', providerId: input.providerId, direction: cashIn ? 'outflow' : 'inflow', amount, kind: 'principal' },
    { account: 'cash', providerId: null, direction: 'inflow', amount: commission, kind: 'commission' },
  ];
  return legs.filter((leg) => leg.amount !== 0);
}

/**
 * A reversal counters every leg exactly once (A7): the same account, the same
 * amount, the opposite direction, on the day of the reversal. The original legs
 * stay; nothing is edited or deleted.
 */
export function reversalLegs(legs: readonly Pick<Leg, 'account' | 'providerId' | 'direction' | 'amount'>[]): Leg[] {
  return legs.map((leg) => ({
    account: leg.account,
    providerId: leg.providerId,
    direction: leg.direction === 'inflow' ? 'outflow' : 'inflow',
    amount: leg.amount,
    kind: 'reversal',
  }));
}

// ── Rebalancing ─────────────────────────────────────────────────────────────

export interface RebalancingLegInput {
  account: 'cash' | 'provider' | 'commission_held';
  providerId?: string | null;
  direction: LegDirection;
  amount: number;
}

export interface RebalancingInput {
  legs: RebalancingLegInput[];
  externalCounterparty?: ExternalCounterparty | null;
  /** Signed: positive when money came in from outside, negative when it went out. */
  externalAmount?: number | null;
}

export type RebalancingVerdict =
  | { ok: true; legs: Leg[]; net: number }
  | { ok: false; code: 'rebalancing_legs_required' | 'rebalancing_leg_invalid' | 'rebalancing_unbalanced'; message: string };

/**
 * A rebalancing moves money between the branch's own accounts, or brings it in
 * from (or sends it out to) the outside world (A8, docs/73 §4.3). Its legs net
 * to zero — what left one account reached another — unless an outside party is
 * named for exactly the difference: positive when the Owner brought cash in or
 * a provider settled, negative when money went out. That difference is written
 * as a leg on the `external` account, so every rebalancing's legs sum to zero
 * and a position can never gain money from nowhere.
 */
export function rebalancingLegs(input: RebalancingInput): RebalancingVerdict {
  if (input.legs.length === 0) return { ok: false, code: 'rebalancing_legs_required', message: 'A rebalancing moves at least one amount.' };
  for (const leg of input.legs) {
    if (!(leg.amount > 0) || round2(leg.amount) !== leg.amount) {
      return { ok: false, code: 'rebalancing_leg_invalid', message: 'Each leg moves an amount above zero, with at most two decimals.' };
    }
    if (leg.account === 'cash' && leg.providerId) return { ok: false, code: 'rebalancing_leg_invalid', message: 'The drawer belongs to no provider.' };
    if (leg.account !== 'cash' && !leg.providerId) return { ok: false, code: 'rebalancing_leg_invalid', message: 'A float or held commission names its provider.' };
  }
  const inflows = round2(input.legs.filter((l) => l.direction === 'inflow').reduce((n, l) => n + l.amount, 0));
  const outflows = round2(input.legs.filter((l) => l.direction === 'outflow').reduce((n, l) => n + l.amount, 0));
  const net = round2(inflows - outflows);
  const legs: Leg[] = input.legs.map((l) => ({ account: l.account, providerId: l.account === 'cash' ? null : (l.providerId as string), direction: l.direction, amount: round2(l.amount), kind: 'rebalancing' }));
  if (!input.externalCounterparty) {
    if (net !== 0) {
      return { ok: false, code: 'rebalancing_unbalanced', message: 'The legs do not balance: name where the difference came from or went to, for exactly that amount.' };
    }
    return { ok: true, legs, net };
  }
  if (input.externalAmount == null || net === 0 || round2(input.externalAmount) !== net) {
    return { ok: false, code: 'rebalancing_unbalanced', message: 'An outside party is named for exactly the difference between what came in and what went out.' };
  }
  // Money that came in from outside left the outside world, and the other way round.
  legs.push({ account: 'external', providerId: null, direction: net > 0 ? 'outflow' : 'inflow', amount: Math.abs(net), kind: 'rebalancing' });
  return { ok: true, legs, net };
}

// ── Positions ───────────────────────────────────────────────────────────────

export interface FloatAnchor {
  amount: number;
  /** The instant the amount was true — the server's clock, never typed. */
  at: Date;
  businessDate: string;
  byName: string | null;
  source: 'set' | 'confirmed' | 'counted_close';
  /** A close's anchor (`counted_close`): what the app tracked when that count was taken — the figure it was held against. */
  trackedBefore?: number | null;
}

export interface LegSums {
  inflows: number;
  outflows: number;
}

/** The legs that count from an anchor: strictly after its instant, and — for a figure as of a moment — not after it. */
export function sumLegs(legs: readonly { direction: LegDirection; amount: number; recordedAt: Date }[], after: Date | null, upTo: Date | null = null): LegSums {
  let inflows = 0;
  let outflows = 0;
  for (const leg of legs) {
    if (after && leg.recordedAt.getTime() <= after.getTime()) continue;
    if (upTo && leg.recordedAt.getTime() > upTo.getTime()) continue;
    if (leg.direction === 'inflow') inflows += leg.amount;
    else outflows += leg.amount;
  }
  return { inflows: round2(inflows), outflows: round2(outflows) };
}

export interface FloatPosition {
  known: boolean;
  position: number | null;
  unknownReason: 'no_anchor' | null;
  sinceAnchorNet: number | null;
}

/**
 * What a float holds: the latest anchor plus the net of the legs after its
 * instant (D89's rule, docs/73 §4.4). No anchor is unknown — null, never 0 —
 * and a negative figure is shown as negative: more recorded out than in.
 */
export function floatPosition(anchor: Pick<FloatAnchor, 'amount'> | null, sinceAnchor: LegSums): FloatPosition {
  if (!anchor) return { known: false, position: null, unknownReason: 'no_anchor', sinceAnchorNet: null };
  const sinceAnchorNet = round2(sinceAnchor.inflows - sinceAnchor.outflows);
  return { known: true, position: round2(round2(anchor.amount) + sinceAnchorNet), unknownReason: null, sinceAnchorNet };
}

export interface DayMovement {
  businessDate: string;
  inflows: number;
  outflows: number;
  net: number;
}

/** The business day's movement, beside the position whatever it is (D152's shape). */
export function dayMovementOf(businessDate: string, day: LegSums): DayMovement {
  const inflows = round2(day.inflows);
  const outflows = round2(day.outflows);
  return { businessDate, inflows, outflows, net: round2(inflows - outflows) };
}

/** A float is set to what it holds: zero or more, to the cent, within the column. */
export function assertFloatAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0 || round2(amount) !== amount) {
    throw new BadRequestException({ code: 'amount_invalid', message: 'Enter the amount the float holds: zero or more, with at most two decimals.' });
  }
}

// ── The customer number ─────────────────────────────────────────────────────

/** A Mauritanian number: exactly eight digits — never seven, never nine (D162). */
export const CUSTOMER_NUMBER_DIGITS = 8;

export type ParsedCustomerNumber =
  | { ok: true; value: string; last4: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'too_short' | 'too_long' };

/**
 * The customer number (A6, docs/73 §4.6; D162): read as the payer number is —
 * Arabic-Indic digits read as the same digits, spaces and hyphens dropped — but
 * mandatory, and exactly eight digits with no `+` or country code: a Mauritanian
 * number, as the customer says it. The sale's payer number keeps its open
 * format (D151). The last four digits are kept apart for the masked list and search.
 */
export function parseCustomerNumber(raw: string | null | undefined): ParsedCustomerNumber {
  const parsed = parsePayerNumber(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.value === null) return { ok: false, reason: 'missing' };
  const digits = parsed.value;
  if (digits.startsWith('+')) return { ok: false, reason: 'invalid' };
  if (digits.length < CUSTOMER_NUMBER_DIGITS) return { ok: false, reason: 'too_short' };
  if (digits.length > CUSTOMER_NUMBER_DIGITS) return { ok: false, reason: 'too_long' };
  return { ok: true, value: digits, last4: digits.slice(-4) };
}

/** The number as it is stored, or the refusal — which names the problem, never the number (it reaches the log). */
export function customerNumberFor(raw: string | null | undefined): { value: string; last4: string } {
  const parsed = parseCustomerNumber(raw);
  if (parsed.ok) return { value: parsed.value, last4: parsed.last4 };
  const message = {
    missing: 'The customer number is required.',
    invalid: `A customer number is ${CUSTOMER_NUMBER_DIGITS} digits, with no + and no country code`,
    too_short: `A customer number has exactly ${CUSTOMER_NUMBER_DIGITS} digits; this one has fewer`,
    too_long: `A customer number has exactly ${CUSTOMER_NUMBER_DIGITS} digits; this one has more`,
  }[parsed.reason];
  throw new BadRequestException({ code: 'customer_number_invalid', message });
}

/** What every list, search and report shows of a number: its last four digits. */
export function maskedCustomerNumber(last4: string): string {
  return `•••• ${last4}`;
}

// ── Request keys (A10): the payload a client key is bound to ────────────────

const fingerprint = (canonical: unknown): string => createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
const money = (n: number): string => round2(n).toFixed(2);
const text = (s: string | null | undefined): string | null => s?.trim() || null;

/**
 * The same key with the same exchange is a retry; with anything else it is a
 * second exchange wearing the first one's identity, refused as a conflict
 * (D164): the commission the employee typed is part of the exchange, so the
 * same key with another commission is a conflict. The number is bound in its
 * normalised form, so a retry spaced differently is still the same exchange;
 * the phone's own time is part of its claim. Versioned (`v: 2`), so it can
 * never collide with an exchange recorded under the rate.
 */
export function manualExchangeFingerprint(input: {
  providerId: string;
  direction: AgentDirection;
  amount: number;
  commissionAmount: number;
  customerNumber: string;
  providerReference?: string | null;
  deviceRecordedAt?: string | null;
}): string {
  return fingerprint({
    v: 2,
    providerId: input.providerId.toLowerCase(),
    direction: input.direction,
    amount: money(input.amount),
    commissionAmount: money(input.commissionAmount),
    customerNumber: input.customerNumber,
    providerReference: text(input.providerReference),
    deviceRecordedAt: input.deviceRecordedAt ?? null,
  });
}

/**
 * The fingerprint of an exchange recorded under the rate (before D164): kept
 * so that a phone retrying such an exchange's own key, with its own payload,
 * is still answered with what was recorded — never recomputed for anything else.
 */
export function legacyExchangeFingerprint(input: {
  providerId: string;
  direction: AgentDirection;
  amount: number;
  customerNumber: string;
  providerReference?: string | null;
  configVersionId?: string | null;
  deviceRecordedAt?: string | null;
}): string {
  return fingerprint({
    providerId: input.providerId.toLowerCase(),
    direction: input.direction,
    amount: money(input.amount),
    customerNumber: input.customerNumber,
    providerReference: text(input.providerReference),
    configVersionId: input.configVersionId?.toLowerCase() ?? null,
    deviceRecordedAt: input.deviceRecordedAt ?? null,
  });
}

export function positionFingerprint(input: { providerId: string; accountKind: 'provider' | 'commission_held'; amount: number; note?: string | null }): string {
  return fingerprint({ providerId: input.providerId.toLowerCase(), accountKind: input.accountKind, amount: money(input.amount), note: text(input.note) });
}

/** A reason the record keeps (A7, §4.1): trimmed, and refused when nothing is left — a blank is not a why. */
export function reasonGiven(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new BadRequestException({ code: 'reason_required', message: 'Say why: the reason is kept with this record.' });
  return trimmed;
}

/** An account a rebalancing would leave below zero, as far as the app knows it (docs/73 §4.7 row 4). */
export interface NegativeAfter {
  account: LegAccount;
  providerId: string | null;
  position: number;
  after: number;
}

/**
 * The accounts a rebalancing's legs would take below zero: each account's net change applied to what the app tracks
 * for it now. An unknown position (null) is never taken for zero, so it refuses nothing; an account the legs leave
 * level or fill cannot go down; the outside world has no position.
 */
export function negativesAfter(legs: readonly Leg[], positionOf: (account: LegAccount, providerId: string | null) => number | null): NegativeAfter[] {
  const nets = new Map<string, { account: LegAccount; providerId: string | null; net: number }>();
  for (const leg of legs) {
    if (leg.account === 'external') continue;
    const key = `${leg.account}:${leg.providerId ?? ''}`;
    const entry = nets.get(key) ?? { account: leg.account, providerId: leg.providerId, net: 0 };
    entry.net = round2(entry.net + (leg.direction === 'inflow' ? leg.amount : -leg.amount));
    nets.set(key, entry);
  }
  const found: NegativeAfter[] = [];
  for (const { account, providerId, net } of nets.values()) {
    if (net >= 0) continue;
    const position = positionOf(account, providerId);
    if (position === null) continue;
    const after = round2(position + net);
    if (after < 0) found.push({ account, providerId, position, after });
  }
  return found;
}

export function rebalancingFingerprint(input: RebalancingInput & { reason: string; note?: string | null }): string {
  return fingerprint({
    reason: input.reason.trim(),
    note: text(input.note),
    legs: input.legs.map((l) => [l.account, l.providerId?.toLowerCase() ?? null, l.direction, money(l.amount)]),
    externalCounterparty: input.externalCounterparty ?? null,
    externalAmount: input.externalAmount == null ? null : money(input.externalAmount),
  });
}

export function mistakeFingerprint(input: { transactionId: string; kind: string; note?: string | null }): string {
  return fingerprint({ transactionId: input.transactionId.toLowerCase(), kind: input.kind, note: text(input.note) });
}
