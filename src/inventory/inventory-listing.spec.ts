import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { CostGatingInterceptor } from '../common/interceptors/cost-gating.interceptor';
import { InventoryService, type InventoryPage } from './inventory.service';
import { decodeCursor, encodeCursor } from './inventory-cursor';
import { uuidToBin, binToUuid } from '../common/utils/uuid.util';

/**
 * `listStock` answers "what is physically here?" — the one listing an employee
 * trusts when deciding whether they can sell something.
 *
 * Two failures matter more than anything else here and are pinned below:
 *  1. Hiding quantity-tracked stock entirely (the original bug).
 *  2. Silently truncating or skipping rows while paging, which looks identical
 *     to "we don't have it" from behind a counter.
 *
 * The Prisma double is a small in-memory store rather than a stub returning
 * canned arrays: pagination correctness lives in the where/orderBy/take
 * interplay, so a stub that ignores them would assert nothing.
 */

const BRANCH = uuidToBin('018f0000-0000-7000-8000-0000000000b1');
const OTHER_BRANCH = uuidToBin('018f0000-0000-7000-8000-0000000000b2');
const PRODUCT = uuidToBin('018f0000-0000-7000-8000-0000000000p1'.replace(/p/g, 'a'));

function id(n: number): Buffer {
  return uuidToBin(`018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`);
}

const baseProduct = {
  brand: 'Apple',
  model: 'iPhone 15',
  variant: '256GB',
  barcode: '190199999999',
  trackingType: 'imei',
  specifications: { storage: '256GB', colour: 'Black' },
};

function makeUnit(n: number, over: Record<string, unknown> = {}) {
  return {
    id: id(n),
    branchId: BRANCH,
    productId: PRODUCT,
    imeiPrimary: `35688800000${String(n).padStart(4, '0')}`,
    imeiSecondary: null,
    serialNo: null,
    status: 'in_stock',
    cost: 800,
    // Deliberately identical for every unit: a bulk receive stamps many units
    // inside the same microsecond, which is precisely where a naive `<` cursor
    // drops rows.
    dateIn: new Date('2026-01-01T00:00:00.000Z'),
    product: baseProduct,
    ...over,
  };
}

function makeStock(n: number, over: Record<string, unknown> = {}) {
  return {
    id: id(10_000 + n),
    branchId: BRANCH,
    productId: id(20_000 + n),
    quantity: 10,
    cost: 8.5,
    price: 15,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    product: { ...baseProduct, trackingType: 'quantity', brand: 'Anker', model: `Cable ${n}` },
    ...over,
  };
}

// ── Minimal in-memory Prisma implementing only what listStock uses ──────────

function matches(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === 'OR') {
      if (!(cond as any[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
    } else if (Buffer.isBuffer(cond)) {
      if (!Buffer.isBuffer(value) || !value.equals(cond)) return false;
    } else if (cond && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('lt' in c && !(value < (c.lt as never))) return false;
      if ('gt' in c && !(value > (c.gt as never))) return false;
      if ('contains' in c) {
        if (value == null) return false;
        if (!String(value).toLowerCase().includes(String(c.contains).toLowerCase())) return false;
      }
      if ('notIn' in c) {
        const list = c.notIn as Buffer[];
        if (list.some((b) => Buffer.isBuffer(value) && value.equals(b))) return false;
      }
      // Nested relation filter, e.g. { product: { brand: { contains } } }
      const nestedKeys = Object.keys(c).filter((k) => !['lt', 'gt', 'contains', 'notIn'].includes(k));
      if (nestedKeys.length && value && typeof value === 'object') {
        if (!matches(value, Object.fromEntries(nestedKeys.map((k) => [k, c[k]])))) return false;
      }
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

/** Sole sort key: UUIDv7 id, descending. Unique, so there are no ties. */
function sortDesc(rows: any[]) {
  return [...rows].sort((a, b) => Buffer.compare(b.id, a.id));
}

function makeStore(units: any[], stock: any[], branchId: Buffer | null = BRANCH) {
  const model = (rows: any[]) => ({
    findMany: jest.fn(async ({ where, take, cursor, skip }: any) => {
      let page = sortDesc(rows.filter((r) => matches(r, where)));
      if (cursor?.id) {
        // Prisma resolves the anchor by primary key, independently of `where`.
        // Mirrored here so the "anchor row left the filtered set" case is a
        // real test rather than an accident of the double.
        const ordered = sortDesc(rows);
        const anchor = ordered.find((r: any) => r.id.equals(cursor.id));
        page = anchor
          ? page.filter((r: any) => Buffer.compare(r.id, anchor.id) < 0)
          : [];
        if (skip && !anchor) page = [];
      }
      return page.slice(0, take);
    }),
    count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
  });
  const db = { unit: model(units), stockItem: model(stock) };
  const tenant = { branchId: () => branchId };
  const service = new InventoryService(db as never, tenant as never, {} as never, {} as never);
  return { service, db };
}

/** Walk every page, returning the flattened rows and the page count. */
async function drain(service: InventoryService, filter: Record<string, unknown> = {}) {
  const all: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: InventoryPage = await service.listStock({ ...filter, cursor: cursor ?? undefined });
    all.push(...page.rows);
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 50) throw new Error('pagination did not terminate');
  } while (cursor);
  return { all, pages };
}

describe('listStock — shapes', () => {
  it('returns serialized units with a derived identifier', async () => {
    const { service } = makeStore([makeUnit(1)], []);
    const page = await service.listStock({});
    expect(page.rows[0]).toMatchObject({ kind: 'unit', identifier: '356888000000001', status: 'in_stock' });
  });

  it('falls back to the serial number when there is no IMEI', async () => {
    const { service } = makeStore([makeUnit(1, { imeiPrimary: null, serialNo: 'BRV-B-77' })], []);
    const page = await service.listStock({});
    expect(page.rows[0]).toMatchObject({ identifier: 'BRV-B-77' });
  });

  it('includes quantity stock — the regression this listing exists to fix', async () => {
    const { service } = makeStore([], [makeStock(1)]);
    const page = await service.listStock({});
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ kind: 'stock', quantity: 10 });
  });

  it('excludes zero-quantity rows', async () => {
    const { service } = makeStore([], [makeStock(1, { quantity: 0 })]);
    const page = await service.listStock({});
    expect(page.rows).toHaveLength(0);
    expect(page.totals.stock).toBe(0);
  });

  it('scopes to the active branch and never leaks another', async () => {
    const { service } = makeStore(
      [makeUnit(1), makeUnit(2, { branchId: OTHER_BRANCH })],
      [makeStock(1), makeStock(2, { branchId: OTHER_BRANCH })],
    );
    const { all } = await drain(service);
    expect(all).toHaveLength(2);
    expect(all.every((r) => !r.identifier || r.identifier === '356888000000001')).toBe(true);
  });

  it('omits quantity stock under a lifecycle status it cannot have', async () => {
    const { service, db } = makeStore([makeUnit(1, { status: 'sold' })], [makeStock(1)]);
    const page = await service.listStock({ status: 'sold' as never });
    expect(db.stockItem.findMany).not.toHaveBeenCalled();
    expect(page.rows.every((r) => r.kind === 'unit')).toBe(true);
    expect(page.totals.stock).toBe(0);
  });
});

describe('listStock — pagination', () => {
  const MANY = 220;

  it('does not truncate at 200: every row is reachable across pages', async () => {
    const units = Array.from({ length: MANY }, (_, i) => makeUnit(i + 1));
    const { service } = makeStore(units, []);

    const { all, pages } = await drain(service, { limit: 50 });

    expect(all).toHaveLength(MANY);
    expect(pages).toBeGreaterThan(1);
  });

  it('never repeats a row between pages, even with identical timestamps', async () => {
    const units = Array.from({ length: MANY }, (_, i) => makeUnit(i + 1));
    const { service } = makeStore(units, []);

    const { all } = await drain(service, { limit: 50 });
    const ids = all.map((r) => binToUuid(r.id));

    expect(new Set(ids).size).toBe(MANY);
  });

  it('pages across both shapes and reports totals for each', async () => {
    const units = Array.from({ length: 60 }, (_, i) => makeUnit(i + 1));
    const stock = Array.from({ length: 30 }, (_, i) => makeStock(i + 1));
    const { service } = makeStore(units, stock);

    const first = await service.listStock({ limit: 50 });
    expect(first.totals).toEqual({ units: 60, stock: 30 });
    expect(first.hasMore).toBe(true);

    const { all } = await drain(service, { limit: 50 });
    expect(all.filter((r) => r.kind === 'unit')).toHaveLength(60);
    expect(all.filter((r) => r.kind === 'stock')).toHaveLength(30);
  });

  it('totals describe the whole result, not the page — so a first page cannot masquerade as everything', async () => {
    const units = Array.from({ length: MANY }, (_, i) => makeUnit(i + 1));
    const { service } = makeStore(units, []);

    const page = await service.listStock({ limit: 10 });

    expect(page.rows).toHaveLength(10);
    expect(page.totals.units).toBe(MANY);
    expect(page.hasMore).toBe(true);
  });

  it('final page reports hasMore false and a null cursor', async () => {
    const { service } = makeStore([makeUnit(1), makeUnit(2)], []);
    const page = await service.listStock({ limit: 50 });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('empty result is a clean terminal page', async () => {
    const { service } = makeStore([], []);
    const page = await service.listStock({});
    expect(page).toMatchObject({ rows: [], nextCursor: null, hasMore: false });
    expect(page.totals).toEqual({ units: 0, stock: 0 });
  });

  it('survives the anchor row leaving the filtered set between pages', async () => {
    const units = Array.from({ length: 120 }, (_, i) => makeUnit(i + 1));
    const { service } = makeStore(units, []);
    const first = await service.listStock({ status: 'in_stock' as never, limit: 50 });

    /**
     * The realistic staleness: somebody sells the anchor unit while a colleague
     * is scrolling. The row still EXISTS — nothing financial is hard-deleted —
     * it simply no longer matches `status: in_stock`.
     *
     * This is exactly why the sort key is the primary key: Prisma resolves the
     * anchor by id regardless of the filter, so paging continues from the right
     * place instead of truncating the list at page one.
     */
    const anchor = decodeCursor(first.nextCursor!);
    const afterSale = units.map((u) =>
      binToUuid(u.id) === anchor.id ? { ...u, status: 'sold' } : u,
    );
    const { service: after } = makeStore(afterSale, []);

    const second = await after.listStock({
      status: 'in_stock' as never,
      limit: 50,
      cursor: first.nextCursor!,
    });

    expect(second.rows.length).toBeGreaterThan(0);
    // And it resumes past the anchor rather than repeating earlier rows.
    const firstIds = new Set(first.rows.map((r) => binToUuid(r.id)));
    expect(second.rows.every((r) => !firstIds.has(binToUuid(r.id)))).toBe(true);
  });

  it('rejects a malformed cursor rather than silently restarting', async () => {
    const { service } = makeStore([makeUnit(1)], []);
    await expect(service.listStock({ cursor: 'not-a-cursor' })).rejects.toThrow(/cursor/i);
    await expect(
      service.listStock({ cursor: encodeCursor({ section: 'unit', at: 'nonsense', seen: [] } as never) }),
    ).rejects.toThrow(/cursor/i);
  });
});

describe('listStock — server-side search', () => {
  const fixtures = () => [
    makeUnit(1, { imeiPrimary: '356888000000111' }),
    makeUnit(2, {
      imeiPrimary: '356888000000222',
      product: { ...baseProduct, brand: 'Samsung', model: 'Galaxy A55', barcode: '880000123' },
    }),
  ];

  it('finds by product name', async () => {
    const { service } = makeStore(fixtures(), []);
    const page = await service.listStock({ search: 'galaxy' });
    expect(page.rows).toHaveLength(1);
    expect(page.totals.units).toBe(1);
  });

  it('finds by IMEI fragment — the digits an employee reads off the device', async () => {
    const { service } = makeStore(fixtures(), []);
    const page = await service.listStock({ search: '000222' });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ identifier: '356888000000222' });
  });

  it('finds by barcode', async () => {
    const { service } = makeStore(fixtures(), []);
    const page = await service.listStock({ search: '880000123' });
    expect(page.rows).toHaveLength(1);
  });

  it('searches the whole branch, not only the first page', async () => {
    const many = Array.from({ length: 120 }, (_, i) => makeUnit(i + 1));
    // The only match sits far beyond the first page.
    many.push(makeUnit(999, { imeiPrimary: '356888000009999' }));
    const { service } = makeStore(many, []);

    const page = await service.listStock({ search: '0009999', limit: 20 });

    expect(page.rows).toHaveLength(1);
    expect(page.totals.units).toBe(1);
  });

  it('combines with a status filter', async () => {
    const { service } = makeStore(
      [
        makeUnit(1, { status: 'sold', product: { ...baseProduct, model: 'Galaxy A55' } }),
        makeUnit(2, { status: 'in_stock', product: { ...baseProduct, model: 'Galaxy A55' } }),
      ],
      [],
    );
    const page = await service.listStock({ search: 'galaxy', status: 'sold' as never });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ status: 'sold' });
  });
});

describe('listStock — exact variants', () => {
  it('keeps two same-model units distinguishable by their specifications', async () => {
    const { service } = makeStore(
      [
        makeUnit(1, { product: { ...baseProduct, specifications: { storage: '128GB', colour: 'Black' } } }),
        makeUnit(2, { product: { ...baseProduct, specifications: { storage: '256GB', colour: 'Blue' } } }),
      ],
      [],
    );

    const page = await service.listStock({});
    const specs = page.rows.map((r) => r.product?.specifications);

    expect(specs).toContainEqual({ storage: '128GB', colour: 'Black' });
    expect(specs).toContainEqual({ storage: '256GB', colour: 'Blue' });
  });

  it('distinguishes aggregated stock variants, which have no identifier to tell them apart', async () => {
    const { service } = makeStore(
      [],
      [
        makeStock(1, { product: { ...baseProduct, trackingType: 'quantity', specifications: { length: '1m', colour: 'White' } } }),
        makeStock(2, { product: { ...baseProduct, trackingType: 'quantity', specifications: { length: '2m', colour: 'Black' } } }),
      ],
    );

    const page = await service.listStock({});
    const specs = page.rows.map((r) => r.product?.specifications);

    // Order is by id descending, not insertion order — assert membership.
    expect(specs).toHaveLength(2);
    expect(specs).toContainEqual({ length: '1m', colour: 'White' });
    expect(specs).toContainEqual({ length: '2m', colour: 'Black' });
  });

  it('still works when specifications are null', async () => {
    const { service } = makeStore([makeUnit(1, { product: { ...baseProduct, specifications: null } })], []);
    const page = await service.listStock({});
    expect(page.rows[0].product?.specifications).toBeNull();
  });
});

/**
 * Cost visibility is enforced globally, so it is asserted over realistic
 * inventory payloads — including a later page, where a per-endpoint approach
 * would be easiest to forget.
 */
describe('inventory rows under cost gating', () => {
  const ctx = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as unknown as ExecutionContext;
  const handlerOf = (data: unknown): CallHandler => ({ handle: () => of(data) });
  const cls = (permissions: string[]) => ({
    get: (k: string) =>
      ({ userId: '018f0000-0000-7000-8000-000000000009', permissions: new Set(permissions) })[k],
    set: () => {},
  });

  const payload = () => ({
    rows: [
      { kind: 'unit', identifier: '356888000000001', status: 'in_stock', cost: 800 },
      { kind: 'stock', quantity: 10, cost: 8.5, price: 15 },
    ],
    nextCursor: 'abc',
    hasMore: true,
    totals: { units: 220, stock: 4 },
  });

  it('keeps cost for a caller with cost.view', async () => {
    const int = new CostGatingInterceptor(cls(['cost.view']) as never, {} as never);
    const result = await lastValueFrom(await int.intercept(ctx, handlerOf(payload())));
    expect(result).toEqual(payload());
  });

  it('strips cost from both shapes without cost.view, on any page, keeping price and pagination intact', async () => {
    const int = new CostGatingInterceptor(cls(['sale.create']) as never, {
      getEffectivePermissions: jest.fn(),
    } as never);

    const result = (await lastValueFrom(await int.intercept(ctx, handlerOf(payload())))) as any;

    expect(result.rows[0]).toEqual({ kind: 'unit', identifier: '356888000000001', status: 'in_stock' });
    expect(result.rows[1]).toEqual({ kind: 'stock', quantity: 10, price: 15 });
    // Pagination metadata must survive the strip, or later pages become
    // unreachable for exactly the roles that cannot see cost.
    expect(result.nextCursor).toBe('abc');
    expect(result.hasMore).toBe(true);
    expect(result.totals).toEqual({ units: 220, stock: 4 });
  });
});
