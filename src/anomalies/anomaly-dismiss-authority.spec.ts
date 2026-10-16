import { NotFoundException } from '@nestjs/common';
import { AnomaliesService } from './anomalies.service';

/**
 * Only somebody shown an anomaly may dismiss it (docs/46 A3: "any recipient may
 * dismiss an anomaly … for that company for 7 days"; seller margin and
 * below-cost clustering are Owner-only).
 *
 * The key is client-supplied and the route needs `report.view` alone, so a Store
 * Manager dismissed `anomaly.below_cost_cluster:<their own id>` and the Owner's
 * list stopped showing their below-cost sales for a week (found live, as was a
 * 2 000-character key the server accepted).
 */

const ME = Buffer.alloc(16, 3);
const MANAGER = ['report.view', 'cost.view'];
const OWNER = ['report.view', 'cost.view', 'discount.override', 'loan.view', 'closing.perform'];

function makeService(permissions: string[]) {
  const created: string[] = [];
  const db = {
    anomalyDismissal: {
      findFirst: async () => null,
      create: jest.fn(async ({ data }: any) => {
        created.push(data.anomalyKey);
        return { id: Buffer.alloc(16, 9) };
      }),
      updateMany: async () => ({ count: 0 }),
    },
  };
  const tenant = { companyId: () => Buffer.alloc(16, 1), userId: () => ME };
  const audit = { record: jest.fn(async () => undefined) };
  const cls = { get: (k: string) => (k === 'permissions' ? new Set(permissions) : undefined) };
  const service = new AnomaliesService(db as never, tenant as never, audit as never, {} as never, cls as never);
  return { service, created };
}

describe('dismissing an anomaly needs to be its recipient', () => {
  it.each(['anomaly.below_cost_cluster:01a14361-7535-758e-b665-7a97322abefa', 'anomaly.seller_margin_drop:01a14361-7535-758e-b665-7a97322abefa'])(
    'a Store Manager cannot dismiss the Owner-only %s',
    async (key) => {
      const { service, created } = makeService(MANAGER);
      await expect(service.dismiss(key)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.undismiss(key)).rejects.toBeInstanceOf(NotFoundException);
      expect(created).toEqual([]);
    },
  );

  it('a Store Manager without closing or loan authority cannot dismiss shortfalls or overdue debt', async () => {
    const { service, created } = makeService(MANAGER);
    await expect(service.dismiss('anomaly.cash_shortfall')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.dismiss('anomaly.overdue_debt')).rejects.toBeInstanceOf(NotFoundException);
    expect(created).toEqual([]);
  });

  it('refuses a key no rule makes, and one wider than the column', async () => {
    const { service, created } = makeService(OWNER);
    await expect(service.dismiss('anything')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.dismiss(`anomaly.dead_stock:${'y'.repeat(2000)}`)).rejects.toBeInstanceOf(NotFoundException);
    expect(created).toEqual([]);
  });

  it('a Store Manager still dismisses what they are shown', async () => {
    const { service, created } = makeService(MANAGER);
    await service.dismiss('anomaly.dead_stock:p1');
    expect(created).toEqual(['anomaly.dead_stock:p1']);
  });

  it('the Owner dismisses every rule they are shown', async () => {
    const { service, created } = makeService(OWNER);
    for (const key of ['anomaly.below_cost_cluster:u1', 'anomaly.seller_margin_drop:u1', 'anomaly.cash_shortfall', 'anomaly.overdue_debt']) {
      await service.dismiss(key);
    }
    expect(created).toHaveLength(4);
  });
});
