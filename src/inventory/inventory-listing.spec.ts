import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { CostGatingInterceptor } from '../common/interceptors/cost-gating.interceptor';
import { InventoryService } from './inventory.service';

/**
 * `listStock` is the one endpoint that answers "what is physically here?".
 *
 * It previously returned `Unit` rows only, which silently hid every
 * quantity-tracked product — an electronics shop's accessories are real stock,
 * and inventory that omits them is wrong rather than merely incomplete. These
 * tests pin the corrected discriminated contract so that regression cannot
 * return unnoticed.
 */

const BRANCH = Buffer.alloc(16, 1);
const OTHER_BRANCH = Buffer.alloc(16, 2);
const PRODUCT = Buffer.alloc(16, 3);

const product = {
  brand: 'Apple',
  model: 'iPhone 15',
  variant: '256GB',
  barcode: null,
  trackingType: 'imei',
  specifications: { storage: '256GB', colour: 'Black' },
};

const unitRow = {
  id: Buffer.alloc(16, 10),
  imeiPrimary: '358888000000022',
  imeiSecondary: null,
  serialNo: null,
  status: 'in_stock',
  cost: 800,
  dateIn: new Date('2026-01-01T00:00:00Z'),
  productId: PRODUCT,
  branchId: BRANCH,
  product,
};

const stockRow = {
  id: Buffer.alloc(16, 20),
  productId: PRODUCT,
  branchId: BRANCH,
  quantity: 10,
  cost: 8.5,
  price: 15,
  product: { ...product, trackingType: 'quantity', brand: 'Anker', model: 'PowerCore 10000' },
};

/** Minimal service double: only the collaborators `listStock` actually uses. */
function makeService(options: {
  units?: unknown[];
  stock?: unknown[];
  branchId?: Buffer | null;
}) {
  const unitFindMany = jest.fn().mockResolvedValue(options.units ?? []);
  const stockFindMany = jest.fn().mockResolvedValue(options.stock ?? []);
  const db = { unit: { findMany: unitFindMany }, stockItem: { findMany: stockFindMany } };
  const tenant = { branchId: () => (options.branchId === undefined ? BRANCH : options.branchId) };

  const service = new InventoryService(
    db as never,
    tenant as never,
    {} as never,
    {} as never,
  );
  return { service, unitFindMany, stockFindMany };
}

describe('InventoryService.listStock', () => {
  it('returns serialized units tagged kind:"unit" with a derived identifier', async () => {
    const { service } = makeService({ units: [unitRow] });

    const rows = await service.listStock({});
    const unit = rows.find((r) => r.kind === 'unit');

    expect(unit).toBeDefined();
    expect(unit).toMatchObject({
      kind: 'unit',
      identifier: '358888000000022',
      status: 'in_stock',
    });
  });

  it('falls back to the serial number when there is no IMEI', async () => {
    const serialUnit = { ...unitRow, imeiPrimary: null, serialNo: 'BRV-B-2033266574' };
    const { service } = makeService({ units: [serialUnit] });

    const [row] = await service.listStock({});

    expect(row).toMatchObject({ kind: 'unit', identifier: 'BRV-B-2033266574' });
  });

  it('includes quantity-tracked stock tagged kind:"stock" — the regression this fixes', async () => {
    const { service } = makeService({ units: [], stock: [stockRow] });

    const rows = await service.listStock({});

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'stock', quantity: 10 });
  });

  it('returns both shapes together, units first', async () => {
    const { service } = makeService({ units: [unitRow], stock: [stockRow] });

    const rows = await service.listStock({});

    expect(rows.map((r) => r.kind)).toEqual(['unit', 'stock']);
  });

  it('excludes zero-quantity rows — stock that once existed here is not stock', async () => {
    const { service, stockFindMany } = makeService({ stock: [] });

    await service.listStock({});

    expect(stockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ quantity: { gt: 0 } }) }),
    );
  });

  it('scopes both queries to the active branch', async () => {
    const { service, unitFindMany, stockFindMany } = makeService({});

    await service.listStock({});

    expect(unitFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: BRANCH }) }),
    );
    expect(stockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ branchId: BRANCH }) }),
    );
  });

  it('does not leak another branch: no branch context means no branch filter', async () => {
    const { service, unitFindMany } = makeService({ branchId: null });

    await service.listStock({});

    // Tenant isolation still applies company-wide via the Prisma extension;
    // this only asserts we do not silently pin to a wrong branch.
    const where = unitFindMany.mock.calls[0][0].where;
    expect(where.branchId).toBeUndefined();
    expect(where).not.toMatchObject({ branchId: OTHER_BRANCH });
  });

  it('omits quantity stock when filtering by a lifecycle status it cannot have', async () => {
    const { service, stockFindMany } = makeService({ units: [unitRow], stock: [stockRow] });

    const rows = await service.listStock({ status: 'sold' });

    expect(stockFindMany).not.toHaveBeenCalled();
    expect(rows.every((r) => r.kind === 'unit')).toBe(true);
  });

  it('still includes quantity stock when the filter is in_stock', async () => {
    const { service, stockFindMany } = makeService({ units: [], stock: [stockRow] });

    const rows = await service.listStock({ status: 'in_stock' });

    expect(stockFindMany).toHaveBeenCalled();
    expect(rows.map((r) => r.kind)).toEqual(['stock']);
  });
});

/**
 * Cost visibility is enforced globally rather than per-endpoint, so this
 * asserts the interceptor over realistic inventory payloads — the shape most
 * likely to leak cost to a salesperson.
 */
describe('inventory rows under cost gating', () => {
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as unknown as ExecutionContext;
  const handlerOf = (data: unknown): CallHandler => ({ handle: () => of(data) });
  const cls = (permissions: string[]) => ({
    get: (k: string) =>
      ({ userId: '018f0000-0000-7000-8000-000000000009', permissions: new Set(permissions) })[k],
    set: () => {},
  });

  const rows = () => [
    { kind: 'unit', identifier: '358888000000022', status: 'in_stock', cost: 800 },
    { kind: 'stock', quantity: 10, cost: 8.5, price: 15 },
  ];

  it('keeps cost for a caller with cost.view', async () => {
    const int = new CostGatingInterceptor(cls(['cost.view']) as never, { } as never);

    const result = await lastValueFrom(await int.intercept(ctx, handlerOf(rows())));

    expect(result).toEqual(rows());
  });

  it('strips cost from both row shapes without cost.view, keeping price and quantity', async () => {
    const int = new CostGatingInterceptor(cls(['sale.create']) as never, {
      getEffectivePermissions: jest.fn(),
    } as never);

    const result = (await lastValueFrom(
      await int.intercept(ctx, handlerOf(rows())),
    )) as Record<string, unknown>[];

    expect(result[0]).toEqual({
      kind: 'unit',
      identifier: '358888000000022',
      status: 'in_stock',
    });
    expect(result[1]).toEqual({ kind: 'stock', quantity: 10, price: 15 });
  });
});
