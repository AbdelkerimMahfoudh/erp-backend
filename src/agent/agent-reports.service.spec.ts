import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBin } from '../common/utils/uuid.util';
import { dateValue } from '../common/business-day/business-day.service';
import { AgentReportsService } from './agent-reports.service';

/**
 * The reports route around the pure aggregation (D157): the period's rows read
 * by stored business date, the floats as of the period's end, the float counts
 * whose difference opened a question.
 */

const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const BANKILY = '01a0b1c2-0000-7000-8000-00000000000b';
const SEDAD = '01a0b1c2-0000-7000-8000-00000000000c';
const TODAY = '2026-10-08';
const WINDOW_END = new Date('2026-10-02T06:00:00Z');

type Row = Record<string, any>;

function harness(opts: { activity?: string; transactions?: Row[]; legs?: Row[]; anchors?: Row[]; counts?: Row[] } = {}) {
  const db = {
    branch: { findFirst: jest.fn(async () => ({ activity: opts.activity ?? 'both' })) },
    agentTransaction: { findMany: jest.fn(async (_args: Row) => opts.transactions ?? []) },
    agentMovement: {
      findMany: jest.fn(async (_args: Row) => opts.legs ?? []),
      groupBy: jest.fn(async ({ by }: { by: string[] }) => (by.includes('direction') ? [] : [])),
    },
    agentProvider: {
      findMany: jest.fn(async () => [
        { id: uuidToBin(BANKILY), kind: 'bankily', label: 'Bankily', isActive: true },
        { id: uuidToBin(SEDAD), kind: 'sedad', label: 'Sedad', isActive: false },
      ]),
    },
    agentPosition: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => (opts.anchors ?? []).find((a) => a.providerId.equals(where.providerId) && (!where.at || a.at.getTime() <= where.at.lte.getTime())) ?? null),
      groupBy: jest.fn(async () => []),
    },
    agentFloatCount: { findMany: jest.fn(async (_args: Row) => opts.counts ?? []) },
  };
  const businessDay = { today: jest.fn(async () => TODAY), windowOf: jest.fn(async () => ({ start: new Date('2026-10-01T06:00:00Z'), end: WINDOW_END })) };
  const tenant = { companyId: () => COMPANY, requireBranchId: () => BRANCH };
  const svc = new AgentReportsService(db as never, tenant as never, businessDay as never);
  return { svc, db, businessDay };
}

const tx = (over: Row = {}): Row => ({
  providerId: uuidToBin(BANKILY),
  provider: { label: 'Bankily' },
  direction: 'cash_in_credit_out',
  amount: new Prisma.Decimal(20_000),
  commissionAmount: new Prisma.Decimal(200),
  status: 'completed',
  recordedById: Buffer.alloc(16, 5),
  recordedByName: 'Aicha',
  businessDate: dateValue(TODAY),
  ...over,
});

describe('GET agent/reports', () => {
  it('a day: the rows of that business date, aggregated; floats as of now; the drawer never read here', async () => {
    const h = harness({
      transactions: [tx(), tx({ direction: 'cash_out_credit_in', amount: new Prisma.Decimal(15_000), commissionAmount: new Prisma.Decimal(150), providerId: uuidToBin(SEDAD), provider: { label: 'Sedad' } }), tx({ status: 'reversed' })],
      legs: [{ rebalancingId: Buffer.alloc(16, 8), accountKind: 'cash', direction: 'outflow', amount: new Prisma.Decimal(100_000), businessDate: dateValue(TODAY) }, { rebalancingId: Buffer.alloc(16, 8), accountKind: 'provider', direction: 'inflow', amount: new Prisma.Decimal(100_000), businessDate: dateValue(TODAY) }],
      anchors: [{ providerId: uuidToBin(BANKILY), amount: new Prisma.Decimal(50_000), at: new Date('2026-10-08T08:00:00Z'), businessDate: dateValue(TODAY), source: 'set', recordedByName: 'Owner' }],
    });
    const report = await h.svc.report({ period: 'day' });
    expect(h.db.agentTransaction.findMany.mock.calls[0][0].where).toEqual({ branchId: BRANCH, businessDate: { gte: dateValue(TODAY), lte: dateValue(TODAY) } });
    expect(h.db.agentMovement.findMany.mock.calls[0][0].where).toEqual({ branchId: BRANCH, kind: 'rebalancing', businessDate: { gte: dateValue(TODAY), lte: dateValue(TODAY) } });
    expect(report).toMatchObject({
      period: 'day',
      from: TODAY,
      to: TODAY,
      totals: { count: 2, volume: 35_000, cashReceived: 20_000, cashPaid: 15_000, creditSent: 20_000, creditReceived: 15_000, commission: 350, reversals: { count: 1, volume: 20_000, commission: 200 }, rebalancings: { count: 1, cashIn: 0, cashOut: 100_000, floatIn: 100_000, floatOut: 0 } },
    });
    expect(report.byProvider.map((p) => [p.label, p.count, p.reversals.count])).toEqual([['Bankily', 1, 1], ['Sedad', 1, 0]]);
    expect(report.byEmployee).toEqual([{ userId: expect.any(String), name: 'Aicha', count: 2, volume: 35_000, commission: 350, reversals: { count: 1 } }]);
    expect(report.byMonth).toBeUndefined();
    // Only the active provider is listed (Sedad is off and never held money); its float as of now.
    expect(report.positions.floats.map((f) => [f.providerLabel, f.known, f.position])).toEqual([['Bankily', true, 50_000]]);
    expect(h.businessDay.windowOf).not.toHaveBeenCalled();
    expect(report.positions.discrepancies).toEqual([]);
  });

  it('a past period ends at its last day’s boundary: the floats are read as of that instant', async () => {
    const h = harness({ anchors: [{ providerId: uuidToBin(BANKILY), amount: new Prisma.Decimal(1), at: new Date('2026-10-05T08:00:00Z'), businessDate: dateValue('2026-10-05'), source: 'set', recordedByName: 'Owner' }] });
    const report = await h.svc.report({ period: 'day', date: '2026-10-01' });
    expect(h.businessDay.windowOf).toHaveBeenCalledWith('2026-10-01');
    expect(h.db.agentPosition.findFirst.mock.calls[0][0].where).toMatchObject({ at: { lte: WINDOW_END } });
    // An anchor set after the period's end is not that period's: the float reads unknown then.
    expect(report.positions.floats[0]).toMatchObject({ known: false, position: null });
  });

  it('a week, a month and a year: the stored business dates of the period; the year by month', async () => {
    const week = harness();
    await week.svc.report({ period: 'week', date: '2026-10-08' });
    expect(week.db.agentTransaction.findMany.mock.calls[0][0].where.businessDate).toEqual({ gte: dateValue('2026-10-05'), lte: dateValue('2026-10-11') });
    const year = harness({ transactions: [tx({ businessDate: dateValue('2026-03-02') })] });
    const report = await year.svc.report({ period: 'year', date: '2026-10-08' });
    expect(year.db.agentTransaction.findMany.mock.calls[0][0].where.businessDate).toEqual({ gte: dateValue('2026-01-01'), lte: dateValue('2026-12-31') });
    expect(report.byMonth).toEqual([expect.objectContaining({ month: '2026-03', count: 1, volume: 20_000 })]);
  });

  it('the float counts of the period whose difference is not zero, with the question’s status', async () => {
    const h = harness({
      counts: [
        { providerId: uuidToBin(BANKILY), provider: { label: 'Bankily' }, expected: new Prisma.Decimal(150_000), counted: new Prisma.Decimal(149_900), difference: new Prisma.Decimal(-100), explanation: 'a fee', closing: { closingDate: dateValue(TODAY) }, discrepancies: [{ status: 'pending_investigation' }] },
        { providerId: uuidToBin(SEDAD), provider: { label: 'Sedad' }, expected: new Prisma.Decimal(40_000), counted: new Prisma.Decimal(40_000), difference: new Prisma.Decimal(0), explanation: null, closing: { closingDate: dateValue(TODAY) }, discrepancies: [] },
      ],
    });
    const report = await h.svc.report({ period: 'month' });
    expect(h.db.agentFloatCount.findMany.mock.calls[0][0].where).toEqual({ branchId: BRANCH, difference: { not: null }, closing: { closingDate: { gte: dateValue('2026-10-01'), lte: dateValue('2026-10-31') } } });
    expect(report.positions.discrepancies).toEqual([
      { businessDate: TODAY, providerId: BANKILY, label: 'Bankily', expected: 150_000, counted: 149_900, difference: -100, explanation: 'a fee', status: 'pending_investigation' },
    ]);
  });

  it('an electronics-only branch is refused by name', async () => {
    const h = harness({ activity: 'electronics' });
    await expect(h.svc.report({ period: 'day' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.db.agentTransaction.findMany).not.toHaveBeenCalled();
  });
});
