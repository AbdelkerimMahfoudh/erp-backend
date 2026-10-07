import { BadRequestException } from '@nestjs/common';
import { buildChannels, moneyByMethod, type AccountRow, type MovementRow } from './channels';
import {
  accountMethod,
  anchorFingerprint,
  assertAnchorAmount,
  cashDayRows,
  cashMethod,
  movementOf,
  movementWindow,
  trackedMoney,
  type CountedClose,
  type DeclaredAnchor,
  type DrawerInputs,
} from './money-positions';

/**
 * Tracked money held per method (Money's top card).
 *
 * A position is an anchor plus what moved after it, carried across midnight.
 * These pin the user's own example — 3 400 in the drawer and 3 600 in the
 * accounts at night are still 7 000 the next morning — and the refusals that
 * keep it honest: no invented opening, no day's net read as a position, and an
 * unknown method shown as unknown, with no total over it.
 */

/** No movement on the day: the drawer's figure alone is under test. */
const NO_MOVE = movementOf('2026-09-26', []);

const BANKILY = '01a0b1c2-0000-7000-8000-00000000000b';
const MASRVI = '01a0b1c2-0000-7000-8000-00000000000c';
const RETIRED = '01a0b1c2-0000-7000-8000-00000000000d';

const account = (id: string, label: string, sortOrder: number, isActive = true): AccountRow => ({ id, label, sortOrder, isActive });
const accounts = [account(BANKILY, 'Bankily', 1), account(MASRVI, 'Masrvi', 2)];

const move = (accountId: string, component: MovementRow['component'], amount: number): MovementRow => ({
  channel: 'account',
  accountId,
  component,
  amount,
});

const declared = (accountId: string, amount: number, at: string, businessDate: string): DeclaredAnchor => ({
  accountId,
  amount,
  at: new Date(at),
  businessDate,
  byName: 'Owner',
});

/** Day 1 closed with its drawer counted at 0. */
const day1Close: CountedClose = { closingDate: '2026-09-25', countedCash: 0, at: new Date('2026-09-25T22:10:00Z'), byName: 'Aicha' };

/** Both accounts recorded at 0 at 06:30 on day 2. */
const morningAnchors = [
  declared(BANKILY, 0, '2026-09-26T06:30:00Z', '2026-09-26'),
  declared(MASRVI, 0, '2026-09-26T06:30:00Z', '2026-09-26'),
];

/** Day 2 took 2 000 into Bankily and 1 600 into Masrvi after those anchors. */
const day2Accounts = [move(BANKILY, 'salesIn', 2000), move(MASRVI, 'salesIn', 1600)];

const card = (
  over: {
    asOf?: string;
    businessDate?: string;
    drawer?: Partial<DrawerInputs>;
    accounts?: AccountRow[];
    anchors?: DeclaredAnchor[];
    movements?: MovementRow[];
    withMovement?: string[];
    accountsVisible?: boolean;
    dayMovements?: MovementRow[];
  } = {},
) =>
  trackedMoney({
    asOf: new Date(over.asOf ?? '2026-09-26T23:00:00Z'),
    businessDate: over.businessDate ?? '2026-09-26',
    branchCount: 1,
    drawer: { countedToday: null, openingAnchor: day1Close, expected: 3400, ...over.drawer },
    accounts: over.accounts ?? accounts,
    anchors: over.anchors ?? morningAnchors,
    movements: over.movements ?? day2Accounts,
    withMovement: new Set(over.withMovement ?? []),
    accountsVisible: over.accountsVisible ?? true,
    dayMovements: over.dayMovements ?? [],
  });

const positions = (c: ReturnType<typeof card>) => c.methods.map((m) => [m.key, m.position]);

describe('carried across midnight — the overnight case', () => {
  it('at 23:00 on day 2: cash 3 400, Bankily 2 000, Masrvi 1 600, total 7 000', () => {
    const night = card();
    expect(positions(night)).toEqual([
      ['cash', 3400],
      [`account:${BANKILY}`, 2000],
      [`account:${MASRVI}`, 1600],
    ]);
    expect(night.total).toBe(7000);
    expect(night.unknownKeys).toEqual([]);
    expect(night.basis).toBe('anchor_plus_recorded_movement');
  });

  it('at 07:00 on day 3 with nothing moved: still 7 000, while the day’s movement is 0', () => {
    /*
     * Day 3's drawer figure is day 1's count carried by day 2's 3 400 — the
     * closing's own opening. The accounts' windows run from their anchors, not
     * from midnight, so the same 2 000 and 1 600 are still there.
     */
    const morning = card({ asOf: '2026-09-27T07:00:00Z', businessDate: '2026-09-27', drawer: { expected: 3400 } });
    expect(morning.total).toBe(7000);
    expect(morning.businessDate).toBe('2026-09-27');
    expect(morning.asOf).toBe('2026-09-27T07:00:00.000Z');

    const moneyToday = moneyByMethod(buildChannels([], accounts));
    expect(moneyToday.total.net).toBe(0);
    expect(moneyToday.channels.map((c) => c.net)).toEqual([0, 0, 0]);
  });

  it('each method says what it rests on: the drawer on day 1’s count, an account on the Owner’s record', () => {
    const [cash, bankily] = card().methods;
    expect(cash).toEqual({
      key: 'cash',
      channel: 'cash',
      accountId: null,
      label: '',
      scope: 'branch',
      isActive: true,
      known: true,
      position: 3400,
      unknownReason: null,
      anchor: { source: 'counted_close', amount: 0, at: '2026-09-25T22:10:00.000Z', businessDate: '2026-09-25', byName: 'Aicha' },
      sinceAnchorNet: 3400,
      movement: { businessDate: '2026-09-26', inflows: 0, outflows: 0, net: 0 },
    });
    expect(bankily).toEqual({
      key: `account:${BANKILY}`,
      channel: 'account',
      accountId: BANKILY,
      label: 'Bankily',
      scope: 'company',
      isActive: true,
      known: true,
      position: 2000,
      unknownReason: null,
      anchor: { source: 'declared', amount: 0, at: '2026-09-26T06:30:00.000Z', businessDate: '2026-09-26', byName: 'Owner' },
      sinceAnchorNet: 2000,
      movement: { businessDate: '2026-09-26', inflows: 0, outflows: 0, net: 0 },
    });
  });
});

describe('unknown is unknown, never 0', () => {
  it('an account nobody recorded is unknown, and there is no total', () => {
    const c = card({ anchors: [morningAnchors[0]] });
    const masrvi = c.methods.find((m) => m.accountId === MASRVI)!;
    expect(masrvi).toMatchObject({ known: false, position: null, unknownReason: 'no_anchor', anchor: null, sinceAnchorNet: null });
    // Its 1 600 of movement is not a position: without an anchor nobody knows what it started from.
    expect(masrvi.position).not.toBe(0);
    expect(masrvi.position).not.toBe(1600);
    expect(c.total).toBeNull();
    expect(c.unknownKeys).toEqual([`account:${MASRVI}`]);
    // The known ones are still shown.
    expect(c.methods.find((m) => m.accountId === BANKILY)!.position).toBe(2000);
  });

  it('a drawer never counted at a locked close is unknown — its figure from a 0 start is not what it holds', () => {
    const c = card({ drawer: { openingAnchor: null, expected: 3400 } });
    expect(c.methods[0]).toMatchObject({ key: 'cash', known: false, position: null, unknownReason: 'no_counted_close', anchor: null, sinceAnchorNet: null });
    expect(c.total).toBeNull();
    expect(c.unknownKeys).toEqual(['cash']);
  });

  it('everything unknown lists every key, cash first', () => {
    const c = card({ drawer: { openingAnchor: null }, anchors: [] });
    expect(c.unknownKeys).toEqual(['cash', `account:${BANKILY}`, `account:${MASRVI}`]);
    expect(c.methods.every((m) => m.position === null)).toBe(true);
  });
});

describe('the drawer', () => {
  it('a current day locked with its drawer counted holds what was counted, not what was expected', () => {
    const today: CountedClose = { closingDate: '2026-09-26', countedCash: 3350, at: new Date('2026-09-26T21:40:00Z'), byName: 'Aicha' };
    const cash = cashMethod({ countedToday: today, openingAnchor: day1Close, expected: 3400 }, NO_MOVE);
    expect(cash).toMatchObject({
      known: true,
      position: 3350,
      anchor: { source: 'counted_close', amount: 3350, businessDate: '2026-09-26', at: '2026-09-26T21:40:00.000Z', byName: 'Aicha' },
      sinceAnchorNet: 0,
    });
  });

  it('otherwise it is the closing’s expected figure, measured from the counted close it is carried from', () => {
    const cash = cashMethod({ countedToday: null, openingAnchor: { ...day1Close, countedCash: 1000 }, expected: 4400 }, NO_MOVE);
    expect(cash).toMatchObject({ known: true, position: 4400, anchor: { amount: 1000, businessDate: '2026-09-25' }, sinceAnchorNet: 3400 });
  });

  it('a counted close that recorded no time still anchors, with no instant', () => {
    const cash = cashMethod({ countedToday: null, openingAnchor: { ...day1Close, at: null }, expected: 0 }, NO_MOVE);
    expect(cash.anchor).toMatchObject({ at: null, amount: 0 });
  });
});

describe('an account: its anchor plus what moved after it, with the closing’s signs', () => {
  it('a correction leg after the anchor moves both accounts and leaves the total alone', () => {
    // 500 recorded into Bankily really reached Masrvi (0078): out of one, into the other.
    const c = card({ movements: [...day2Accounts, move(BANKILY, 'correctionsOut', 500), move(MASRVI, 'correctionsIn', 500)] });
    expect(positions(c)).toEqual([
      ['cash', 3400],
      [`account:${BANKILY}`, 1500],
      [`account:${MASRVI}`, 2100],
    ]);
    expect(c.total).toBe(7000);
  });

  it('money out — a refund, a supplier, an expense — comes off, exactly as the closing takes it off', () => {
    const c = card({
      movements: [...day2Accounts, move(BANKILY, 'refundsOut', 100), move(BANKILY, 'supplierOut', 250), move(BANKILY, 'expensesOut', 50)],
    });
    expect(c.methods[1]).toMatchObject({ position: 1600, sinceAnchorNet: 1600 });
  });

  it('re-anchoring: the latest record is where the position starts again', () => {
    // At 18:00 the provider showed 1 500 where the app tracked 2 000; 300 arrived after.
    const later = declared(BANKILY, 1500, '2026-09-26T18:00:00Z', '2026-09-26');
    const c = card({ anchors: [later, morningAnchors[1]], movements: [move(BANKILY, 'salesIn', 300), move(MASRVI, 'salesIn', 1600)] });
    expect(c.methods[1]).toMatchObject({
      position: 1800,
      anchor: { amount: 1500, at: '2026-09-26T18:00:00.000Z' },
      sinceAnchorNet: 300,
    });
    expect(c.total).toBe(3400 + 1800 + 1600);
  });

  it('a movement of another account, or of cash, never lands in this one', () => {
    const c = card({ movements: [...day2Accounts, { channel: 'cash', accountId: null, component: 'salesIn', amount: 999 }] });
    expect(c.methods[1].position).toBe(2000);
    expect(c.methods[2].position).toBe(1600);
  });

  it('the window starts strictly after the anchor’s instant, reaching one business day back for the indexes', () => {
    const anchor = declared(BANKILY, 0, '2026-10-01T00:30:00Z', '2026-10-01');
    const window = movementWindow(anchor);
    expect(window.after).toBe(anchor.at);
    // Another branch may still be on the previous business date after this one started early.
    expect(window.fromDate).toBe('2026-09-30');
    // A movement dated by day only is measured against the anchor's own business day.
    expect(window.day).toBe('2026-10-01');
  });
});

describe('each movement counts from the moment its money moved, not from when it was approved', () => {
  /*
   * The query in money-anchors.service.ts windows every row by one instant: a
   * payment, and every leg that fixes it, by when the payment was made; a refund,
   * a supplier payment or a variable expense by when it was reported; a fixed
   * expense by its due day; a cancellation's legs by its approval. This restates
   * those windows over a small ledger (the service spec pins the query to them),
   * so what is checked here is the positions each order of events leaves.
   */
  type Event = { accountId: string; component: MovementRow['component']; amount: number; at?: string; dueDay?: string };
  const windowed = (events: Event[], anchors: DeclaredAnchor[]): MovementRow[] =>
    anchors.flatMap((a) => {
      const w = movementWindow(a);
      return events
        .filter((e) => e.accountId === a.accountId && (e.dueDay ? e.dueDay > w.day : new Date(e.at!) > w.after))
        .map((e) => move(e.accountId, e.component, e.amount));
    });
  const positionsAfter = (events: Event[], anchors: DeclaredAnchor[]) =>
    card({ anchors, movements: windowed(events, anchors) })
      .methods.filter((m) => m.channel === 'account')
      .map((m) => [m.label, m.position]);

  // 500 recorded into Bankily at 10:00 really reached Masrvi; the move is approved at 15:00.
  const PAID = '2026-09-26T10:00:00Z';
  const payment: Event = { accountId: BANKILY, component: 'salesIn', amount: 500, at: PAID };
  const reclassified: Event[] = [
    { accountId: BANKILY, component: 'correctionsOut', amount: 500, at: PAID },
    { accountId: MASRVI, component: 'correctionsIn', amount: 500, at: PAID },
  ];

  it('payment → anchor → reclassify: the anchors already saw the money where it really was, so both stay as recorded', () => {
    // At noon the providers showed Bankily 0 and Masrvi 500: the truth, the mistake already absorbed.
    const noon = [declared(BANKILY, 0, '2026-09-26T12:00:00Z', '2026-09-26'), declared(MASRVI, 500, '2026-09-26T12:00:00Z', '2026-09-26')];
    expect(positionsAfter([payment, ...reclassified], noon)).toEqual([
      ['Bankily', 0],
      ['Masrvi', 500],
    ]);
    // Windowed by the approval instead, the same fix would be applied a second time.
    const byApproval = reclassified.map((e) => ({ ...e, at: '2026-09-26T15:00:00Z' }));
    expect(positionsAfter([payment, ...byApproval], noon)).toEqual([
      ['Bankily', -500],
      ['Masrvi', 1000],
    ]);
  });

  it('anchor → payment → reclassify: the payment and its fix both came after the anchors, so the money moves', () => {
    const early = [declared(BANKILY, 0, '2026-09-26T08:00:00Z', '2026-09-26'), declared(MASRVI, 0, '2026-09-26T08:00:00Z', '2026-09-26')];
    expect(positionsAfter([payment], early)).toEqual([
      ['Bankily', 500],
      ['Masrvi', 0],
    ]);
    expect(positionsAfter([payment, ...reclassified], early)).toEqual([
      ['Bankily', 0],
      ['Masrvi', 500],
    ]);
  });

  it('a cancellation approved after the anchor hands the money back then, so it counts', () => {
    const noon = [declared(BANKILY, 500, '2026-09-26T12:00:00Z', '2026-09-26'), declared(MASRVI, 0, '2026-09-26T12:00:00Z', '2026-09-26')];
    const cancelled: Event = { accountId: BANKILY, component: 'correctionsOut', amount: 500, at: '2026-09-26T15:00:00Z' };
    expect(positionsAfter([payment, cancelled], noon)).toEqual([
      ['Bankily', 0],
      ['Masrvi', 0],
    ]);
  });

  it('report → anchor → confirm: the money left when it was reported, which the anchor already shows', () => {
    // 300 paid out of Bankily at 10:00, the provider read at noon, the Owner confirms at 15:00.
    const noon = [declared(BANKILY, 1700, '2026-09-26T12:00:00Z', '2026-09-26'), declared(MASRVI, 0, '2026-09-26T12:00:00Z', '2026-09-26')];
    const reported: Event = { accountId: BANKILY, component: 'expensesOut', amount: 300, at: '2026-09-26T10:00:00Z' };
    expect(positionsAfter([reported], noon)).toEqual([
      ['Bankily', 1700],
      ['Masrvi', 0],
    ]);
    // Reported after the anchor, it comes off.
    expect(positionsAfter([{ ...reported, at: '2026-09-26T13:00:00Z' }], noon)).toEqual([
      ['Bankily', 1400],
      ['Masrvi', 0],
    ]);
  });

  it('a fixed expense counts when its due day is after the anchor’s day, never when it is that day or before', () => {
    const anchors = [declared(BANKILY, 1000, '2026-09-26T12:00:00Z', '2026-09-26'), declared(MASRVI, 0, '2026-09-26T12:00:00Z', '2026-09-26')];
    const rent = (dueDay: string): Event => ({ accountId: BANKILY, component: 'expensesOut', amount: 400, dueDay });
    expect(positionsAfter([rent('2026-09-27')], anchors)).toEqual([
      ['Bankily', 600],
      ['Masrvi', 0],
    ]);
    for (const dueDay of ['2026-09-26', '2026-09-25']) {
      expect(positionsAfter([rent(dueDay)], anchors)).toEqual([
        ['Bankily', 1000],
        ['Masrvi', 0],
      ]);
    }
  });
});

describe('which methods are listed, and the total', () => {
  it('cash first, active accounts in the shop’s order, then a deactivated one only if it was ever recorded', () => {
    const shop = [
      account(MASRVI, 'Masrvi', 2),
      account(RETIRED, 'Old Sedad', 0, false),
      account(BANKILY, 'Bankily', 1),
      account('01a0b1c2-0000-7000-8000-00000000000e', 'Never recorded', 0, false),
    ];
    const c = card({ accounts: shop, anchors: [...morningAnchors, declared(RETIRED, 250, '2026-09-20T10:00:00Z', '2026-09-20')] });
    expect(c.methods.map((m) => m.label || m.key)).toEqual(['cash', 'Bankily', 'Masrvi', 'Old Sedad']);
    expect(c.methods[3]).toMatchObject({ isActive: false, known: true, position: 250 });
    expect(c.total).toBe(3400 + 2000 + 1600 + 250);
  });

  it('an active account with no anchor is listed as unknown rather than left out', () => {
    const c = card({ accounts: [...accounts, account(RETIRED, 'Sedad', 3)] });
    expect(c.methods.map((m) => m.key)).toContain(`account:${RETIRED}`);
    expect(c.unknownKeys).toEqual([`account:${RETIRED}`]);
    expect(c.total).toBeNull();
  });

  it('a deactivated account that recorded money but was never anchored is listed as unknown, and there is no total', () => {
    // It may still hold that money: a total without it would claim to be complete.
    const c = card({ accounts: [...accounts, account(RETIRED, 'Old Sedad', 0, false)], withMovement: [RETIRED] });
    expect(c.methods.map((m) => m.label || m.key)).toEqual(['cash', 'Bankily', 'Masrvi', 'Old Sedad']);
    expect(c.methods[3]).toMatchObject({ isActive: false, known: false, position: null, unknownReason: 'no_anchor', anchor: null });
    expect(c.unknownKeys).toEqual([`account:${RETIRED}`]);
    expect(c.total).toBeNull();
  });

  it('a deactivated account that never recorded money and was never anchored is not listed', () => {
    const c = card({ accounts: [...accounts, account(RETIRED, 'Old Sedad', 0, false)] });
    expect(c.methods.map((m) => m.key)).not.toContain(`account:${RETIRED}`);
    expect(c.unknownKeys).toEqual([]);
    expect(c.total).toBe(7000);
  });

  it('the same sort order is broken by label', () => {
    const c = card({ accounts: [account(MASRVI, 'Masrvi', 1), account(BANKILY, 'Bankily', 1)] });
    expect(c.methods.map((m) => m.label)).toEqual(['', 'Bankily', 'Masrvi']);
  });

  it('the total is the sum of exactly the rows listed, each rounded to the cent, cents kept', () => {
    const c = card({
      drawer: { expected: 1234.565 },
      anchors: [declared(BANKILY, 100.1, '2026-09-26T06:30:00Z', '2026-09-26'), declared(MASRVI, 999.99, '2026-09-26T06:30:00Z', '2026-09-26')],
      movements: [move(BANKILY, 'salesIn', 0.2), move(MASRVI, 'salesIn', 0.01)],
    });
    expect(positions(c).map(([, p]) => p)).toEqual([1234.57, 100.3, 1000]);
    expect(c.total).toBe(2334.87);
    expect(c.total).toBe(Math.round(c.methods.reduce((s, m) => s + (m.position as number), 0) * 100) / 100);
  });

  it('carries the branch count and the business date through', () => {
    const c = trackedMoney({
      asOf: new Date('2026-09-26T23:00:00Z'),
      businessDate: '2026-09-26',
      branchCount: 3,
      drawer: { countedToday: null, openingAnchor: day1Close, expected: 0 },
      accounts: [],
      anchors: [],
      movements: [],
      withMovement: new Set(),
      accountsVisible: true,
    });
    expect(c).toMatchObject({ branchCount: 3, businessDate: '2026-09-26', total: 0, unknownKeys: [], accountsVisible: true });
    expect(c.methods).toHaveLength(1);
  });
});

describe('who sees the accounts', () => {
  it('someone who may not record them sees this branch’s drawer only, and no total', () => {
    // The accounts are the company's, moved by every branch: the drawer alone is not the money held.
    const c = card({ accountsVisible: false, withMovement: [RETIRED] });
    expect(c.accountsVisible).toBe(false);
    expect(c.methods.map((m) => m.key)).toEqual(['cash']);
    expect(c.methods[0]).toMatchObject({ known: true, position: 3400 });
    expect(c.total).toBeNull();
    expect(c.unknownKeys).toEqual([]);
  });

  it('the Owner sees every account and the total', () => {
    const c = card();
    expect(c.accountsVisible).toBe(true);
    expect(c.methods).toHaveLength(3);
    expect(c.total).toBe(7000);
  });
});

describe('recording an account’s amount', () => {
  const codeOf = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return ((e as BadRequestException).getResponse() as { code?: string }).code;
    }
    return undefined;
  };

  it('accepts zero and any amount in cents', () => {
    expect(codeOf(() => assertAnchorAmount(0))).toBeUndefined();
    expect(codeOf(() => assertAnchorAmount(1500.25))).toBeUndefined();
  });

  it('refuses a negative amount, a third decimal and a figure the column cannot hold, by name', () => {
    for (const bad of [-1, -0.01, 10.005, Number.NaN, Number.POSITIVE_INFINITY, 1e15]) {
      expect(codeOf(() => assertAnchorAmount(bad))).toBe('amount_invalid');
    }
  });

  it('binds a request id to the account, the amount and the note — not to their spelling', () => {
    const base = anchorFingerprint({ accountId: BANKILY, amount: 1500, note: 'Bankily app at 18:00' });
    expect(anchorFingerprint({ accountId: BANKILY.toUpperCase(), amount: 1500.0, note: '  Bankily app at 18:00 ' })).toBe(base);
    expect(anchorFingerprint({ accountId: BANKILY, amount: 1500.01, note: 'Bankily app at 18:00' })).not.toBe(base);
    expect(anchorFingerprint({ accountId: MASRVI, amount: 1500, note: 'Bankily app at 18:00' })).not.toBe(base);
    expect(anchorFingerprint({ accountId: BANKILY, amount: 1500 })).not.toBe(base);
    expect(anchorFingerprint({ accountId: BANKILY, amount: 1500, note: '   ' })).toBe(anchorFingerprint({ accountId: BANKILY, amount: 1500 }));
  });
});

describe('the drawer anchored by the money a shop opened with (docs/63)', () => {
  const opened = {
    amount: 3000,
    at: new Date('2026-09-27T08:05:00Z'),
    businessDate: '2026-09-27',
    byName: 'Owner',
    decision: 'set' as const,
    reviewed: false,
  };

  it('is known from the opening, even when no drawer was ever counted — the closing’s figure, from that amount', () => {
    const cash = cashMethod({ countedToday: null, openingAnchor: null, opened, expected: 3500 }, NO_MOVE);
    expect(cash).toMatchObject({
      known: true,
      position: 3500,
      anchor: { source: 'opening', amount: 3000, at: '2026-09-27T08:05:00.000Z', decision: 'set', awaitingOwnerReview: false, byName: 'Owner' },
      sinceAnchorNet: 500,
    });
  });

  it('a carried opening awaits the Owner’s review — never presented as checked — until the Owner reviews it', () => {
    const carried = cashMethod({ countedToday: null, openingAnchor: day1Close, opened: { ...opened, decision: 'carried' }, expected: 3400 }, NO_MOVE);
    expect(carried.anchor).toMatchObject({ source: 'opening', decision: 'carried', awaitingOwnerReview: true });
    const reviewed = cashMethod({ countedToday: null, openingAnchor: day1Close, opened: { ...opened, decision: 'carried', reviewed: true }, expected: 3400 }, NO_MOVE);
    expect(reviewed.anchor).toMatchObject({ awaitingOwnerReview: false });
  });

  it('a day closed with its drawer counted still holds its count', () => {
    const today: CountedClose = { closingDate: '2026-09-27', countedCash: 3480, at: new Date('2026-09-27T21:00:00Z'), byName: 'Aicha' };
    expect(cashMethod({ countedToday: today, openingAnchor: day1Close, opened, expected: 3500 }, NO_MOVE)).toMatchObject({
      position: 3480,
      anchor: { source: 'counted_close' },
    });
  });

  it('with no anchor at all the drawer stays unknown — an opening never invents one', () => {
    expect(cashMethod({ countedToday: null, openingAnchor: null, opened: null, expected: 0 }, NO_MOVE)).toMatchObject({ known: false, position: null });
  });

  it('3 400 kept at the opening + 2 000 + 1 600 = 7 000, the next morning included', () => {
    const c = card({ drawer: { openingAnchor: null, opened: { ...opened, amount: 3400, decision: 'keep' }, expected: 3400 } });
    expect(positions(c)).toEqual([
      ['cash', 3400],
      [`account:${BANKILY}`, 2000],
      [`account:${MASRVI}`, 1600],
    ]);
    expect(c.total).toBe(7000);
  });
});

describe('what moved on the day, beside the position (the user’s brief of 2026-10-07)', () => {
  const SEDAD = '01a0b1c2-0000-7000-8000-00000000000e';
  const sedad = account(SEDAD, 'Sedad', 3);
  const dayRows = (...rows: MovementRow[]) => rows;

  it('an unknown Sedad with a 20 000 sale today: the position stays unknown, the day shows +20 000 recorded', () => {
    const c = card({ accounts: [...accounts, sedad], movements: [], dayMovements: dayRows(move(SEDAD, 'salesIn', 20000)) } as never);
    const m = c.methods.find((x) => x.accountId === SEDAD)!;
    expect(m).toMatchObject({ known: false, position: null, unknownReason: 'no_anchor', anchor: null, sinceAnchorNet: null });
    expect(m.movement).toEqual({ businessDate: '2026-09-26', inflows: 20000, outflows: 0, net: 20000 });
    // The others moved nothing today, and say so; no total while any method is unknown.
    expect(c.methods.find((x) => x.accountId === BANKILY)!.movement).toEqual({ businessDate: '2026-09-26', inflows: 0, outflows: 0, net: 0 });
    expect(c.total).toBeNull();
    expect(c.unknownKeys).toEqual([`account:${SEDAD}`]);
  });

  it('a known Sedad at 5 000 with a 20 000 sale after the record: 25 000, and the day says +20 000', () => {
    const anchors = [...morningAnchors, declared(SEDAD, 5000, '2026-09-26T06:30:00Z', '2026-09-26')];
    const c = card({ accounts: [...accounts, sedad], anchors, movements: [...day2Accounts, move(SEDAD, 'salesIn', 20000)], dayMovements: dayRows(move(SEDAD, 'salesIn', 20000)) } as never);
    const m = c.methods.find((x) => x.accountId === SEDAD)!;
    expect(m).toMatchObject({ known: true, position: 25000, sinceAnchorNet: 20000, movement: { inflows: 20000, outflows: 0, net: 20000 } });
    expect(c.total).toBe(3400 + 2000 + 1600 + 25000);
  });

  it('an amount the Owner set to 0 is known and reads 0 — never Unknown', () => {
    const anchors = [...morningAnchors, declared(SEDAD, 0, '2026-09-26T06:30:00Z', '2026-09-26')];
    const c = card({ accounts: [...accounts, sedad], anchors, movements: day2Accounts } as never);
    const m = c.methods.find((x) => x.accountId === SEDAD)!;
    expect(m).toMatchObject({ known: true, position: 0, movement: { net: 0 } });
    expect(c.unknownKeys).toEqual([]);
  });

  it('the day’s movement never becomes a position: 20 000 in and 20 000 refunded out leave an unknown account unknown, net 0', () => {
    const c = card({ accounts: [sedad], anchors: [], movements: [], dayMovements: dayRows(move(SEDAD, 'salesIn', 20000), move(SEDAD, 'refundsOut', 20000)) } as never);
    const m = c.methods.find((x) => x.accountId === SEDAD)!;
    expect(m.position).toBeNull();
    expect(m.movement).toEqual({ businessDate: '2026-09-26', inflows: 20000, outflows: 20000, net: 0 });
  });

  it('the drawer’s day comes from its closing row, with the closing’s signs; a row that moved nothing yields no rows', () => {
    const row = { salesIn: 10000, refundsOut: 500, supplierOut: 2000, expensesOut: 300, correctionsIn: 50, correctionsOut: 25 };
    const rows = cashDayRows(row);
    expect(rows.every((r) => r.channel === 'cash' && r.accountId === null)).toBe(true);
    expect(movementOf('2026-09-26', rows)).toEqual({ businessDate: '2026-09-26', inflows: 10050, outflows: 2825, net: 7225 });
    expect(cashDayRows({ salesIn: 0, refundsOut: 0, supplierOut: 0, expensesOut: 0, correctionsIn: 0, correctionsOut: 0 })).toEqual([]);
    expect(cashDayRows(null)).toEqual([]);
    const c = card({ drawer: { dayRows: rows } } as never);
    expect(c.methods[0].movement).toEqual({ businessDate: '2026-09-26', inflows: 10050, outflows: 2825, net: 7225 });
  });

  it('rounds to the cent and keeps a method’s day apart from another’s', () => {
    const m = accountMethod(sedad, null, [], movementOf('2026-09-26', [move(SEDAD, 'salesIn', 0.1), move(SEDAD, 'salesIn', 0.2), move(SEDAD, 'expensesOut', 0.05)]));
    expect(m.movement).toEqual({ businessDate: '2026-09-26', inflows: 0.3, outflows: 0.05, net: 0.25 });
    const c = card({ accounts: [...accounts, sedad], anchors: [], movements: [], dayMovements: dayRows(move(BANKILY, 'salesIn', 700)) } as never);
    expect(c.methods.find((x) => x.accountId === BANKILY)!.movement.net).toBe(700);
    expect(c.methods.find((x) => x.accountId === SEDAD)!.movement.net).toBe(0);
  });
});
