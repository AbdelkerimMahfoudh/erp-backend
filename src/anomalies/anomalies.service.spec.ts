import { ForbiddenException } from '@nestjs/common';
import { AnomaliesService } from './anomalies.service';
import { uuidToBin } from '../common/utils/uuid.util';

/**
 * The "needs attention" list as the overview and the full list consume it:
 * three newest on the overview, the rest paged, and one answer to "I
 * understand" however many times the tap arrives.
 *
 * Only dead stock is driven here, through the dashboard stub, because it is the
 * one rule every reader may see. The fake database has no `sale`, `closing` or
 * `discountApproval` table at all — if the service ever computed a rule the
 * reader may not see, these tests would fail with a TypeError rather than pass
 * by accident.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const ME = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const DAYS = 60;

interface Dismissal {
  id: Buffer;
  companyId: Buffer;
  anomalyKey: string;
  dismissedAt: Date;
  suppressedUntil: Date;
}

interface DeadRow {
  productId: string;
  label: string;
  inStock: number;
  lastSoldAt: Date | null;
}

/** `n` products that last sold on successive days — product 1 the longest ago. */
function deadRows(n: number): DeadRow[] {
  return Array.from({ length: n }, (_, i) => ({
    productId: `p${i + 1}`,
    label: `Product ${i + 1}`,
    inStock: 1,
    lastSoldAt: new Date(Date.UTC(2026, 0, 1 + i)),
  }));
}

function makeService(opts: { dead?: DeadRow[]; dismissals?: Dismissal[]; permissions?: string[] } = {}) {
  const dismissals = opts.dismissals ?? [];
  const audits: unknown[] = [];
  const created: Dismissal[] = [];
  // The tenant client's view: the extension scopes every read to the company.
  const mine = (r: Dismissal) => r.companyId.equals(COMPANY);

  const db = {
    anomalyDismissal: {
      deleteMany: async () => ({ count: 0 }),
      findMany: async ({ where }: { where: { suppressedUntil: { gt: Date } } }) =>
        dismissals
          .filter(mine)
          .filter((r) => r.suppressedUntil > where.suppressedUntil.gt)
          .map((r) => ({ anomalyKey: r.anomalyKey })),
      findFirst: async ({
        where,
      }: {
        where: { companyId: Buffer; anomalyKey: string; suppressedUntil: { gt: Date } };
      }) => {
        const hits = dismissals
          .filter(
            (r) =>
              r.companyId.equals(where.companyId) &&
              r.anomalyKey === where.anomalyKey &&
              r.suppressedUntil > where.suppressedUntil.gt,
          )
          .sort((a, b) => b.suppressedUntil.getTime() - a.suppressedUntil.getTime());
        return hits[0] ? { id: hits[0].id, suppressedUntil: hits[0].suppressedUntil } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { companyId: Buffer; anomalyKey: string; suppressedUntil: { gt: Date } };
        data: { suppressedUntil: Date };
      }) => {
        let count = 0;
        for (const row of dismissals) {
          if (
            row.companyId.equals(where.companyId) &&
            row.anomalyKey === where.anomalyKey &&
            row.suppressedUntil > where.suppressedUntil.gt
          ) {
            row.suppressedUntil = data.suppressedUntil;
            count += 1;
          }
        }
        return { count };
      },
      create: async ({ data }: { data: Omit<Dismissal, 'id'> & { id: Buffer; dismissedById: Buffer } }) => {
        const row: Dismissal = {
          id: data.id,
          companyId: data.companyId,
          anomalyKey: data.anomalyKey,
          dismissedAt: data.dismissedAt,
          suppressedUntil: data.suppressedUntil,
        };
        dismissals.push(row);
        created.push(row);
        return row;
      },
    },
    notification: { create: async () => ({}) },
    userBranch: { findMany: async () => [] },
  };
  const tenant = { companyId: () => COMPANY, branchId: () => null, userId: () => ME };
  const audit = {
    record: async (event: unknown) => {
      audits.push(event);
    },
  };
  const dashboard = {
    deadStock: async () => opts.dead ?? [],
    deadStockDays: async () => DAYS,
    employeePerformance: async () => [],
  };
  const cls = {
    get: (key: string) => (key === 'permissions' ? new Set(opts.permissions ?? ['report.view']) : undefined),
  };
  const service = new AnomaliesService(db as never, tenant as never, audit as never, dashboard as never, cls as never);
  return { service, created, audits };
}

const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

describe('the overview: three newest, and how many there are', () => {
  it('has nothing to say when nothing is wrong', async () => {
    const { service } = makeService();
    await expect(service.list({ limit: 3 })).resolves.toMatchObject({ rows: [], total: 0, page: 1, pageSize: 3 });
  });

  it('says one thing when one thing is wrong', async () => {
    const { service } = makeService({ dead: deadRows(1) });
    const out = await service.list({ limit: 3 });
    expect(out.total).toBe(1);
    expect(keys(out.rows)).toEqual(['anomaly.dead_stock:p1']);
  });

  it('shows exactly three of three, so no "view all" is owed', async () => {
    const { service } = makeService({ dead: deadRows(3) });
    const out = await service.list({ limit: 3 });
    expect(out.total).toBe(3);
    expect(out.rows).toHaveLength(3);
  });

  it('shows the three NEWEST of four, and says there are four', async () => {
    const { service } = makeService({ dead: deadRows(4) });
    const out = await service.list({ limit: 3 });
    expect(out.total).toBe(4);
    // Product 4 sold most recently, so its shelf went quiet last: it is the newest.
    expect(keys(out.rows)).toEqual(['anomaly.dead_stock:p4', 'anomaly.dead_stock:p3', 'anomaly.dead_stock:p2']);
    const rest = await service.list({ limit: 3, page: 2 });
    expect(keys(rest.rows)).toEqual(['anomaly.dead_stock:p1']);
  });

  it('carries each row’s own instant so the phone can say how old it is', async () => {
    const { service } = makeService({ dead: deadRows(1) });
    const [row] = (await service.list()).rows;
    expect(row.at).toBe(new Date(Date.UTC(2026, 0, 1) + DAYS * 86_400_000).toISOString());
  });
});

describe('the full list: pages of one ordered list', () => {
  it('pages many without losing, doubling or reordering a row', async () => {
    const { service } = makeService({ dead: deadRows(25) });
    const whole = keys((await service.list()).rows);
    expect(whole).toHaveLength(25);
    expect(whole[0]).toBe('anomaly.dead_stock:p25');

    const pages = await Promise.all([1, 2, 3].map((page) => service.list({ limit: 10, page })));
    expect(pages.map((p) => p.rows.length)).toEqual([10, 10, 5]);
    expect(pages.every((p) => p.total === 25)).toBe(true);
    expect(pages.flatMap((p) => keys(p.rows))).toEqual(whole);
  });

  it('answers the same order on every read', async () => {
    const { service } = makeService({ dead: deadRows(12) });
    const first = keys((await service.list()).rows);
    const second = keys((await service.list()).rows);
    expect(second).toEqual(first);
  });

  it('is empty past the last page rather than wrong', async () => {
    const { service } = makeService({ dead: deadRows(4) });
    await expect(service.list({ limit: 3, page: 5 })).resolves.toMatchObject({ rows: [], total: 4, page: 5 });
  });
});

describe('"I understand"', () => {
  it('removes the row and the next one takes its place', async () => {
    const { service } = makeService({ dead: deadRows(4) });
    await service.dismiss('anomaly.dead_stock:p4');
    const out = await service.list({ limit: 3 });
    expect(out.total).toBe(3);
    expect(keys(out.rows)).toEqual(['anomaly.dead_stock:p3', 'anomaly.dead_stock:p2', 'anomaly.dead_stock:p1']);
  });

  it('answers a replay with the dismissal that already stands, and records it once', async () => {
    const { service, created, audits } = makeService({ dead: deadRows(1) });
    const first = await service.dismiss('anomaly.dead_stock:p1');
    const again = await service.dismiss('anomaly.dead_stock:p1');
    const third = await service.dismiss('anomaly.dead_stock:p1');

    expect(first.replayed).toBe(false);
    expect(again).toEqual({ key: 'anomaly.dead_stock:p1', suppressedUntil: first.suppressedUntil, replayed: true });
    expect(third).toEqual(again);
    expect(created).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('is a decision of THIS company — another company’s dismissal is not ours', async () => {
    const standing: Dismissal = {
      id: uuidToBin('018f0000-0000-7000-8000-00000000d001'),
      companyId: OTHER_COMPANY,
      anomalyKey: 'anomaly.dead_stock:p1',
      dismissedAt: new Date(),
      suppressedUntil: new Date(Date.now() + 86_400_000),
    };
    const { service, created } = makeService({ dead: deadRows(1), dismissals: [standing] });
    // Still listed here.
    expect((await service.list()).total).toBe(1);
    // And dismissing here is a fresh decision, not a replay of theirs.
    const out = await service.dismiss('anomaly.dead_stock:p1');
    expect(out.replayed).toBe(false);
    expect(created).toHaveLength(1);
    expect(created[0].companyId.equals(COMPANY)).toBe(true);
  });

  it('is refused without report.view', async () => {
    const { service } = makeService({ permissions: [] });
    await expect(service.dismiss('anomaly.dead_stock:p1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.undismiss('anomaly.dead_stock:p1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('"I did not mean that" — the undo', () => {
  it('brings the row back, keeps the record, and is audited once', async () => {
    const { service, created, audits } = makeService({ dead: deadRows(2) });
    await service.dismiss('anomaly.dead_stock:p2');
    expect((await service.list()).total).toBe(1);

    await expect(service.undismiss('anomaly.dead_stock:p2')).resolves.toEqual({ key: 'anomaly.dead_stock:p2', restored: true });
    expect(keys((await service.list()).rows)).toEqual(['anomaly.dead_stock:p2', 'anomaly.dead_stock:p1']);
    // Ended, not deleted: the dismissal row is still there as history.
    expect(created).toHaveLength(1);
    expect(audits.map((a) => (a as { after: { event: string } }).after.event)).toEqual(['anomaly_dismissed', 'anomaly_undismissed']);
  });

  it('with nothing standing it changes nothing, says so, and audits nothing', async () => {
    const { service, audits } = makeService({ dead: deadRows(1) });
    await expect(service.undismiss('anomaly.dead_stock:p1')).resolves.toEqual({ key: 'anomaly.dead_stock:p1', restored: false });
    await service.dismiss('anomaly.dead_stock:p1');
    await service.undismiss('anomaly.dead_stock:p1');
    await expect(service.undismiss('anomaly.dead_stock:p1')).resolves.toMatchObject({ restored: false });
    expect(audits).toHaveLength(2);
  });

  it('after an undo, a fresh "I understand" is a new decision, not a replay', async () => {
    const { service, created } = makeService({ dead: deadRows(1) });
    await service.dismiss('anomaly.dead_stock:p1');
    await service.undismiss('anomaly.dead_stock:p1');
    const again = await service.dismiss('anomaly.dead_stock:p1');
    expect(again.replayed).toBe(false);
    expect(created).toHaveLength(2);
    expect((await service.list()).total).toBe(0);
  });
});
