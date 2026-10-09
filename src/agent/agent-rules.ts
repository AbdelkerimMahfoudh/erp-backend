import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { parsePayerNumber, PAYER_NUMBER_MAX_DIGITS } from '../sales/payer-number';

/**
 * The rules of the agent ledger (docs/73 §4, D154): what a provider must have
 * configured before it can post, the commission of an exchange, the legs an
 * exchange moves between the drawer and the provider's float, the counter-legs
 * of a reversal, when a rebalancing balances, what a float holds, and the
 * customer number.
 *
 * Pure on purpose, like `channels.ts` and `money-positions.ts`: every figure a
 * transaction records is computed here from its inputs, so the accounting can
 * be checked without a database — and nothing here guesses. A blank rate is a
 * blank, never zero; a blank destination posts nothing (A4).
 */

export type AgentDirection = 'cash_in_credit_out' | 'cash_out_credit_in';
export type CommissionDestination = 'cash' | 'provider_float' | 'held_separately';
export type PrincipalFeeMode = 'separate' | 'deducted';
export type ReferenceRule = 'required' | 'optional' | 'none';
export type LegAccount = 'cash' | 'provider' | 'commission_held' | 'external';
export type LegDirection = 'inflow' | 'outflow';
export type LegKind = 'principal' | 'commission' | 'reversal' | 'rebalancing';
export type ExternalCounterparty = 'owner_capital' | 'provider_settlement' | 'other';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Configuration ───────────────────────────────────────────────────────────

/** A provider's configuration version as it is stored: NULL is "not supplied", never zero. */
export interface ProviderConfig {
  /** Basis points on a Receive cash / Send credit exchange (the agent takes cash IN). */
  rateInBp: number | null;
  /** Basis points on a Give cash / Receive credit exchange (cash goes OUT). */
  rateOutBp: number | null;
  sameRateBothDirections: boolean;
  commissionDestination: CommissionDestination | null;
  principalFeeMode: PrincipalFeeMode | null;
  referenceRule: ReferenceRule | null;
}

/** Every field the Owner must fill from the real schedule before the provider posts (docs/73 §1.2). */
export const REQUIRED_CONFIG_FIELDS = ['rateInBp', 'rateOutBp', 'commissionDestination', 'principalFeeMode', 'referenceRule'] as const;
export type RequiredConfigField = (typeof REQUIRED_CONFIG_FIELDS)[number];

/** The blanks of the version in force; all five when there is no version at all. */
export function missingConfigFields(config: ProviderConfig | null | undefined): RequiredConfigField[] {
  if (!config) return [...REQUIRED_CONFIG_FIELDS];
  return REQUIRED_CONFIG_FIELDS.filter((field) => config[field] === null || config[field] === undefined);
}

/** Computed, never stored: a provider posts only while nothing required is blank. */
export function readyForTransactions(config: ProviderConfig | null | undefined): boolean {
  return missingConfigFields(config).length === 0;
}

/**
 * One rate for both directions means the Owner typed one figure: it is the
 * figure of both, so a version never carries two rates that disagree with its
 * own flag.
 */
export function withSameRate<T extends Pick<ProviderConfig, 'rateInBp' | 'rateOutBp' | 'sameRateBothDirections'>>(input: T): T {
  return input.sameRateBothDirections ? { ...input, rateOutBp: input.rateInBp } : input;
}

export type ConfigRefusal = 'deducted_destination';

/**
 * A provider cannot net its fee into the principal AND pay it somewhere else
 * (docs/73 §4.2): with `deducted` the commission only ever lands on the float,
 * so any other destination is refused as a configuration, and the Owner is
 * told why rather than left with a version that can post nothing coherent.
 */
export function configRefusal(config: Pick<ProviderConfig, 'commissionDestination' | 'principalFeeMode'>): ConfigRefusal | null {
  if (config.principalFeeMode === 'deducted' && config.commissionDestination !== 'provider_float') return 'deducted_destination';
  return null;
}

// ── Commission ──────────────────────────────────────────────────────────────

/** The direction's own rate: a real schedule may charge the two directions differently (A4). */
export function rateFor(direction: AgentDirection, config: Pick<ProviderConfig, 'rateInBp' | 'rateOutBp'>): number | null {
  return direction === 'cash_in_credit_out' ? config.rateInBp : config.rateOutBp;
}

/** The whole amount at the rate, never brackets (A4), to the cent. */
export function commissionOf(amount: number, rateBp: number): number {
  return round2((amount * rateBp) / 10_000);
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
  commission: number;
  providerId: string;
  commissionDestination: CommissionDestination;
  principalFeeMode: PrincipalFeeMode;
}

/**
 * The legs an exchange posts at completion (docs/73 §4.2–4.3).
 *
 * Receive cash / Send credit (amount A, commission C): cash in A — the drawer's
 * `agentIn` — and the float out A. Give cash / Receive credit: cash out A — the
 * drawer's `agentOut` — and the float in A. Then the commission as configured:
 * settled apart, it is one more leg in on the float, on the drawer, or on the
 * commission the provider holds for the agent; deducted by the provider, the
 * float leg is netted instead (out A − C, in A + C) and no commission leg is
 * written — `commission_amount` on the transaction still records what was
 * earned. A leg of zero moves nothing and is not written.
 */
export function exchangeLegs(input: ExchangeInput): Leg[] {
  const amount = round2(input.amount);
  const commission = round2(input.commission);
  const cashIn = input.direction === 'cash_in_credit_out';
  const floatDirection: LegDirection = cashIn ? 'outflow' : 'inflow';
  const legs: Leg[] = [{ account: 'cash', providerId: null, direction: cashIn ? 'inflow' : 'outflow', amount, kind: 'principal' }];
  if (input.principalFeeMode === 'deducted') {
    if (input.commissionDestination !== 'provider_float') {
      // Refused when configured (`configRefusal`); reaching it here is a defect, never something to post.
      throw new Error('A deducted commission can only land on the provider float');
    }
    legs.push({ account: 'provider', providerId: input.providerId, direction: floatDirection, amount: round2(cashIn ? amount - commission : amount + commission), kind: 'principal' });
  } else {
    legs.push({ account: 'provider', providerId: input.providerId, direction: floatDirection, amount, kind: 'principal' });
    const account: LegAccount = input.commissionDestination === 'cash' ? 'cash' : input.commissionDestination === 'provider_float' ? 'provider' : 'commission_held';
    legs.push({ account, providerId: account === 'cash' ? null : input.providerId, direction: 'inflow', amount: commission, kind: 'commission' });
  }
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

export const CUSTOMER_NUMBER_MIN_DIGITS = 4;
export const CUSTOMER_NUMBER_MAX_DIGITS = PAYER_NUMBER_MAX_DIGITS;

export type ParsedCustomerNumber =
  | { ok: true; value: string; last4: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'too_short' | 'too_long' };

/**
 * The customer number (A6, docs/73 §4.6): the same digits rule as the payer
 * number — digits, an optional leading `+`, Arabic-Indic digits read as the
 * same digits, spaces and hyphens dropped, no country guessed — but mandatory,
 * and at least four digits so the masked `•••• 1234` has something to show.
 * The last four digits are kept apart for the masked list and search.
 */
export function parseCustomerNumber(raw: string | null | undefined): ParsedCustomerNumber {
  const parsed = parsePayerNumber(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.value === null) return { ok: false, reason: 'missing' };
  const digits = parsed.value.replace(/^\+/, '');
  if (digits.length < CUSTOMER_NUMBER_MIN_DIGITS) return { ok: false, reason: 'too_short' };
  return { ok: true, value: parsed.value, last4: digits.slice(-4) };
}

/** The number as it is stored, or the refusal — which names the problem, never the number (it reaches the log). */
export function customerNumberFor(raw: string | null | undefined): { value: string; last4: string } {
  const parsed = parseCustomerNumber(raw);
  if (parsed.ok) return { value: parsed.value, last4: parsed.last4 };
  const message = {
    missing: 'The customer number is required.',
    invalid: 'A customer number is digits, with spaces or hyphens and an optional leading +',
    too_short: `A customer number has at least ${CUSTOMER_NUMBER_MIN_DIGITS} digits`,
    too_long: `A customer number has at most ${CUSTOMER_NUMBER_MAX_DIGITS} digits`,
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
 * second exchange wearing the first one's identity, refused as a conflict.
 * The number is bound in its normalised form, so a retry spaced differently is
 * still the same exchange; the phone's own time is part of its claim.
 */
export function exchangeFingerprint(input: {
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
