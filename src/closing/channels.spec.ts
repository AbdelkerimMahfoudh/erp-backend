import {
  buildChannels,
  countingComplete,
  isCountable,
  moneyByMethod,
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
      correctionsOut: -1,
      // D154 (docs/73 §4.5): the agent counter's cash is the drawer's — received for credit sent it is added,
      // given for credit received it is subtracted, in the one table every path reads.
      agentIn: 1,
      agentOut: -1,
    });
  });

  it('the agent counter’s cash enters the drawer’s expected figure, and only the drawer’s (D154)', () => {
    const rows = buildChannels(
      [
        move('cash', null, 'salesIn', 10000),
        move('cash', null, 'agentIn', 20200),
        move('cash', null, 'agentOut', 15000),
        move('account', 'bankily', 'salesIn', 4000),
      ],
      [{ id: 'bankily', label: 'Bankily', isActive: true, sortOrder: 1 }],
      1000,
    );
    const cash = rows.find((r) => r.channel === 'cash')!;
    expect(cash).toMatchObject({ agentIn: 20200, agentOut: 15000, expected: 1000 + 10000 + 20200 - 15000 });
    expect(rows.find((r) => r.accountId === 'bankily')).toMatchObject({ agentIn: 0, agentOut: 0, expected: 4000 });
    // Money by method counts them as the drawer's in and out, on the same basis as a sale's cash.
    expect(moneyByMethod(rows).channels[0]).toMatchObject({ moneyIn: 30200, moneyOut: 15000, net: 15200 });
  });

  it('a payment reclassified to another channel moves between channels and leaves the total alone (0078)', () => {
    const rows = buildChannels(
      [
        move('cash', null, 'salesIn', 10000),
        move('cash', null, 'correctionsOut', 4000),
        move('account', 'bankily', 'correctionsIn', 4000),
      ],
      [{ id: 'bankily', label: 'Bankily', isActive: true, sortOrder: 1 }],
    );
    const cash = rows.find((r) => r.channel === 'cash')!;
    const bankily = rows.find((r) => r.accountId === 'bankily')!;
    expect(cash.expected).toBe(6000);
    expect(bankily.expected).toBe(4000);
    expect(cash.expected + bankily.expected).toBe(10000);
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

describe('money by method — the Money tab card (2026-09-27)', () => {
  const accounts = [account('b', 'Bankily – Main Counter', { sortOrder: 1 }), account('m', 'Masrvi', { sortOrder: 0 }), account('z', 'Sedad', { sortOrder: 2 })];
  const moves = [
    move('cash', null, 'salesIn', 3900),
    move('cash', null, 'expensesOut', 500),
    move('account', 'b', 'salesIn', 2000),
    move('account', 'm', 'salesIn', 1600),
  ];

  it('lists every configured method — cash and each active account, one without movement at 0 — with in, out and net', () => {
    const { channels } = moneyByMethod(buildChannels(moves, accounts));
    expect(channels.map((c) => [c.label, c.moneyIn, c.moneyOut, c.net])).toEqual([
      [CASH_LABEL, 3900, 500, 3400],
      ['Masrvi', 1600, 0, 1600],
      ['Bankily – Main Counter', 2000, 0, 2000],
      ['Sedad', 0, 0, 0],
    ]);
  });

  it('totals exactly the rows it returns: 3 400 + 1 600 + 2 000 + 0 = 7 000', () => {
    const { channels, total } = moneyByMethod(buildChannels(moves, accounts));
    expect(total).toEqual({ moneyIn: 7500, moneyOut: 500, net: 7000 });
    expect(total.net).toBe(channels.reduce((s, c) => s + c.net, 0));
  });

  it('never mixes in the drawer’s opening: the basis is the same recorded movement for cash and every account', () => {
    const withOpening = buildChannels(moves, accounts, 12_000);
    expect(withOpening[0].expected).toBe(15_400);
    const { channels, total } = moneyByMethod(withOpening);
    expect(channels[0].net).toBe(3400);
    expect(total.net).toBe(7000);
  });
});

describe('an amount set when the shop opened (docs/63)', () => {
  it('moves the drawer’s expected figure by its own term, kept apart from the opening and from the movement', () => {
    const rows = buildChannels([{ channel: 'cash', accountId: null, component: 'salesIn', amount: 500 }], [], 3400, -400);
    const cash = rows.find((r) => r.channel === 'cash')!;
    expect(cash).toMatchObject({ openingBalance: 3400, setAdjustment: -400, salesIn: 500, expected: 3500 });
  });

  it('is cash only: an account never carries one, and no term means nothing changes', () => {
    const rows = buildChannels([], [{ id: 'a1', label: 'Bankily', isActive: true, sortOrder: 1 }], 3400);
    expect(rows.map((r) => r.setAdjustment)).toEqual([0, 0]);
    expect(rows.find((r) => r.channel === 'cash')!.expected).toBe(3400);
  });

  it('never reaches the day’s money in and out: movement stays movement', () => {
    const rows = buildChannels([{ channel: 'cash', accountId: null, component: 'salesIn', amount: 500 }], [], 3400, -400);
    expect(moneyByMethod(rows).total).toEqual({ moneyIn: 500, moneyOut: 0, net: 500 });
  });
});
