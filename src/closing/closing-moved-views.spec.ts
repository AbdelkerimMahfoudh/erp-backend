import { Prisma } from '@prisma/client';
import { buildChannels, type MovementRow } from './channels';
import { agentActivitySince } from './closing-report.queries';
import { ClosingService } from './closing.service';

/**
 * What the report and the live view say about a count that money moved past (D159, docs/73 §11.2), driven through
 * the real `report` and `openView` with the day's reads stubbed: each counted channel and float carries
 * `movedSinceCount` and the figure it was counted against; the report warns once, with what the agent counter
 * recorded since the earliest such count; and its version follows the day's money version. A locked day is read as
 * it was closed.
 */

jest.mock('./closing-report.queries', () => ({
  ...jest.requireActual('./closing-report.queries'),
  salesFigures: jest.fn(async () => ({ count: 1, value: 6_500, itemsSold: 1, cost: 5_000, missingCostLines: 0 })),
  returnFigures: jest.fn(async () => ({ count: 0, grossRefund: 0, adjustments: 0, netRefundDue: 0, costCredited: 0, missingCostLines: 0 })),
  cancellationFigures: jest.fn(async () => ({ count: 0, value: 0, items: 0, cost: 0, missingCostLines: 0, ofTheseSales: 0 })),
  collectedForSales: jest.fn(async () => ({ atCheckout: 6_500, laterSameDay: 0, corrections: 0 })),
  channelSplits: jest.fn(async () => new Map([['cash:NONE', { todaysSales: 6_500, olderDebts: 0 }]])),
  expenseLines: jest.fn(async () => []),
  expenseReversalLines: jest.fn(async () => []),
  pendingReports: jest.fn(async () => null),
  openDiscrepancies: jest.fn(async () => 0),
  dayActivity: jest.fn(async () => true),
  agentActivitySince: jest.fn(async () => ({ exchanges: 2, reversals: 1, rebalancings: 0 })),
}));

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const CLOSING = Buffer.alloc(16, 9);
const BANKILY = 'b0000000-0000-7000-8000-000000000001';
const DAY = '2026-10-10';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00Z`);

/** Counted at 18:00 when the drawer was expected to hold 5 000 and Bankily 2 000; since then a cash sale of 1 500. */
const movements: MovementRow[] = [
  { channel: 'cash', accountId: null, component: 'salesIn', amount: 6_500 },
  { channel: 'account', accountId: BANKILY, component: 'salesIn', amount: 2_000 },
];
const channels = buildChannels(movements, [{ id: BANKILY, label: 'Bankily', isActive: true, sortOrder: 1 }], 0);

const countRow = (channel: 'cash' | 'account', expected: number, counted: number) => ({
  id: Buffer.alloc(16, channel === 'cash' ? 4 : 5),
  channel,
  receivingAccountId: channel === 'cash' ? null : Buffer.from(BANKILY.replace(/-/g, ''), 'hex'),
  expected: new Prisma.Decimal(expected),
  counted: new Prisma.Decimal(counted),
  isSkipped: false,
  skipReason: null,
  countedAt: at('18:00'),
  countedById: USER,
  countedBy: { name: 'Aicha' },
  labelSnapshot: channel === 'cash' ? 'Cash' : 'Bankily',
});

/** The Bankily float, counted at 17:00 against 30 200; an exchange's float leg since puts it at 30 700. */
const floatRow = {
  providerId: 'p1',
  label: 'Bankily float',
  expected: 30_700,
  expectedAtCount: 30_200,
  counted: 30_200,
  explanation: null,
  isSkipped: false,
  skipReason: null,
  countedAt: at('17:00').toISOString(),
  countedByName: 'Aicha',
};

function harness(opts: { status?: string; moneyVersion?: number } = {}) {
  const locked = opts.status === 'locked';
  const closing = {
    id: CLOSING,
    status: opts.status ?? 'counted',
    isLocked: locked,
    version: 3,
    moneyVersion: opts.moneyVersion ?? 0,
    reopenedAt: null,
    reopenCount: 0,
    firstClosedAt: null,
    closedAt: at('20:00'),
    countedAt: at('18:00'),
    countedCash: null,
    difference: null,
    closedBy: null,
    channelCounts: [countRow('cash', 5_000, 5_000), countRow('account', 2_000, 2_000)],
  };
  const db = {
    dailyClosing: {
      // The day's row (with its counts), and — for today's views — the previous day's, which nobody closed.
      findUnique: jest.fn(async (args: { include?: unknown; select?: unknown }) => (args.include ? closing : null)),
    },
    closingEvent: { findFirst: jest.fn(async () => null) },
  };
  const svc = Object.create(ClosingService.prototype) as ClosingService & Record<string, unknown>;
  Object.assign(svc, {
    db,
    logger: { error: jest.fn() },
    tenant: { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => USER, requireUserId: () => USER },
    businessDay: { describe: jest.fn(async () => ({ businessDate: DAY, localDate: DAY, timezone: 'UTC', canStartEarly: false, startedEarly: false })) },
    cls: { get: () => new Set(['closing.count', 'closing.perform', 'report.view']) },
    dayChannels: jest.fn(async () => ({ opening: { amount: 0, anchorDate: null, anchorVerified: false, carriedDays: 0 }, carriedFrom: null, declaredToday: null, adjustment: 0, channels })),
    // The float as `floatCountsFor` hands it on an open day; a locked day's has nothing to compare (its own tests).
    floatCountsFor: jest.fn(async () => ({
      providers: [{ providerId: 'p1', label: 'Bankily float', isActive: true }],
      counts: new Map([['p1', { providerId: 'p1', counted: 30_200, isSkipped: false }]]),
      rows: [locked ? { ...floatRow, expected: 30_200, expectedAtCount: undefined } : floatRow],
      counted: [],
    })),
    timeline: jest.fn(async () => ({ rows: [], door: 'open', opening: null })),
    openingStep: jest.fn(async () => null),
  });
  return { svc };
}

describe('GET closings/report — a count money moved past (D159)', () => {
  beforeEach(() => jest.mocked(agentActivitySince).mockClear());

  it('each moved count says so, beside the figure it was counted against; one warning, with the agent counter’s movements since the earliest', async () => {
    const r = (await harness().svc.report(DAY)) as Record<string, any>;
    expect(r.expected.cash).toMatchObject({ expected: 6_500, expectedAtCount: 5_000, movedSinceCount: true, counted: 5_000, difference: -1_500 });
    expect(r.expected.accounts[0]).toMatchObject({ expectedMovement: 2_000, expectedAtCount: 2_000, movedSinceCount: false });
    expect(r.expected.floats[0]).toMatchObject({ expected: 30_700, expectedAtCount: 30_200, movedSinceCount: true });
    // The earliest moved count is the float's, at 17:00: the counter's exchanges, reversals and rebalancings since then.
    expect(agentActivitySince).toHaveBeenCalledWith(expect.anything(), COMPANY, BRANCH, DAY, at('17:00'));
    expect(r.warnings).toContainEqual({ code: 'money_moved_after_count', severity: 'warning', section: 'money', params: { count: 2, exchanges: 2, reversals: 1, rebalancings: 0 } });
  });

  it('the version follows the day’s money version — and none of it applies to a day already closed', async () => {
    const plain = (await harness({ moneyVersion: 0 }).svc.report(DAY)) as Record<string, any>;
    const moved = (await harness({ moneyVersion: 7 }).svc.report(DAY)) as Record<string, any>;
    expect(moved.reportVersion).not.toBe(plain.reportVersion);
    jest.mocked(agentActivitySince).mockClear();
    const closed = (await harness({ status: 'locked', moneyVersion: 7 }).svc.report(DAY)) as Record<string, any>;
    expect(closed.expected.cash).toMatchObject({ expectedAtCount: null, movedSinceCount: false });
    expect(closed.expected.floats[0]).toMatchObject({ expectedAtCount: null, movedSinceCount: false });
    expect(closed.warnings.map((w: { code: string }) => w.code)).not.toContain('money_moved_after_count');
    expect(agentActivitySince).not.toHaveBeenCalled();
  });
});

describe('GET closings/open/view — the same, channel by channel and float by float (D159)', () => {
  it('a moved count says so beside the figure it was counted against; a count that holds says so too', async () => {
    const v = (await harness().svc.openView(DAY)) as Record<string, any>;
    const cash = v.channels.find((c: { channel: string }) => c.channel === 'cash');
    const bankily = v.channels.find((c: { accountId: string | null }) => c.accountId === BANKILY);
    expect(cash).toMatchObject({ expected: 6_500, counted: 5_000, difference: -1_500, expectedAtCount: 5_000, movedSinceCount: true });
    expect(bankily).toMatchObject({ expected: 2_000, expectedAtCount: 2_000, movedSinceCount: false });
    expect(v.floats[0]).toMatchObject({ expected: 30_700, counted: 30_200, difference: -500, expectedAtCount: 30_200, movedSinceCount: true });
  });

  it('a locked day is shown as it was closed: nothing is compared', async () => {
    const v = (await harness({ status: 'locked' }).svc.openView(DAY)) as Record<string, any>;
    for (const c of v.channels) expect(c).toMatchObject({ expectedAtCount: null, movedSinceCount: false });
    expect(v.floats[0]).toMatchObject({ expectedAtCount: null, movedSinceCount: false });
  });
});
