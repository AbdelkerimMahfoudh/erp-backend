import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * The rules a correction obeys, as pure functions.
 *
 * Kept out of the service so each can be read and tested on its own — these
 * decide whether already-settled money gets un-settled, which is the most
 * consequential judgement in the application.
 */

export type CorrectionKind =
  | 'refund_payout'
  | 'supplier_settlement'
  | 'sale_payment'
  | 'sale'
  | 'expense'
  | 'supplier_payment'
  | 'purchase';
export type CorrectionAction = 'reverse' | 'reclassify' | 'cancel';
export type CorrectionStatus = 'requested' | 'approved' | 'rejected';

/**
 * What each kind of record may have done to it (0079, docs/51 §15). The database
 * holds the same table (`ck_fc_action`); this is where a request learns it first.
 */
export const ALLOWED_ACTIONS: Readonly<Record<CorrectionKind, readonly CorrectionAction[]>> = {
  refund_payout: ['reverse'],
  supplier_settlement: ['reverse'],
  sale_payment: ['reverse', 'reclassify'],
  sale: ['cancel'],
  expense: ['reverse'],
  supplier_payment: ['reclassify'],
  purchase: ['cancel'],
};

/**
 * The action a request means. A kind with one action needs no word for it; a sale
 * payment says which of its two it wants — a 0078 client that names a destination
 * and no action is asking for a move, as it always was.
 */
export function actionOf(kind: CorrectionKind, action: CorrectionAction | undefined, hasDestination: boolean): CorrectionAction {
  const allowed = ALLOWED_ACTIONS[kind];
  const chosen = action ?? (allowed.length === 1 ? allowed[0] : hasDestination ? 'reclassify' : undefined);
  if (!chosen) {
    throw new BadRequestException({ code: 'action_required', message: 'Say whether the payment went to another channel or was never received.' });
  }
  if (!allowed.includes(chosen)) {
    throw new BadRequestException({ code: 'action_not_allowed', message: 'That correction does not apply to this kind of record.' });
  }
  if (chosen !== 'reclassify' && hasDestination) {
    throw new BadRequestException({ code: 'not_a_reclassification', message: 'Only a move to another channel names where the money went.' });
  }
  return chosen;
}

/**
 * Only a CONFIRMED payment can be corrected.
 *
 * A merely reported one has moved no money and settled no liability, so there
 * is nothing to compensate — and it already has its own correction path
 * (`PATCH /returns/:id/refund`, `correctSettlement`). Routing a reported
 * payment through here would post a compensating movement for cash that never
 * left, inventing money.
 */
export function assertTargetCorrectable(target: { status: string } | null): void {
  if (!target) {
    throw new BadRequestException('That payment does not exist.');
  }
  if (target.status !== 'confirmed') {
    throw new ConflictException({
      code: 'not_confirmed',
      message:
        'Only a confirmed payment can be corrected. One that is still awaiting confirmation can be changed directly.',
    });
  }
}

/**
 * A correction is a one-shot. The database enforces this too — at most one
 * approved correction may exist per target — but failing here gives the caller
 * a sentence instead of a duplicate-key error.
 */
export function assertNotAlreadyCorrected(existing: { status: string }[] | null): void {
  const approved = (existing ?? []).some((c) => c.status === 'approved');
  if (approved) {
    throw new ConflictException({
      code: 'already_corrected',
      message: 'This payment has already been corrected. Record a replacement payment instead.',
    });
  }
}

/**
 * One open request at a time.
 *
 * Two people asking to correct the same payment is not an error worth a stack
 * trace, but letting both stand would leave an owner approving one and
 * wondering what the other was for.
 */
export function assertNoOpenRequest(existing: { status: string }[] | null): void {
  const open = (existing ?? []).some((c) => c.status === 'requested');
  if (open) {
    throw new ConflictException({
      code: 'request_pending',
      message: 'Someone has already asked for this payment to be corrected. That request is waiting for an owner.',
    });
  }
}

/** A reason that is only whitespace is not a reason. The DB agrees. */
export function assertReasonGiven(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) {
    throw new BadRequestException({
      code: 'reason_required',
      message: 'Say why this payment is being corrected.',
    });
  }
  return trimmed;
}

/**
 * Only a request that is still open can be decided.
 *
 * Deciding an already-decided one is not a retry — the first decision may have
 * moved money — so it is a conflict rather than a silent no-op.
 */
export function assertDecidable(current: { status: string }): void {
  if (current.status !== 'requested') {
    throw new ConflictException({
      code: 'already_decided',
      message:
        current.status === 'approved'
          ? 'This correction was already approved.'
          : 'This correction was already rejected.',
    });
  }
}

/**
 * The compensating movement lands on the CURRENT open business day, never on
 * the day of the original payment.
 *
 * If today is closed, the correction waits. Reopening a filed closing to slot a
 * movement into it would rewrite a day the shop has already counted and signed
 * off — which is the exact thing this whole design exists to avoid.
 */
export function assertDayOpen(closing: { isLocked: boolean } | null, day: string): void {
  if (closing?.isLocked) {
    // Same code and shape as the refund/settlement confirmation guard, so the
    // mobile conflict handler recognises it without a second branch.
    throw new ConflictException({
      code: 'day_already_closed',
      message: `${day} is already closed for this branch. A correction posts to the current open day, so this must wait until the next one opens.`,
    });
  }
}

/**
 * The payload fingerprint behind idempotency.
 *
 * Same key and same payload replays the original; same key and a DIFFERENT
 * payload is a conflict, because that is not a retry — it is a second
 * correction wearing the first one's id.
 */
export function fingerprintCorrection(input: {
  targetKind: CorrectionKind;
  action?: CorrectionAction;
  targetId: string;
  reason: string;
  supportingReference?: string | null;
  toMethod?: 'cash' | 'account' | null;
  toAccountId?: string | null;
  amount?: number | null;
}): string {
  const parts = [input.targetKind, input.targetId, input.reason.trim(), (input.supportingReference ?? '').trim()];
  // A reclassification is also defined by where the money goes and how much of it (0078).
  if (input.targetKind === 'sale_payment') parts.push(input.toMethod ?? '', input.toAccountId ?? '', String(input.amount ?? ''));
  // 0079: what is done and how much of it are part of the request too — reversing a payment is
  // not moving it, and reversing half an expense is not reversing all of it.
  // The fingerprints of the three earlier kinds are unchanged, so their replays still match.
  const extended = !['refund_payout', 'supplier_settlement', 'sale_payment'].includes(input.targetKind);
  if (extended || (input.targetKind === 'sale_payment' && input.action === 'reverse')) {
    parts.push(input.action ?? '', input.toMethod ?? '', input.toAccountId ?? '', String(input.amount ?? ''));
  }
  return createHash('sha256')
    .update(parts.join('|'))
    .digest('hex');
}

// ── Reclassifying a payment to the channel it really reached (0078, docs/51 D9) ──

export interface PaymentTarget {
  amount: number;
  /** Where the payment was recorded: cash, or an account (NULL = unattributed). */
  fromMethod: 'cash' | 'account';
  fromAccountId: string | null;
}

export interface Destination {
  toMethod: 'cash' | 'account';
  toAccountId: string | null;
  /** Whether the destination account is active; irrelevant for cash. */
  toAccountActive: boolean;
}

/**
 * A payment recorded against the wrong channel — Cash for Bankily, one account for
 * another, or part of it — is moved to the channel it really reached. Nothing else
 * about the sale changes: the amount collected stays the same, so what the customer
 * owes stays the same.
 *
 * Refused, by name: moving nothing or more than was paid; moving money to the
 * channel it is already in; cash that names an account or an account that names
 * none; an inactive account.
 */
export function assertReclassifiable(target: PaymentTarget, to: Destination, amount: number): void {
  if (!(amount > 0)) {
    throw new BadRequestException({ code: 'amount_required', message: 'Say how much of the payment went to another channel.' });
  }
  if (Math.round(amount * 100) > Math.round(target.amount * 100)) {
    throw new BadRequestException({ code: 'amount_above_payment', message: 'You cannot move more than the payment recorded.' });
  }
  if (to.toMethod === 'cash' && to.toAccountId) {
    throw new BadRequestException({ code: 'cash_has_no_account', message: 'Cash belongs to no account.' });
  }
  if (to.toMethod === 'account' && !to.toAccountId) {
    throw new BadRequestException({ code: 'account_required', message: 'Say which account the money reached.' });
  }
  if (to.toMethod === 'account' && !to.toAccountActive) {
    throw new BadRequestException({ code: 'account_inactive', message: 'That account is no longer active.' });
  }
  const same = to.toMethod === target.fromMethod && (to.toAccountId ?? null) === (target.fromAccountId ?? null);
  if (same) {
    throw new BadRequestException({ code: 'same_channel', message: 'The payment is already recorded in that channel.' });
  }
}

// ── 0079: the money a correction moves, and what a record still holds ─────────

const EPS = 0.005;
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export type Method = 'cash' | 'account';

/** A channel as the closing knows it: the drawer, one account, or an account never named. */
export interface ChannelRef {
  method: Method;
  accountId: string | null;
  label: string | null;
}

/** One leg of a correction: money reaching a channel (`in`) or leaving it (`out`). */
export interface Leg extends ChannelRef {
  direction: 'in' | 'out';
  amount: number;
}

export const channelKey = (c: { method: Method; accountId: string | null }): string => `${c.method}:${c.accountId ?? 'NONE'}`;

/**
 * Where a recorded movement's money is NOW: the original record in its own channel,
 * plus every leg an approved correction already posted against it — a move takes it
 * out of one channel and into another, a reversal takes it out. Only what is still
 * held remains, to the cent. This is what a later cancellation has to give back:
 * money that was moved is given back from where it went, never from where it was
 * first recorded.
 */
export function positionsOf(original: ChannelRef & { amount: number }, legs: Leg[]): (ChannelRef & { amount: number })[] {
  const byKey = new Map<string, ChannelRef & { amount: number }>();
  const add = (c: ChannelRef, amount: number) => {
    const key = channelKey(c);
    const current = byKey.get(key) ?? { method: c.method, accountId: c.accountId, label: c.label, amount: 0 };
    current.amount = round2(current.amount + amount);
    if (!current.label && c.label) current.label = c.label;
    byKey.set(key, current);
  };
  add(original, original.amount);
  for (const l of legs) add(l, l.direction === 'in' ? l.amount : -l.amount);
  return [...byKey.values()].filter((p) => p.amount > EPS);
}

/**
 * The legs of a whole-record cancellation: every position still held, moved in one
 * direction — `out` for a sale (the money given back, or never received), `in` for a
 * purchase (the money paid comes back). One leg per source and channel, so each leg
 * still says which payment it came from.
 */
export function cancellationLegs<T extends string>(
  holdings: { sourceId: T; positions: (ChannelRef & { amount: number })[] }[],
  direction: 'in' | 'out',
): (Leg & { sourceId: T })[] {
  return holdings.flatMap((h) => h.positions.map((p) => ({ ...p, amount: round2(p.amount), direction, sourceId: h.sourceId })));
}

// ── A payment never received (D13) ──

/** All or part of a payment, never nothing and never more than it recorded. */
export function assertReversible(paid: number, amount: number): void {
  if (!(amount > 0)) {
    throw new BadRequestException({ code: 'amount_required', message: 'Say how much of the payment was never received.' });
  }
  if (Math.round(amount * 100) > Math.round(paid * 100)) {
    throw new BadRequestException({ code: 'amount_above_payment', message: 'You cannot reverse more than the payment recorded.' });
  }
}

/**
 * A reversed payment's money was never there, so the sale is owed it again. Without a
 * customer or a partner store to owe it, the sale itself is what was wrong.
 */
export function assertDebtorFor(sale: { customerId: unknown; counterpartyId: unknown }): void {
  if (!sale.customerId && !sale.counterpartyId) {
    throw new ConflictException({
      code: 'no_debtor',
      message: 'This sale has no customer who could owe the money. If it was never paid, cancel the sale instead.',
    });
  }
}

/** The sale after `amount` of what it received turns out never to have arrived. */
export function afterReversal(balance: { total: number; received: number }, amount: number) {
  const received = round2(balance.received - amount);
  const remaining = round2(balance.total - received);
  const payStatus: 'paid' | 'partial' | 'credit' = remaining <= EPS ? 'paid' : received <= EPS ? 'credit' : 'partial';
  return { received, remaining, payStatus };
}

// ── A sale that should not exist as recorded (D14) ──

export interface SaleCancellationState {
  alreadyCancelled: boolean;
  /** An open request to cancel this sale. */
  requestPending: boolean;
  /** An open request to correct one of its payments. */
  paymentRequestPending: boolean;
  /** A return claim still open or approved, an approved reversal, or a legacy return. */
  hasReturn: boolean;
  /** The statuses of the phones on its lines. */
  unitStatuses: string[];
}

/**
 * A whole sale can be cancelled while every phone on it is still `sold` — in the
 * customer's hands or back on the counter, never returned, moved or sold again — and
 * nothing else is already correcting it. A return is corrected on the return.
 */
export function assertSaleCancellable(s: SaleCancellationState): void {
  if (s.alreadyCancelled) {
    throw new ConflictException({ code: 'already_cancelled', message: 'This sale was already cancelled.' });
  }
  if (s.requestPending) {
    throw new ConflictException({ code: 'request_pending', message: 'Someone has already asked for this sale to be cancelled. That request is waiting for the Owner.' });
  }
  if (s.paymentRequestPending) {
    throw new ConflictException({ code: 'payment_correction_pending', message: 'A correction of one of its payments is waiting for the Owner. Decide it first.' });
  }
  if (s.hasReturn) {
    throw new ConflictException({ code: 'sale_has_return', message: 'This sale has a return. Correct it on the return.' });
  }
  const moved = s.unitStatuses.filter((st) => st !== 'sold').length;
  if (moved > 0) {
    throw new ConflictException({ code: 'unit_not_sold', message: 'A phone on this sale is no longer sold as recorded, so the sale cannot be cancelled.', count: moved });
  }
}

// ── A confirmed expense that was wrong (D15) ──

/**
 * A confirmed expense, all or part of it — and not before the day it counts on: a
 * fixed expense due next week has not left the drawer yet, so nothing can come back.
 */
export function assertExpenseReversible(e: { status: string; amount: number; accountingDay: string | null }, amount: number, today: string): void {
  if (e.status !== 'confirmed') {
    throw new ConflictException({ code: 'not_confirmed', message: 'Only a confirmed expense can be reversed. One that is still reported can be rejected.' });
  }
  if (!(amount > 0)) {
    throw new BadRequestException({ code: 'amount_required', message: 'Say how much of the expense was wrong.' });
  }
  if (Math.round(amount * 100) > Math.round(e.amount * 100)) {
    throw new BadRequestException({ code: 'amount_above_expense', message: 'You cannot reverse more than the expense recorded.' });
  }
  if (e.accountingDay && e.accountingDay > today) {
    throw new ConflictException({ code: 'expense_not_yet_due', message: `This expense counts on ${e.accountingDay}. It can be reversed from that day.`, day: e.accountingDay });
  }
}

// ── A purchase that should not exist as recorded (D17) ──

export interface PurchaseCancellationState {
  alreadyCancelled: boolean;
  requestPending: boolean;
  paymentRequestPending: boolean;
  /** Each phone of the purchase: its status, and whether it is still at the purchase's branch. */
  units: { status: string; atBranch: boolean }[];
  /** Each quantity line, against the branch's stock of that product now. */
  stock: { onHand: number; reserved: number; bought: number; averageCost: number; unitCost: number }[];
}

/**
 * The branch's stock after taking back goods bought at `unitCost` — the inverse of
 * receiving (`receiveQuantityAtCost`). Null when the stock no longer holds them, or
 * when what is left would be worth less than nothing (the goods were sold at an
 * average the purchase itself raised).
 */
export function averageAfterRemoval(onHand: number, averageCost: number, removed: number, unitCost: number): { quantity: number; cost: number } | null {
  const quantity = onHand - removed;
  if (quantity < 0) return null;
  if (quantity === 0) return { quantity: 0, cost: round2(averageCost) };
  const value = onHand * averageCost - removed * unitCost;
  if (value < -EPS) return null;
  return { quantity, cost: round2(Math.max(0, value) / quantity) };
}

/**
 * A whole purchase can be cancelled while every phone it brought is still in stock at
 * its branch and the branch still holds every quantity item it bought, free of any
 * transfer. Goods that moved are corrected where they went first.
 */
export function assertPurchaseCancellable(s: PurchaseCancellationState): void {
  if (s.alreadyCancelled) {
    throw new ConflictException({ code: 'already_cancelled', message: 'This purchase was already cancelled.' });
  }
  if (s.requestPending) {
    throw new ConflictException({ code: 'request_pending', message: 'Someone has already asked for this purchase to be cancelled. That request is waiting for the Owner.' });
  }
  if (s.paymentRequestPending) {
    throw new ConflictException({ code: 'payment_correction_pending', message: 'A correction of its payment is waiting for the Owner. Decide it first.' });
  }
  const moved = s.units.filter((u) => u.status !== 'in_stock' || !u.atBranch).length;
  if (moved > 0) {
    throw new ConflictException({ code: 'goods_moved', message: 'Some of what this purchase brought has been sold, moved or reserved. Correct that first.', count: moved });
  }
  for (const line of s.stock) {
    if (line.onHand - line.reserved < line.bought) {
      throw new ConflictException({ code: 'stock_short', message: 'The shop no longer holds everything this purchase brought.' });
    }
    if (averageAfterRemoval(line.onHand, line.averageCost, line.bought, line.unitCost) === null) {
      throw new ConflictException({ code: 'cost_conflict', message: 'Taking these items back would leave the remaining stock with a cost below zero.' });
    }
  }
}
