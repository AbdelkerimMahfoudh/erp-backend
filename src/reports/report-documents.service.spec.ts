import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportDocumentsService } from './report-documents.service';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { profit } from '../analytics/accounting-rules';

const perms = (method: string): string[] | undefined =>
  Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, (ReportsController.prototype as unknown as Record<string, object>)[method]);

/**
 * Who may print which report (docs/66), and what the service asks its sources for. The
 * figures themselves are pinned in `report-documents.spec.ts`; here, the gates: the routes'
 * permissions, the refund figures only with `return.view`, the result only with `cost.view`,
 * the month validated before anything is read, and an audit row that holds no figure.
 */
describe('report document routes', () => {
  it('the daily report needs report.view and the Daily closing’s own closing.count; the monthly one report.view', () => {
    expect(perms('daily')).toEqual(['report.view', 'closing.count']);
    expect(perms('monthly')).toEqual(['report.view']);
    // Unchanged: the spreadsheet export.
    expect(perms('exportCsv')).toEqual(['report.view']);
  });

  it('by role: the Owner and the Manager may print both; the Employee neither', () => {
    const may = (role: keyof typeof ROLE_PERMISSIONS, keys: string[]) => keys.every((k) => ROLE_PERMISSIONS[role].includes(k));
    expect(may('owner', ['report.view', 'closing.count'])).toBe(true);
    expect(may('store_manager', ['report.view', 'closing.count'])).toBe(true);
    expect(may('store_employee', ['report.view'])).toBe(false);
  });
});

const BRANCH = Buffer.alloc(16, 2);
const COMPANY = Buffer.alloc(16, 1);

function harness(held: string[], over: { today?: string } = {}) {
  const report = {
    date: '2026-10-01',
    today: '2026-10-01',
    isToday: true,
    timezone: 'Africa/Nouakchott',
    window: { startsAt: '2026-10-01T06:00:00.000Z', endsAt: '2026-10-02T06:00:00.000Z' },
    standing: 'open',
    sales: null,
    expenses: null,
    result: { status: 'hidden' },
    money: { channels: [], totals: { in: 0, out: 0, net: 0, todaysSales: 0, olderDebts: 0 }, pending: null },
    expected: {
      cash: { opening: { amount: 0, anchorDate: null, anchorVerified: false, carriedDays: 0 }, in: 0, out: 0, set: null, expected: 0, counted: null, difference: null, verification: 'not_counted', countedAt: null },
      accounts: [],
    },
    warnings: [],
    close: null,
    sections: { sales: false, expenses: false, result: false, close: false },
    source: 'live',
    snapshot: null,
  };
  const calls = { refundSummary: [] as unknown[], forPeriod: [] as unknown[], audit: [] as Record<string, unknown>[] };
  const refundSummary = { confirmed: { count: 0, total: 0 }, awaitingConfirmation: { count: 0, amount: 0 }, outstandingLiability: { count: 3, amount: 9_000 } };
  const service = new ReportDocumentsService(
    { report: jest.fn(async () => report) } as never,
    { refundSummary: jest.fn(async (q: unknown) => (calls.refundSummary.push(q), refundSummary)) } as never,
    {
      forPeriod: jest.fn(async (from: string, to: string) => {
        calls.forPeriod.push({ from, to });
        return {
          profit: profit({ grossSales: 0, returnsRevenue: 0, cogs: 0, returnsCogs: 0, expenses: 0 }),
          expenseDetail: { total: 0, fixed: 0, salaries: 0, count: 0 },
          balances: { loansReceivable: 0, loansPayable: 0, consignmentBalance: 0 },
          cash: { inflow: 0, outflow: 0, net: 0, salesReceived: 0, refundsPaid: 0, supplierPaymentsConfirmed: 0, expensesCash: 0 },
        };
      }),
    } as never,
    { today: jest.fn(async () => over.today ?? '2026-10-01'), timezone: jest.fn(async () => 'Africa/Nouakchott') } as never,
    { companyId: () => COMPANY, requireBranchId: () => BRANCH } as never,
    { record: jest.fn(async (row: Record<string, unknown>) => void calls.audit.push(row)) } as never,
    { get: (k: string) => (k === 'permissions' ? new Set(held) : undefined) } as never,
    { company: { findUnique: jest.fn(async () => ({ name: 'Tech Plus' })) } } as never,
    {
      branch: { findFirst: jest.fn(async () => ({ name: 'Main Store' })) },
      sale: { aggregate: jest.fn(async () => ({ _sum: { balanceDue: 13_000 }, _count: 2 })) },
      $queryRaw: jest.fn(async () => []),
    } as never,
  );
  return { service, calls };
}

describe('the daily document service', () => {
  it('reads the refund figures only for somebody who may see returns', async () => {
    const without = harness(['report.view', 'closing.count']);
    const doc = await without.service.daily();
    expect(doc.refunds).toBeNull();
    expect(without.calls.refundSummary).toEqual([]);

    const withReturns = harness(['report.view', 'closing.count', 'return.view']);
    const shown = await withReturns.service.daily();
    expect(shown.refunds?.outstanding).toEqual({ count: 3, amount: 9_000 });
    // The day's own confirmed refunds: exactly that business date.
    expect(withReturns.calls.refundSummary).toEqual([{ from: '2026-10-01', to: '2026-10-01' }]);
  });

  it('names the shop and the branch; the receivables are the open balances now', async () => {
    const { service } = harness(['report.view', 'closing.count']);
    const doc = await service.daily();
    expect(doc.identity).toEqual({ company: 'Tech Plus', branch: 'Main Store', timezone: 'Africa/Nouakchott' });
    expect(doc.receivables).toEqual({ amount: 13_000, sales: 2 });
  });

  it('leaves the same audit trail as a spreadsheet export — which document and sections, never a figure', async () => {
    const { service, calls } = harness(['report.view', 'closing.count']);
    await service.daily();
    expect(calls.audit).toHaveLength(1);
    expect(calls.audit[0]).toMatchObject({ entityType: 'report_export', action: 'create', after: { event: 'report_document_served', kind: 'daily', date: '2026-10-01', source: 'live', outcome: 'served' } });
    expect(JSON.stringify(calls.audit[0])).not.toMatch(/13000|amount|value|grossProfit/);
  });
});

describe('the monthly document service', () => {
  it('a past month reads the whole month from every source', async () => {
    const { service, calls } = harness(['report.view', 'return.view', 'cost.view']);
    const doc = await service.monthly('2026-09');
    expect(calls.forPeriod).toEqual([{ from: '2026-09-01', to: '2026-09-30' }]);
    expect(calls.refundSummary).toEqual([{ from: '2026-09-01', to: '2026-09-30' }]);
    expect(doc).toMatchObject({ month: '2026-09', complete: true, sections: { result: true, refunds: true } });
  });

  it('no month means the current one, to today’s business date', async () => {
    const { service, calls } = harness(['report.view'], { today: '2026-10-17' });
    const doc = await service.monthly();
    expect(calls.forPeriod).toEqual([{ from: '2026-10-01', to: '2026-10-17' }]);
    expect(doc).toMatchObject({ month: '2026-10', complete: false, result: { status: 'hidden' }, refunds: null });
  });

  it('a malformed or future month is a 400, refused before any figure is read', async () => {
    for (const bad of ['2026-13', '2026-11', 'september', '2026-9']) {
      const { service, calls } = harness(['report.view']);
      await expect(service.monthly(bad)).rejects.toBeInstanceOf(BadRequestException);
      expect(calls.forPeriod).toEqual([]);
      expect(calls.audit).toEqual([]);
    }
  });
});
