import { AnomaliesService } from './anomalies.service';

/**
 * An anomaly notification reaches only the people who may see that branch's figures (review NW2-01, 2026-10-16).
 *
 * Recipients were everyone in the company holding the permission, so a Store Manager of one branch was told another
 * branch's overdue debts and cash shortfalls. A reading of one branch now goes to those assigned there; a
 * company-wide reading, which carries every branch's figures, only to those who hold the permission in every branch.
 */

const OWNER = Buffer.alloc(16, 1);
const MANAGER_A = Buffer.alloc(16, 2);
const MANAGER_B = Buffer.alloc(16, 3);
const BRANCH_A = Buffer.alloc(16, 0xa);
const BRANCH_B = Buffer.alloc(16, 0xb);

const ASSIGNMENTS = [
  { userId: OWNER, branchId: BRANCH_A },
  { userId: OWNER, branchId: BRANCH_B },
  { userId: MANAGER_A, branchId: BRANCH_A },
  { userId: MANAGER_B, branchId: BRANCH_B },
];

function service() {
  const db = {
    userBranch: {
      findMany: jest.fn(async ({ where }: { where: { branchId?: Buffer } }) =>
        ASSIGNMENTS.filter((a) => !where.branchId || a.branchId.equals(where.branchId)),
      ),
    },
    branch: { count: jest.fn(async () => 2) },
  };
  return new AnomaliesService(db as never, {} as never, {} as never, {} as never, {} as never) as unknown as {
    recipientsFor(code: string, branchId: Buffer | null): Promise<Buffer[]>;
  };
}

const hex = (ids: Buffer[]) => ids.map((b) => b.toString('hex')).sort();

describe('who is told about an anomaly', () => {
  it("a reading of branch A goes to branch A's holders, never to branch B's manager", async () => {
    const told = await service().recipientsFor('anomaly.overdue_debt', BRANCH_A);
    expect(hex(told)).toEqual(hex([OWNER, MANAGER_A]));
  });

  it('a company-wide reading goes only to someone who holds the permission in every branch', async () => {
    const told = await service().recipientsFor('anomaly.cash_shortfall', null);
    expect(hex(told)).toEqual(hex([OWNER]));
  });
});
