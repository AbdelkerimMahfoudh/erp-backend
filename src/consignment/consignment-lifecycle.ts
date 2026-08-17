import type { Side } from './consignment-scope';

/**
 * What may happen next, and who may do it (Milestone H, H-CP3).
 *
 * Fifteen internal states, grouped into three for the UI. The record keeps the
 * distinctions the screens collapse, because "they accepted" and "the phone is
 * physically in their shop" are different facts, and treating them as one is
 * how a shop ends up believing stock moved when it did not.
 *
 * Written as a table rather than a chain of `if`s so that the whole machine can
 * be read at once — a lifecycle nobody can see the shape of is one where an
 * illegal transition hides for months.
 */

export type ConsignmentStatus =
  | 'draft'
  | 'requested'
  | 'counter_proposed'
  | 'disputed'
  | 'accepted_awaiting_custody'
  | 'custody_awaiting_confirmation'
  | 'in_custody'
  | 'sold_awaiting_settlement'
  | 'partially_paid'
  | 'return_initiated'
  | 'return_in_transit'
  | 'settled'
  | 'returned_accepted'
  | 'forgiven_settled'
  | 'cancelled';

/** The three groups the screens show. */
export type StatusGroup = 'pending' | 'accepted' | 'confirmed';

/**
 * **Confirmed means the money arrived or the phone came back.** Accepting a
 * proposal is not confirmation, and a shop reading "confirmed" must never
 * discover it only meant somebody said yes.
 */
export const GROUP_OF: Record<ConsignmentStatus, StatusGroup> = {
  draft: 'pending',
  requested: 'pending',
  counter_proposed: 'pending',
  disputed: 'pending',
  accepted_awaiting_custody: 'pending',
  custody_awaiting_confirmation: 'pending',

  in_custody: 'accepted',
  sold_awaiting_settlement: 'accepted',
  partially_paid: 'accepted',
  return_initiated: 'accepted',
  return_in_transit: 'accepted',

  settled: 'confirmed',
  returned_accepted: 'confirmed',
  forgiven_settled: 'confirmed',
  cancelled: 'confirmed',
};

export type Action =
  | 'submit'
  | 'accept'
  | 'counter'
  | 'dispute'
  | 'reject'
  | 'cancel'
  | 'send_custody'
  | 'confirm_custody'
  | 'report_sold'
  | 'record_payment'
  | 'settle'
  | 'initiate_return'
  | 'ship_return'
  | 'confirm_return'
  | 'forgive';

interface Rule {
  from: ConsignmentStatus[];
  to: ConsignmentStatus;
  /** Which side of the deal may do this. */
  by: Side | 'either';
}

/**
 * The whole machine.
 *
 * `by` is the half that is easy to get wrong and expensive to get wrong: the
 * destination accepting its own counter-offer, or the source confirming its own
 * custody hand-over, would each let one party complete a two-party deal alone.
 */
export const TRANSITIONS: Record<Action, Rule> = {
  // The source builds and sends the proposal.
  submit: { from: ['draft'], to: 'requested', by: 'source' },

  /**
   * Either side can accept, but never their own last word — `assertTransition`
   * checks that separately, because the legal FROM state differs depending on
   * who spoke last.
   */
  accept: {
    from: ['requested', 'counter_proposed', 'disputed'],
    to: 'accepted_awaiting_custody',
    by: 'either',
  },
  counter: {
    from: ['requested', 'counter_proposed', 'disputed'],
    to: 'counter_proposed',
    by: 'either',
  },
  /** A dispute must carry a reason; the service enforces that. */
  dispute: { from: ['requested', 'counter_proposed'], to: 'disputed', by: 'either' },
  reject: { from: ['requested', 'counter_proposed', 'disputed'], to: 'cancelled', by: 'destination' },

  /**
   * Cancelling is possible only BEFORE custody. Once the phone is in the other
   * shop, walking away is a return — which is a different, physical process
   * with its own confirmation.
   */
  cancel: {
    from: ['draft', 'requested', 'counter_proposed', 'disputed', 'accepted_awaiting_custody'],
    to: 'cancelled',
    by: 'source',
  },

  send_custody: {
    from: ['accepted_awaiting_custody'],
    to: 'custody_awaiting_confirmation',
    by: 'source',
  },
  /** Only the receiver can say the phone arrived. */
  confirm_custody: { from: ['custody_awaiting_confirmation'], to: 'in_custody', by: 'destination' },

  /** Only the holder knows it sold. */
  report_sold: { from: ['in_custody'], to: 'sold_awaiting_settlement', by: 'destination' },

  record_payment: {
    from: ['sold_awaiting_settlement', 'partially_paid'],
    to: 'partially_paid',
    by: 'either',
  },
  settle: { from: ['sold_awaiting_settlement', 'partially_paid'], to: 'settled', by: 'either' },

  /** The holder starts a return; only the owner can accept the phone back. */
  initiate_return: { from: ['in_custody'], to: 'return_initiated', by: 'destination' },
  ship_return: { from: ['return_initiated'], to: 'return_in_transit', by: 'destination' },
  confirm_return: { from: ['return_in_transit', 'return_initiated'], to: 'returned_accepted', by: 'source' },

  /** Only the creditor may write off what it is owed. */
  forgive: {
    from: ['sold_awaiting_settlement', 'partially_paid'],
    to: 'forgiven_settled',
    by: 'source',
  },
};

export class TransitionRefused extends Error {}

const refuse = (m: string): never => {
  throw new TransitionRefused(m);
};

/**
 * Whether this side may take this action from this state.
 *
 * `lastProposalBy` exists for one reason: a party must not accept their own
 * offer. Without it, the source could propose and immediately "accept",
 * producing an agreed amount the destination never saw.
 */
export function assertTransition(input: {
  action: Action;
  from: ConsignmentStatus;
  side: Side;
  /** Who made the offer currently on the table. */
  lastProposalBy?: Side | null;
}): ConsignmentStatus {
  const rule = TRANSITIONS[input.action];
  if (!rule) refuse('That is not something you can do to a consignment');

  if (!rule.from.includes(input.from)) {
    refuse(`That cannot be done while the consignment is ${readable(input.from)}`);
  }
  if (rule.by !== 'either' && rule.by !== input.side) {
    refuse(
      rule.by === 'source'
        ? 'Only the sending store can do that'
        : 'Only the receiving store can do that',
    );
  }

  if ((input.action === 'accept' || input.action === 'counter') && input.lastProposalBy) {
    /**
     * You cannot accept or counter your own offer. Accepting it would let one
     * party set the price alone; countering it would be an edit disguised as a
     * negotiation, and the other side would see two offers in a row with no
     * chance to answer the first.
     */
    if (input.lastProposalBy === input.side) {
      refuse('You are waiting on the other store to answer your offer');
    }
  }

  return rule.to;
}

/** Whether the agreed amount can still change. */
export function amountIsMutable(status: ConsignmentStatus): boolean {
  /**
   * Frozen at custody confirmation. After that the phone is in somebody else's
   * shop, and a price that could still move would let the owner raise it after
   * delivery — the exact leverage this workflow exists to remove.
   */
  return ['draft', 'requested', 'counter_proposed', 'disputed', 'accepted_awaiting_custody'].includes(
    status,
  );
}

/** Whether a unit is still physically ours and unsold. */
export function isReturnable(status: ConsignmentStatus): boolean {
  return ['in_custody', 'return_initiated', 'return_in_transit'].includes(status);
}

export interface IdentifierCheck {
  expected: string;
  scanned: string;
}

/**
 * Confirming custody must match the phone that was actually sent.
 *
 * A mismatch is refused and BOTH values are reported. Silently adopting the
 * scanned identifier would rewrite what the two shops agreed to, and the owner
 * would discover months later that the phone they are owed for is not the phone
 * they sent.
 */
export function assertIdentifierMatches({ expected, scanned }: IdentifierCheck): void {
  const norm = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
  if (norm(expected) !== norm(scanned)) {
    refuse(`That is not the phone that was sent. Expected ${expected}, scanned ${scanned}`);
  }
}

/** Plain wording for a state, for messages a shopkeeper reads. */
export function readable(status: ConsignmentStatus): string {
  switch (status) {
    case 'draft':
      return 'still a draft';
    case 'requested':
      return 'waiting for an answer';
    case 'counter_proposed':
      return 'waiting on a counter-offer';
    case 'disputed':
      return 'disputed';
    case 'accepted_awaiting_custody':
      return 'agreed but not yet handed over';
    case 'custody_awaiting_confirmation':
      return 'on its way';
    case 'in_custody':
      return 'held by the other store';
    case 'sold_awaiting_settlement':
      return 'sold and awaiting payment';
    case 'partially_paid':
      return 'part paid';
    case 'return_initiated':
      return 'being returned';
    case 'return_in_transit':
      return 'on its way back';
    case 'settled':
      return 'settled';
    case 'returned_accepted':
      return 'returned';
    case 'forgiven_settled':
      return 'written off';
    case 'cancelled':
      return 'cancelled';
  }
}
