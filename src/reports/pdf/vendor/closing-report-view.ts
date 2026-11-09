// GENERATED from erp-mobile lib/closing-report-view.ts at 5dcfb74 by scripts/sync-report-pdf.mjs — do not edit; sync again.
/* eslint-disable */
// @ts-nocheck
/**
 * What the Daily closing report screen may decide for itself (docs/51).
 *
 *   node lib/closing-report-view.test.ts
 *
 * Every figure comes from the server, already reconciled; the phone adds
 * nothing up. What is left here is words and states: which catalogue key names
 * a verification or a warning, whether the figures on screen are fresh, and
 * whether a close may be confirmed. Imports nothing, so it runs under bare node.
 */

/**
 * How one channel stands against its expected figure (backend `Verification`).
 * `attested`: closed on the person's word that they checked it, with no amount
 * recorded (docs/58 D71) — never a count, never matched, no difference.
 */
export type Verification = 'counted' | 'skipped' | 'not_verified' | 'attested' | 'stale' | 'not_counted';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/**
 * The word for a verification — always shown beside its colour. An account is
 * never counted: its check is a reading of the movement its app shows, so a
 * checked account says so rather than "Counted" (docs/58 §1.2). An attested
 * channel says "Checked; amounts not recorded" whichever channel it is.
 */
export function verificationKey(v: Verification, channel: 'cash' | 'account' = 'cash'): string {
  if (channel === 'account' && (v === 'counted' || v === 'stale')) return `dailyReport.verify.account.${v}`;
  return `dailyReport.verify.${v}`;
}

/**
 * Only a count is a verification. A counted channel with a difference is a
 * question, not a match; anything not counted is never green — an attestation
 * is information, neither green nor a warning.
 */
export function verificationTone(v: Verification, difference: number | null): Tone {
  if (v === 'counted') return difference !== null && Math.abs(difference) >= 0.005 ? 'warning' : 'success';
  if (v === 'not_verified' || v === 'stale') return 'warning';
  if (v === 'attested') return 'info';
  return 'neutral';
}

export type WarningCode =
  | 'channels_not_verified'
  | 'channels_attested'
  | 'channels_stale'
  | 'account_movement_not_balance'
  | 'unattributed_money'
  | 'pending_refund_reports'
  | 'pending_expense_reports'
  | 'cost_missing'
  | 'no_counted_opening'
  | 'opening_not_verified'
  | 'negative_expected'
  | 'open_discrepancies'
  | 'previous_day_needs_review'
  | 'overcollected'
  | 'changed_since_close'
  | 'figures_disagree'
  | 'money_moved_after_count';

const KNOWN_WARNINGS: readonly string[] = [
  'channels_not_verified',
  'channels_attested',
  'channels_stale',
  'account_movement_not_balance',
  'unattributed_money',
  'pending_refund_reports',
  'pending_expense_reports',
  'cost_missing',
  'no_counted_opening',
  'opening_not_verified',
  'negative_expected',
  'open_discrepancies',
  'previous_day_needs_review',
  'overcollected',
  'changed_since_close',
  'figures_disagree',
  'money_moved_after_count',
];

/** The warnings that carry a number, and which parameter it is: worded for one too, never "1 differences". */
const COUNTED_WARNINGS: Readonly<Record<string, string>> = {
  channels_not_verified: 'count',
  channels_stale: 'count',
  pending_refund_reports: 'count',
  pending_expense_reports: 'count',
  cost_missing: 'count',
  opening_not_verified: 'days',
  open_discrepancies: 'count',
  money_moved_after_count: 'count',
};

/**
 * The catalogue key of a warning; an unknown one falls back to a generic line rather than a raw code.
 * With the warning's parameters, a count of one picks the sentence written for one (`….one`).
 */
export function warningKey(code: string, params?: Readonly<Record<string, unknown>> | null): string {
  if (!KNOWN_WARNINGS.includes(code)) return 'dailyReport.warning.other';
  const counted = COUNTED_WARNINGS[code];
  return counted && Number(params?.[counted]) === 1 ? `dailyReport.warning.${code}.one` : `dailyReport.warning.${code}`;
}

/**
 * Whether the figures on screen can be treated as the day's figures. `live`:
 * read from the server a moment ago. `stale`: read a while ago — shown, but not
 * final. `offline`: the phone cannot reach the server — shown as last read, and
 * nothing may be closed on them.
 */
export type Freshness = 'live' | 'stale' | 'offline';

export function reportFreshness(fetchedAt: number | null | undefined, online: boolean, now: number = Date.now(), freshMs = 120_000): Freshness {
  if (!online) return 'offline';
  if (!fetchedAt) return 'stale';
  return now - fetchedAt <= freshMs ? 'live' : 'stale';
}

/** A reason a person actually wrote — three characters or more, spaces aside. */
export function reasonGiven(reason: string): boolean {
  return reason.trim().length >= 3;
}

/**
 * Whether "Close the business day" may be pressed in the closing popup.
 *
 * Never because counts are missing — physical checks are optional (docs/51 D2).
 * Only when the figures are live, the person may close, and — if any balance has
 * no amount — they have attested that they checked it (docs/58 D71); the
 * attestation is recorded with their name and the time, and invents no figure.
 */
export function canConfirmClose(input: {
  canClose: boolean;
  freshness: Freshness;
  requiresAcknowledgement: boolean;
  attested: boolean;
  busy: boolean;
}): boolean {
  if (!input.canClose || input.busy || input.freshness !== 'live') return false;
  if (!input.requiresAcknowledgement) return true;
  return input.attested;
}

/** Every refusal the server names (docs/51 §15), each with its own sentence. */
export const KNOWN_REFUSALS: readonly string[] = [
  'already_corrected',
  'request_pending',
  'not_permitted',
  'sale_cancelled',
  'sale_cancellation_pending',
  'already_cancelled',
  'sale_has_return',
  'unit_not_sold',
  'payment_correction_pending',
  'no_debtor',
  'not_confirmed',
  'expense_not_yet_due',
  'purchase_cancelled',
  'purchase_cancellation_pending',
  'goods_moved',
  'stock_short',
  'cost_conflict',
];

/** The word for a record's refusal, or null when it can be acted on; an unknown one gets a generic line, never a code. */
export function refusalKey(refusal: string | null): string | null {
  if (!refusal) return null;
  return KNOWN_REFUSALS.includes(refusal) ? `correctTx.refusal.${refusal}` : 'correctTx.refusal.other';
}

export type CorrectionAction =
  | 'cancel_sale'
  | 'reverse_payment'
  | 'reclassify_payment'
  | 'reverse_expense'
  | 'reclassify_purchase_payment'
  | 'cancel_purchase';

/** What the action is called on its button and on its sheet. */
export function actionKey(action: CorrectionAction): string {
  return `correctTx.action.${action}`;
}

/** Whether an action takes an amount (a part of a payment or an expense), a destination, or neither. */
export function actionNeeds(action: CorrectionAction): { amount: boolean; destination: boolean } {
  return {
    amount: action === 'reverse_payment' || action === 'reverse_expense' || action === 'reclassify_payment' || action === 'reclassify_purchase_payment',
    destination: action === 'reclassify_payment' || action === 'reclassify_purchase_payment',
  };
}

/**
 * Which record an action corrects. A stock purchase row IS its payment (the id a move
 * needs), while cancelling acts on the purchase itself; a payment row's sale is the
 * record a sale cancellation needs. Found by the render checks: the purchase row's
 * payment id was sent as the purchase, and the server rightly said it did not exist.
 */
export function targetIdFor(row: { kind: string; id: string; detail: Record<string, unknown> }, action: CorrectionAction): string {
  if (action === 'cancel_purchase') return String(row.detail.purchaseId ?? row.id);
  if (action === 'cancel_sale' && row.kind === 'payment') return String(row.detail.saleId ?? row.id);
  return row.id;
}

/** A request waiting for the Owner, said as what it would do. */
export function pendingKey(p: { targetKind: string; action: string }): string {
  const known = ['sale:cancel', 'sale_payment:reverse', 'sale_payment:reclassify', 'expense:reverse', 'supplier_payment:reclassify', 'purchase:cancel', 'refund_payout:reverse', 'supplier_settlement:reverse'];
  const k = `${p.targetKind}:${p.action}`;
  return known.includes(k) ? `correctTx.pending.${k.replace(':', '.')}` : 'correctTx.pending.other';
}

/**
 * Whether the correction may be sent: something to send it on (a preview without a
 * refusal), a valid amount where one is asked, a destination where one is needed,
 * and a reason a person actually wrote.
 */
export function canSendCorrection(input: {
  action: CorrectionAction;
  amount: number | null;
  maxAmount: number;
  destinationChosen: boolean;
  reason: string;
  previewOk: boolean;
  refused: boolean;
  busy: boolean;
}): boolean {
  if (input.busy || !input.previewOk || input.refused || !reasonGiven(input.reason)) return false;
  const needs = actionNeeds(input.action);
  if (needs.destination && !input.destinationChosen) return false;
  if (needs.amount && !(input.amount !== null && input.amount > 0 && Math.round(input.amount * 100) <= Math.round(input.maxAmount * 100))) return false;
  return true;
}

/** A channel's display label: the catalogue word for cash and unattributed money, the account's own label otherwise. */
export function channelLabel(
  c: { channel: 'cash' | 'account'; isUnattributed?: boolean; label?: string | null },
  words: { cash: string; unattributed: string },
): string {
  if (c.channel === 'cash') return words.cash;
  if (c.isUnattributed || !c.label || c.label === 'UNATTRIBUTED') return words.unattributed;
  return c.label;
}

// ── Money moved after the count (D159) ───────────────────────────────────────

/**
 * What moved after counting began: the channels and floats to count again, and
 * what was recorded since — the agent exchanges, reversals and rebalancings
 * (all zero at a shop, where a sale after the count is reason enough).
 */
export interface MovedAfterCount {
  channels: { key: string; label: string }[];
  floats: { providerId: string; label: string }[];
  exchanges: number;
  reversals: number;
  rebalancings: number;
}

interface Moved {
  movedSinceCount?: boolean;
}

/** The parts of a report this reads: its warnings, and the stale marker on each channel and float. */
export interface MovedReport {
  warnings?: readonly { code: string; params?: Readonly<Record<string, string | number>> }[];
  money?: { channels?: readonly (Moved & { key: string; label: string; channel?: string })[] };
  expected?: {
    cash?: Moved | null;
    accounts?: readonly (Moved & { key: string; label: string })[];
    floats?: readonly (Moved & { providerId: string; label: string })[] | null;
  };
}

/** The parts of the day's live view this reads: each channel and float, with the stale marker. */
export interface MovedView {
  channels?: readonly (Moved & { channel: string; accountId: string | null; labelSnapshot: string })[];
  floats?: readonly (Moved & { providerId: string; label: string })[] | null;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);

function addChannel(list: MovedAfterCount['channels'], key: string, label: string): void {
  if (!list.some((c) => c.key === key)) list.push({ key, label });
}
function addFloat(list: MovedAfterCount['floats'], providerId: string, label: string): void {
  if (!list.some((f) => f.providerId === providerId)) list.push({ providerId, label });
}

/**
 * What the report and the live view say moved since its count: each channel and
 * float marked `movedSinceCount`, and the `money_moved_after_count` warning's
 * counts. Null when nothing did.
 */
export function movedFromData(report: MovedReport | null | undefined, view?: MovedView | null): MovedAfterCount | null {
  const out: MovedAfterCount = { channels: [], floats: [], exchanges: 0, reversals: 0, rebalancings: 0 };
  for (const c of report?.money?.channels ?? []) if (c.movedSinceCount) addChannel(out.channels, c.key, c.label);
  if (report?.expected?.cash?.movedSinceCount) addChannel(out.channels, 'cash:NONE', 'CASH');
  for (const a of report?.expected?.accounts ?? []) if (a.movedSinceCount) addChannel(out.channels, a.key, a.label);
  for (const f of report?.expected?.floats ?? []) if (f.movedSinceCount) addFloat(out.floats, f.providerId, f.label);
  for (const c of view?.channels ?? []) if (c.movedSinceCount) addChannel(out.channels, `${c.channel}:${c.accountId ?? 'NONE'}`, c.labelSnapshot);
  for (const f of view?.floats ?? []) if (f.movedSinceCount) addFloat(out.floats, f.providerId, f.label);
  const warning = report?.warnings?.find((w) => w.code === 'money_moved_after_count');
  if (warning) {
    out.exchanges = count(warning.params?.exchanges);
    out.reversals = count(warning.params?.reversals);
    out.rebalancings = count(warning.params?.rebalancings);
  }
  return out.channels.length > 0 || out.floats.length > 0 || warning ? out : null;
}

/**
 * What a refused close says moved (409 `money_moved_after_count`, or
 * `report_changed` with the current report): the channels and floats it names,
 * else the ones its report marks; the counts from its report's warning. Null
 * when the refusal names nothing that moved after a count.
 */
export function movedAfterCount(body: unknown): MovedAfterCount | null {
  const b = (body ?? {}) as { channels?: unknown; floats?: unknown; report?: MovedReport | null };
  const out = movedFromData(b.report ?? null) ?? { channels: [], floats: [], exchanges: 0, reversals: 0, rebalancings: 0 };
  if (Array.isArray(b.channels)) {
    for (const c of b.channels as { key?: unknown; label?: unknown }[]) {
      if (typeof c?.key === 'string') addChannel(out.channels, c.key, typeof c.label === 'string' ? c.label : c.key);
    }
  }
  if (Array.isArray(b.floats)) {
    for (const f of b.floats as { providerId?: unknown; label?: unknown }[]) {
      if (typeof f?.providerId === 'string') addFloat(out.floats, f.providerId, typeof f.label === 'string' ? f.label : '');
    }
  }
  return out.channels.length > 0 || out.floats.length > 0 || out.exchanges + out.reversals + out.rebalancings > 0 ? out : null;
}

/** Both, the refusal's names first; null when neither has anything. */
export function mergeMoved(a: MovedAfterCount | null, b: MovedAfterCount | null): MovedAfterCount | null {
  if (!a) return b;
  if (!b) return a;
  const out: MovedAfterCount = { channels: [...a.channels], floats: [...a.floats], exchanges: Math.max(a.exchanges, b.exchanges), reversals: Math.max(a.reversals, b.reversals), rebalancings: Math.max(a.rebalancings, b.rebalancings) };
  for (const c of b.channels) addChannel(out.channels, c.key, c.label);
  for (const f of b.floats) addFloat(out.floats, f.providerId, f.label);
  return out;
}

/** Counted again: what is left to count, or null when nothing is. The counts of what moved go with the last one. */
export function withoutRecounted(moved: MovedAfterCount | null, recounted: { channels: readonly string[]; floats: readonly string[] }): MovedAfterCount | null {
  if (!moved) return null;
  const channels = moved.channels.filter((c) => !recounted.channels.includes(c.key));
  const floats = moved.floats.filter((f) => !recounted.floats.includes(f.providerId));
  return channels.length > 0 || floats.length > 0 ? { ...moved, channels, floats } : null;
}

/** The catalogue keys of what was recorded since the count, each worded for one too; nothing at all says nothing. */
export function movedSinceKeys(moved: Pick<MovedAfterCount, 'exchanges' | 'reversals' | 'rebalancings'>): { key: string; count: number }[] {
  return (['exchanges', 'reversals', 'rebalancings'] as const)
    .filter((k) => moved[k] > 0)
    .map((k) => ({ key: moved[k] === 1 ? `closing.moved.${k}.one` : `closing.moved.${k}`, count: moved[k] }));
}
