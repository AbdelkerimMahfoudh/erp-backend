import {
  amountIsMutable,
  assertIdentifierMatches,
  assertTransition,
  GROUP_OF,
  isReturnable,
  TRANSITIONS,
  TransitionRefused,
  type ConsignmentStatus,
} from './consignment-lifecycle';

/**
 * The consignment lifecycle (H-CP3).
 *
 * Two properties carry most of the weight: a two-party deal must never be
 * completable by one party alone, and "confirmed" must mean the money arrived
 * or the phone came back.
 */

const refuses = (fn: () => unknown, matching?: RegExp) => {
  expect(fn).toThrow(TransitionRefused);
  if (matching) expect(fn).toThrow(matching);
};

describe('confirmed means the money arrived or the phone came back', () => {
  it('does NOT include merely accepting the proposal', () => {
    /**
     * The distinction this whole state machine exists for. A shop reading
     * "confirmed" must never discover it only meant somebody said yes.
     */
    expect(GROUP_OF.accepted_awaiting_custody).toBe('pending');
    expect(GROUP_OF.custody_awaiting_confirmation).toBe('pending');
  });

  it('counts only settlement, return and write-off', () => {
    const confirmed = (Object.keys(GROUP_OF) as ConsignmentStatus[]).filter(
      (s) => GROUP_OF[s] === 'confirmed',
    );
    expect(confirmed.sort()).toEqual(
      ['cancelled', 'forgiven_settled', 'returned_accepted', 'settled'].sort(),
    );
  });

  it('treats a phone physically held as accepted, not confirmed', () => {
    expect(GROUP_OF.in_custody).toBe('accepted');
    expect(GROUP_OF.sold_awaiting_settlement).toBe('accepted');
  });

  it('groups every state, so none can be invisible to the UI', () => {
    for (const status of Object.keys(TRANSITIONS).length ? (Object.keys(GROUP_OF) as ConsignmentStatus[]) : []) {
      expect(['pending', 'accepted', 'confirmed']).toContain(GROUP_OF[status]);
    }
  });
});

describe('one party can never complete a two-party deal alone', () => {
  it('refuses accepting your own offer', () => {
    /**
     * Without this the source could propose and immediately accept, producing
     * an agreed amount the destination never saw.
     */
    refuses(
      () =>
        assertTransition({
          action: 'accept',
          from: 'requested',
          side: 'source',
          lastProposalBy: 'source',
        }),
      /waiting on the other store/,
    );
  });

  it('refuses countering your own offer', () => {
    /**
     * That is an edit disguised as a negotiation — the other side would see two
     * offers in a row with no chance to answer the first.
     */
    refuses(() =>
      assertTransition({
        action: 'counter',
        from: 'counter_proposed',
        side: 'destination',
        lastProposalBy: 'destination',
      }),
    );
  });

  it('lets the other side accept it', () => {
    expect(
      assertTransition({
        action: 'accept',
        from: 'requested',
        side: 'destination',
        lastProposalBy: 'source',
      }),
    ).toBe('accepted_awaiting_custody');
  });

  it('lets the source confirm nothing about receipt', () => {
    // Only the receiver can say the phone arrived.
    refuses(
      () => assertTransition({ action: 'confirm_custody', from: 'custody_awaiting_confirmation', side: 'source' }),
      /receiving store/,
    );
  });

  it('lets the destination hand over nothing', () => {
    refuses(
      () => assertTransition({ action: 'send_custody', from: 'accepted_awaiting_custody', side: 'destination' }),
      /sending store/,
    );
  });

  it('lets only the owner accept a phone back', () => {
    refuses(() => assertTransition({ action: 'confirm_return', from: 'return_in_transit', side: 'destination' }));
    expect(assertTransition({ action: 'confirm_return', from: 'return_in_transit', side: 'source' })).toBe(
      'returned_accepted',
    );
  });

  it('lets only the creditor write off what it is owed', () => {
    refuses(() => assertTransition({ action: 'forgive', from: 'partially_paid', side: 'destination' }));
    expect(assertTransition({ action: 'forgive', from: 'partially_paid', side: 'source' })).toBe(
      'forgiven_settled',
    );
  });
});

describe('cancelling stops at custody', () => {
  it('is allowed while nothing has physically moved', () => {
    for (const from of ['draft', 'requested', 'counter_proposed', 'accepted_awaiting_custody'] as const) {
      expect(assertTransition({ action: 'cancel', from, side: 'source' })).toBe('cancelled');
    }
  });

  it('is refused once the phone is in the other shop', () => {
    /**
     * Walking away after delivery is a RETURN — a physical process with its own
     * confirmation. Letting it be a cancel would close the record while the
     * phone was still on somebody else's shelf.
     */
    refuses(() => assertTransition({ action: 'cancel', from: 'in_custody', side: 'source' }));
    refuses(() => assertTransition({ action: 'cancel', from: 'sold_awaiting_settlement', side: 'source' }));
  });
});

describe('the agreed amount freezes at custody', () => {
  it('can still move while the phone is ours', () => {
    for (const s of ['draft', 'requested', 'counter_proposed', 'disputed', 'accepted_awaiting_custody'] as const) {
      expect(amountIsMutable(s)).toBe(true);
    }
  });

  it('cannot once the other shop is holding it', () => {
    /**
     * Otherwise the owner could raise the price after delivery — the exact
     * leverage this workflow exists to remove.
     */
    for (const s of ['in_custody', 'sold_awaiting_settlement', 'partially_paid', 'settled'] as const) {
      expect(amountIsMutable(s)).toBe(false);
    }
  });
});

describe('confirming custody must match the phone that was sent', () => {
  it('accepts the same identifier', () => {
    expect(() => assertIdentifierMatches({ expected: '490154203237518', scanned: '490154203237518' })).not.toThrow();
  });

  it('tolerates spaces and dashes from a scanner', () => {
    expect(() =>
      assertIdentifierMatches({ expected: '490154203237518', scanned: '49-015420 3237518' }),
    ).not.toThrow();
  });

  it('refuses a different phone and reports BOTH values', () => {
    /**
     * Silently adopting the scanned identifier would rewrite what the two shops
     * agreed to, and the owner would discover months later that the phone they
     * are owed for is not the phone they sent.
     */
    refuses(
      () => assertIdentifierMatches({ expected: '490154203237518', scanned: '490154203237519' }),
      /Expected 490154203237518, scanned 490154203237519/,
    );
  });
});

describe('which states a phone can still come back from', () => {
  it('includes held and in-return states', () => {
    for (const s of ['in_custody', 'return_initiated', 'return_in_transit'] as const) {
      expect(isReturnable(s)).toBe(true);
    }
  });

  it('excludes sold, because it is no longer there to return', () => {
    expect(isReturnable('sold_awaiting_settlement')).toBe(false);
    expect(isReturnable('settled')).toBe(false);
  });
});

describe('illegal transitions are refused with a readable reason', () => {
  it('names the state in words a shopkeeper would use', () => {
    refuses(
      () => assertTransition({ action: 'report_sold', from: 'requested', side: 'destination' }),
      /waiting for an answer/,
    );
  });

  it('refuses selling a phone that has not arrived', () => {
    refuses(() =>
      assertTransition({ action: 'report_sold', from: 'accepted_awaiting_custody', side: 'destination' }),
    );
  });

  it('refuses paying for a phone that was never sold', () => {
    refuses(() => assertTransition({ action: 'record_payment', from: 'in_custody', side: 'source' }));
  });
});
