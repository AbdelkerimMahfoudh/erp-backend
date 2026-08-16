import {
  buildChannels,
  countingComplete,
  isCountable,
  CASH_LABEL,
  COMPONENT_SIGN,
  UNATTRIBUTED_LABEL,
  type AccountRow,
  type MovementRow,
} from './channels';

/**
 * The per-channel reconciliation (E-CP1).
 *
 * `reconciliation.spec.ts` pins the cash equation. This pins the property that
 * matters just as much: **the per-channel path is the same equation**, not a
 * second one that happens to look similar. Two equations for the same question
 * is exactly how the five separate cash fixes happened in the first place.
 */

const account = (id: string, label: string, over: Partial<AccountRow> = {}): AccountRow => ({
  id,
  label,
  isActive: true,
  sortOrder: 0,
  ...over,
});

const move = (
  channel: 'cash' | 'account',
  accountId: string | null,
  component: MovementRow['component'],
  amount: number,
): MovementRow => ({ channel, accountId, component, amount });

describe('the signs match the cash equation exactly', () => {
  /**
   * If somebody changes a sign here, the per-channel figure silently disagrees
   * with the till figure for the same movement. This is the assertion that
   * makes that impossible to do quietly.
   */
  it('money in is added, money out is subtracted', () => {
    expect(COMPONENT_SIGN).toEqual({
      salesIn: 1,
      refundsOut: -1,
      supplierOut: -1,
      expensesOut: -1,
      correctionsIn: 1,
    });
  });

  it('a channel with every movement computes the same expression the till does', () => {
    const rows = buildChannels(
      [
        move('cash', null, 'salesIn', 1000),
        move('cash', null, 'refundsOut', 100),
        move('cash', null, 'supplierOut', 200),
        move('cash', null, 'expensesOut', 50),
        move('cash', null, 'correctionsIn', 30),
      ],
      [],
    );
    // 1000 − 100 − 200 − 50 + 30
    expect(rows[0].expected).toBe(680);
  });
});

describe('which channels have to be counted', () => {
  it('cash is always there, even on a day with no movement at all', () => {
    const rows = buildChannels([], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('cash');
    expect(rows[0].expected).toBe(0);
  });

  it('an active account with no movement is still counted — that is the point', () => {
    const rows = buildChannels([], [account('a1', 'Bankily – Counter')]);
    const bankily = rows.find((r) => r.accountId === 'a1');
    expect(bankily).toBeDefined();
    expect(bankily!.expected).toBe(0);
  });

  it('a DEACTIVATED account that moved money today is still counted', () => {
    /**
     * Otherwise deactivating an account would be a way to stop reconciling it,
     * which is precisely what somebody hiding a shortage would do.
     */
    const rows = buildChannels(
      [move('account', 'old', 'salesIn', 500)],
      [account('old', 'Masrivi – Closed', { isActive: false })],
    );
    expect(rows.find((r) => r.accountId === 'old')?.expected).toBe(500);
  });

  it('a deactivated account with no movement is dropped', () => {
    const rows = buildChannels([], [account('old', 'Masrivi – Closed', { isActive: false })]);
    expect(rows.map((r) => r.accountId)).toEqual([null]);
  });

  it('the unattributed bucket appears only when money actually landed in it', () => {
    expect(buildChannels([], []).some((r) => r.isUnattributed)).toBe(false);
    const rows = buildChannels([move('account', null, 'salesIn', 250)], []);
    const bucket = rows.find((r) => r.isUnattributed);
    expect(bucket?.expected).toBe(250);
    expect(bucket?.labelSnapshot).toBe(UNATTRIBUTED_LABEL);
  });

  it('unattributed money is never folded into a real account', () => {
    /**
     * Guessing which account a payment from before 0045 reached would be
     * fabricating a financial record. It is reported on its own instead.
     */
    const rows = buildChannels(
      [move('account', null, 'salesIn', 250), move('account', 'a1', 'salesIn', 100)],
      [account('a1', 'Bankily')],
    );
    expect(rows.find((r) => r.accountId === 'a1')!.expected).toBe(100);
    expect(rows.find((r) => r.isUnattributed)!.expected).toBe(250);
  });
});

describe('labels are machine keys, never English in the database', () => {
  it('cash and unattributed use sentinels the client translates', () => {
    const rows = buildChannels([move('account', null, 'salesIn', 1)], []);
    expect(rows.find((r) => r.channel === 'cash')!.labelSnapshot).toBe(CASH_LABEL);
    expect(rows.find((r) => r.isUnattributed)!.labelSnapshot).toBe(UNATTRIBUTED_LABEL);
  });

  it("a real account snapshots the shop's own label", () => {
    const rows = buildChannels([], [account('a1', 'Bankily – Main Counter')]);
    expect(rows.find((r) => r.accountId === 'a1')!.labelSnapshot).toBe('Bankily – Main Counter');
  });
});

describe('cash never belongs to an account', () => {
  it('a cash movement tagged with an account still lands in the drawer', () => {
    /**
     * `ck_payments_cash_no_account` refuses this at the database. Agreeing with
     * it here means the code can never produce a figure the schema could not
     * have stored.
     */
    const rows = buildChannels([move('cash', 'a1', 'salesIn', 400)], [account('a1', 'Bankily')]);
    expect(rows.find((r) => r.channel === 'cash')!.expected).toBe(400);
    expect(rows.find((r) => r.accountId === 'a1')!.expected).toBe(0);
  });
});

describe('the order somebody counts in', () => {
  it('cash first, then the accounts as the shop arranged them, unattributed last', () => {
    const rows = buildChannels(
      [move('account', null, 'salesIn', 5)],
      [account('b', 'Second', { sortOrder: 2 }), account('a', 'First', { sortOrder: 1 })],
    );
    expect(rows.map((r) => r.labelSnapshot)).toEqual(['CASH', 'First', 'Second', 'UNATTRIBUTED']);
  });
});

describe('counting is finished only when nothing is outstanding', () => {
  it('a channel nobody touched keeps the day open', () => {
    expect(
      countingComplete([
        { isUnattributed: false, counted: 500, isSkipped: false },
        { isUnattributed: false, counted: null, isSkipped: false },
      ]),
    ).toBe(false);
  });

  it('a recorded skip closes a channel; silence does not', () => {
    expect(
      countingComplete([
        { isUnattributed: false, counted: 500, isSkipped: false },
        { isUnattributed: false, counted: null, isSkipped: true },
      ]),
    ).toBe(true);
  });

  it('a count of zero is a count, not a missing one', () => {
    expect(countingComplete([{ isUnattributed: false, counted: 0, isSkipped: false }])).toBe(true);
  });

  it('the unattributed bucket never blocks the day, because it cannot be counted', () => {
    expect(isCountable({ isUnattributed: true })).toBe(false);
    expect(
      countingComplete([
        { isUnattributed: false, counted: 100, isSkipped: false },
        { isUnattributed: true, counted: null, isSkipped: false },
      ]),
    ).toBe(true);
  });
});
