import { InventoryService } from './inventory.service';
import { uuidToBin } from '../common/utils/uuid.util';

/**
 * A stock listing without `X-Branch-Id` is not "the whole company".
 *
 * `GET /inventory` and `GET /inventory/by-model` carry no `@RequirePermissions`,
 * and the CLS middleware leaves the branch undefined when the header is absent.
 * H1.4.1 refused a header naming a branch the caller is not assigned to — but
 * simply dropping the header listed every branch's IMEIs and stock levels to
 * anyone signed in (found live: a Store Manager of one branch read the other
 * branch's units by searching their IMEI). Without a branch, the listing is
 * confined to the branches the caller is assigned to.
 */

const id = (n: number) => uuidToBin(`00000000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const MINE = id(1);
const THEIRS = id(2);
const USER = id(3);
const PRODUCT = id(100);

const product = { id: PRODUCT, brand: 'Apple', model: 'iPhone 15', variant: null, trackingType: 'imei', specifications: null };
const units = [
  { id: id(11), branchId: MINE, productId: PRODUCT, imeiPrimary: '356888000000011', status: 'in_stock', product },
  { id: id(12), branchId: THEIRS, productId: PRODUCT, imeiPrimary: '356888000000012', status: 'in_stock', product },
];
const stock = [
  { id: id(21), branchId: MINE, productId: PRODUCT, quantity: 4, reservedQuantity: 0, product },
  { id: id(22), branchId: THEIRS, productId: PRODUCT, quantity: 9, reservedQuantity: 0, product },
];

/** Applies only the branch part of a where clause — the part under test. */
function inScope(row: { branchId: Buffer }, where: { branchId?: Buffer | { in: Buffer[] } }): boolean {
  const scope = where.branchId;
  if (scope === undefined) return true;
  if (Buffer.isBuffer(scope)) return row.branchId.equals(scope);
  return scope.in.some((b) => b.equals(row.branchId));
}

function makeService(assignedTo: Buffer[]) {
  const model = (rows: any[]) => ({
    findMany: jest.fn(async ({ where }: any) => rows.filter((r) => inScope(r, where))),
    count: jest.fn(async ({ where }: any) => rows.filter((r) => inScope(r, where)).length),
    groupBy: jest.fn(async ({ where }: any) => {
      const hits = rows.filter((r) => inScope(r, where) && r.status === where.status);
      return hits.length ? [{ productId: PRODUCT, _count: { _all: hits.length } }] : [];
    }),
  });
  const db = {
    unit: model(units),
    stockItem: model(stock),
    product: { findMany: async () => [product] },
    userBranch: {
      findMany: async ({ where }: any) =>
        where.userId.equals(USER) ? assignedTo.map((branchId) => ({ branchId })) : [],
      findFirst: async ({ where }: any) =>
        assignedTo.some((b) => b.equals(where.branchId)) ? { id: USER } : null,
    },
  };
  // No `X-Branch-Id`: the branch is undefined, exactly as the middleware leaves it.
  const tenant = { branchId: () => undefined, userId: () => USER, requireUserId: () => USER };
  const service = new InventoryService(db as never, tenant as never, {} as never, {} as never, {} as never, { get: () => undefined } as never);
  return { service, db };
}

describe('stock listings without an active branch', () => {
  it('GET /inventory lists only the branches the caller is assigned to', async () => {
    const { service } = makeService([MINE]);

    const page = await service.listStock({});

    const imeis = page.rows.filter((r) => r.kind === 'unit').map((r: any) => r.imeiPrimary);
    expect(imeis).toEqual(['356888000000011']);
    expect(page.rows.filter((r) => r.kind === 'stock').map((r: any) => r.quantity)).toEqual([4]);
    expect(page.totals).toEqual({ units: 1, stock: 1 });
  });

  it('a search cannot reach a unit of another branch', async () => {
    const { service, db } = makeService([MINE]);

    await service.listStock({ search: '356888000000012' });

    expect(db.unit.findMany.mock.calls[0][0].where.branchId).toEqual({ in: [MINE] });
  });

  it('GET /inventory/by-model counts only the branches the caller is assigned to', async () => {
    const { service } = makeService([MINE]);

    const rows = await service.countByModel();

    expect(rows.map((r) => r.inStock)).toEqual([1]);
  });

  it('someone assigned to every branch (the Owner) still sees them all', async () => {
    const { service } = makeService([MINE, THEIRS]);

    const page = await service.listStock({});

    expect(page.totals).toEqual({ units: 2, stock: 2 });
  });
});
