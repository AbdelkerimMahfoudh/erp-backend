import { DashboardService } from './dashboard.service';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * The branch comparison shows only branches whose reports the caller may read.
 *
 * `GET /dashboard` and `GET /reports/profit-by-branch.csv` are gated on
 * `report.view`, which a Store Manager holds at their own branch. The comparison
 * itself grouped the rollups of every branch, so a manager of one branch read the
 * other branch's revenue, gross and net profit (found live, both routes). docs/03
 * §2: a manager "cannot see other branches' data"; the Owner sees all branches.
 */

const USER = Buffer.alloc(16, 3);
const MINE = Buffer.alloc(16, 1);
const THEIRS = Buffer.alloc(16, 2);

const ROLLUPS = [
  { branchId: MINE, _sum: { revenue: 120000, grossProfit: 24000, netProfit: 23660 } },
  { branchId: THEIRS, _sum: { revenue: 17500, grossProfit: 2500, netProfit: 2500 } },
];

function dashboard(reportViewAt: Buffer[]) {
  const svc: any = Object.create(DashboardService.prototype);
  svc.tenant = { requireUserId: () => USER };
  svc.windowStart = () => new Date('2026-09-17T00:00:00.000Z');
  svc.db = {
    userBranch: {
      findMany: jest.fn(async ({ where }: any) => {
        // Only assignments whose role carries report.view count.
        expect(where.role).toEqual({ rolePermissions: { some: { permission: { key: 'report.view' } } } });
        return where.userId.equals(USER) ? reportViewAt.map((branchId) => ({ branchId })) : [];
      }),
    },
    dailyRollup: {
      groupBy: jest.fn(async ({ where }: any) =>
        ROLLUPS.filter((r) => !where.branchId || where.branchId.in.some((b: Buffer) => b.equals(r.branchId))),
      ),
    },
    branch: {
      findMany: async ({ where }: any) =>
        where.id.in.map((id: Buffer) => ({ id, name: id.equals(MINE) ? 'Boutique 2' : 'Boutique 2 Annexe' })),
    },
  };
  return svc as DashboardService;
}

describe('branch comparison respects per-branch report authority', () => {
  it('a manager of one branch sees that branch only', async () => {
    const rows = await dashboard([MINE]).branchComparison(30);

    expect(rows.map((r) => r.branchId)).toEqual([binToUuid(MINE)]);
  });

  it('the Owner, who reads reports everywhere, compares every branch', async () => {
    const rows = await dashboard([MINE, THEIRS]).branchComparison(30);

    expect(rows.map((r) => r.name)).toEqual(['Boutique 2', 'Boutique 2 Annexe']);
  });

  it('someone who reads reports nowhere gets no branch at all', async () => {
    expect(await dashboard([]).branchComparison(30)).toEqual([]);
  });
});
