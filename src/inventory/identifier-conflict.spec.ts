import { InventoryService } from './inventory.service';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';

/**
 * "Do we already have this phone?" — and what may be said about the answer.
 *
 * Two rules meet here and pull in opposite directions:
 *
 *  - IMEI uniqueness in this database is **global**. Migration 0042's trigger
 *    queries `units` with no company filter, so another shop's handset is
 *    genuinely impossible to receive.
 *  - The tenant client is **company-scoped**, so that same handset is invisible
 *    to every normal read.
 *
 * Left alone, that combination is the worst of both: the duplicate cannot be
 * seen and cannot be received, and the employee finds out only after typing a
 * cost. The contract answers early — and answers with a boolean when the unit
 * is not theirs to know about.
 */

const COMPANY = Buffer.alloc(16, 1);
const MY_BRANCH = Buffer.alloc(16, 2);
const OTHER_BRANCH = Buffer.alloc(16, 3);
const USER = Buffer.alloc(16, 4);

const IMEI_A = '353210110000005';
const IMEI_B = '490154203237518';

interface SeedUnit {
  id: Buffer;
  imeiPrimary?: string | null;
  imeiSecondary?: string | null;
  serialNo?: string | null;
  branchId?: Buffer;
  status?: string;
}

/**
 * `scoped` is what the tenant client can see; `system` is every unit in the
 * database. Keeping them as two separate arrays is the point — it is the only
 * way to test that the unscoped path returns a count and never a row.
 */
function harness(seed: { scoped?: SeedUnit[]; system?: SeedUnit[]; branches?: Buffer[] } = {}) {
  const scoped = seed.scoped ?? [];
  const system = seed.system ?? [];
  const branches = seed.branches ?? [MY_BRANCH];

  const matches = (rows: SeedUnit[], wanted: string[]) =>
    rows.filter(
      (u) =>
        (u.imeiPrimary && wanted.includes(u.imeiPrimary)) ||
        (u.imeiSecondary && wanted.includes(u.imeiSecondary)) ||
        (u.serialNo && wanted.includes(u.serialNo)),
    );

  const wantedFrom = (where: any): string[] =>
    where.OR.flatMap((c: any) => (Object.values(c)[0] as { in: string[] }).in);

  const db: any = {
    unit: {
      findMany: jest.fn(async ({ where }: any) =>
        matches(scoped, wantedFrom(where)).map((u) => ({
          id: u.id,
          status: u.status ?? 'in_stock',
          imeiPrimary: u.imeiPrimary ?? null,
          imeiSecondary: u.imeiSecondary ?? null,
          branchId: u.branchId ?? MY_BRANCH,
          branch: { name: 'Main Store' },
          product: { brand: 'Apple', model: 'iPhone 15', variant: '256GB Black' },
        })),
      ),
    },
    userBranch: { findMany: jest.fn(async () => branches.map((b) => ({ branchId: b }))) },
  };

  const systemClient: any = {
    unit: {
      // A COUNT. If this ever returns rows, another company's data has a shape
      // to travel in — which is the whole thing this design prevents.
      count: jest.fn(async ({ where }: any) => matches(system, wantedFrom(where)).length),
    },
  };

  const tenant: any = { companyId: () => COMPANY, userId: () => USER };
  const service = new InventoryService(
    db,
    tenant,
    { record: jest.fn() } as never,
    new TrackingStrategyRegistry(),
    systemClient,
  );
  return { service, db, systemClient };
}

describe('an identifier we hold ourselves', () => {
  it('is found through the primary IMEI', async () => {
    const { service } = harness({ scoped: [{ id: Buffer.alloc(16, 9), imeiPrimary: IMEI_A }] });
    const r = await service.describeIdentifierConflict([IMEI_A]);

    expect(r.alreadyInInventory).toBe(true);
    expect(r.matchedIdentifierPosition).toBe('primary');
    expect(r.elsewhere).toBe(false);
    expect(r.unit).toMatchObject({ productLabel: 'Apple iPhone 15 256GB Black', branchName: 'Main Store' });
  });

  it('is found through the SECOND IMEI too', async () => {
    // The dual-SIM case that `findByIdentifier` was widened for: the second
    // number is printed on the same box and scanned just as often.
    const { service } = harness({
      scoped: [{ id: Buffer.alloc(16, 9), imeiPrimary: IMEI_A, imeiSecondary: IMEI_B }],
    });
    const r = await service.describeIdentifierConflict([IMEI_B]);

    expect(r.alreadyInInventory).toBe(true);
    expect(r.matchedIdentifierPosition).toBe('secondary');
  });

  it('carries no cost, no margin and no internal id', async () => {
    const { service } = harness({ scoped: [{ id: Buffer.alloc(16, 9), imeiPrimary: IMEI_A }] });
    const r = await service.describeIdentifierConflict([IMEI_A]);

    const serialised = JSON.stringify(r);
    for (const forbidden of ['cost', 'margin', 'price', 'id"']) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(Object.keys(r.unit!).sort()).toEqual(['branchName', 'productLabel', 'status']);
  });
});

describe('an identifier nobody has', () => {
  it('reports no conflict at all', async () => {
    const { service } = harness();
    expect(await service.describeIdentifierConflict([IMEI_A])).toEqual({
      alreadyInInventory: false,
      matchedIdentifierPosition: null,
      unit: null,
      elsewhere: false,
      conflictingUnits: false,
    });
  });

  it('asks nothing at all for an empty identifier', async () => {
    const { service, db, systemClient } = harness();
    await service.describeIdentifierConflict(['   ']);
    expect(db.unit.findMany).not.toHaveBeenCalled();
    expect(systemClient.unit.count).not.toHaveBeenCalled();
  });
});

describe('an identifier held by somebody else', () => {
  it('blocks intake without naming the holder', async () => {
    /*
     * The privacy rule, stated as a test: the unit exists, so receiving it must
     * be refused — and the answer contains a boolean and nothing else. No
     * company, no branch, no product, no status.
     */
    const { service } = harness({ system: [{ id: Buffer.alloc(16, 9), imeiPrimary: IMEI_A }] });
    const r = await service.describeIdentifierConflict([IMEI_A]);

    expect(r.alreadyInInventory).toBe(true);
    expect(r.elsewhere).toBe(true);
    expect(r.unit).toBeNull();
    expect(r.matchedIdentifierPosition).toBeNull();
  });

  it('asks the unscoped client for a COUNT, never for rows', async () => {
    const { service, systemClient } = harness({ system: [{ id: Buffer.alloc(16, 9), imeiPrimary: IMEI_A }] });
    await service.describeIdentifierConflict([IMEI_A]);

    expect(systemClient.unit.count).toHaveBeenCalled();
    expect((systemClient.unit as Record<string, unknown>).findMany).toBeUndefined();
    expect((systemClient.unit as Record<string, unknown>).findFirst).toBeUndefined();
  });

  it('treats a branch this user cannot reach the same way', async () => {
    // Ours, but not theirs to see. A real duplicate; none of their business.
    const { service } = harness({
      scoped: [{ id: Buffer.alloc(16, 9), imeiPrimary: IMEI_A, branchId: OTHER_BRANCH }],
      branches: [MY_BRANCH],
    });
    const r = await service.describeIdentifierConflict([IMEI_A]);

    expect(r.alreadyInInventory).toBe(true);
    expect(r.elsewhere).toBe(true);
    expect(r.unit).toBeNull();
  });
});

describe('two IMEIs from one box', () => {
  it('recognises that either identifier found the SAME phone', async () => {
    const { service } = harness({
      scoped: [{ id: Buffer.alloc(16, 9), imeiPrimary: IMEI_A, imeiSecondary: IMEI_B }],
    });
    const r = await service.describeIdentifierConflict([IMEI_A, IMEI_B]);

    expect(r.alreadyInInventory).toBe(true);
    expect(r.conflictingUnits).toBe(false);
    expect(r.unit).not.toBeNull();
  });

  it('refuses to call two different units one phone', async () => {
    /*
     * The dangerous case. Two numbers scanned off one box that resolve to two
     * separate units means something is wrong with the box, the label or the
     * data — and picking one to display would silently attach the pair to
     * whichever the query happened to return first.
     */
    const { service } = harness({
      scoped: [
        { id: Buffer.alloc(16, 9), imeiPrimary: IMEI_A },
        { id: Buffer.alloc(16, 8), imeiPrimary: IMEI_B },
      ],
    });
    const r = await service.describeIdentifierConflict([IMEI_A, IMEI_B]);

    expect(r.conflictingUnits).toBe(true);
    expect(r.alreadyInInventory).toBe(true);
    // Nothing is shown, because there is no single right thing to show.
    expect(r.unit).toBeNull();
  });
});
