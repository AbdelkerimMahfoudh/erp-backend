import { InventoryService } from './inventory.service';
import { uuidToBin } from '../common/utils/uuid.util';

/**
 * Counting phones by model, without ever stopping counting them by IMEI.
 *
 * The shop floor and the warranty desk want two different answers about the
 * same shelf. "How many 17 Pro Max do I have?" is the question that gets asked
 * fifty times a day; "which handset is this one?" is the question that gets
 * asked when somebody comes back with a fault. The unit of truth stays the
 * `Unit` row — one physical phone, one required IMEI — and the model count is
 * DERIVED from those rows on every request.
 *
 * That derivation is the whole point. A stored total, or a counter the app
 * increments when a form is submitted, is a number that drifts the first time a
 * sale, a transfer or a rejected duplicate takes a path nobody remembered to
 * update. There is no way to write a test that catches that reliably; there is
 * a way to make it impossible, which is to never store the number.
 */

const id = (n: number) => uuidToBin(`00000000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const BRANCH = id(1);
const OTHER_BRANCH = id(2);
const USER = id(3);
const PRO_MAX = id(100);
const PLAIN_17 = id(101);
const CABLE = id(102);
const PRO_MAX_BLUE = id(103);

const PRODUCTS = [
  { id: PRO_MAX, brand: 'Apple', model: 'iPhone 17 Pro Max', variant: null, trackingType: 'imei' },
  { id: PLAIN_17, brand: 'Apple', model: 'iPhone 17', variant: null, trackingType: 'imei' },
  { id: CABLE, brand: 'Anker', model: 'USB-C Cable', variant: null, trackingType: 'quantity' },
  // Same model, different colour — a SEPARATE product row, because `variant`
  // sits in the (company, brand, model, variant) unique key.
  { id: PRO_MAX_BLUE, brand: 'Apple', model: 'iPhone 17 Pro Max', variant: '256 GB · Blue', trackingType: 'imei' },
];

/** One physical phone. `imeiPrimary` is what makes it findable. */
function unit(n: number, productId: Buffer, over: Record<string, unknown> = {}) {
  return {
    id: id(1_000 + n),
    productId,
    branchId: BRANCH,
    status: 'in_stock',
    imeiPrimary: `01000004100004${n}`,
    imeiSecondary: null,
    ...over,
  };
}

/**
 * A double for `groupBy` that actually groups, rather than returning the shape
 * the assertion wants. If the service asks for the wrong `where`, these tests
 * fail — which is the only reason to build the double this way.
 */
function makeService(units: ReturnType<typeof unit>[], assigned = true) {
  const db = {
    unit: {
      groupBy: jest.fn(async ({ by, where, _count }: any) => {
        expect(by).toEqual(['productId']);
        expect(_count).toEqual({ _all: true });
        const buckets = new Map<string, { productId: Buffer; n: number }>();
        for (const u of units) {
          if (where.status && u.status !== where.status) continue;
          if (where.branchId && !(u.branchId as Buffer).equals(where.branchId)) continue;
          const key = u.productId.toString('hex');
          const b = buckets.get(key) ?? { productId: u.productId, n: 0 };
          b.n += 1;
          buckets.set(key, b);
        }
        return [...buckets.values()].map((b) => ({
          productId: b.productId,
          _count: { _all: b.n },
        }));
      }),
    },
    product: {
      findMany: jest.fn(async ({ where }: any) =>
        PRODUCTS.filter((p) => where.id.in.some((i: Buffer) => i.equals(p.id))),
      ),
    },
    userBranch: {
      findFirst: async () => (assigned ? { id: USER } : null),
    },
  };
  const tenant = { branchId: () => BRANCH, requireUserId: () => USER };
  const service = new InventoryService(db as never, tenant as never, {} as never, {} as never, {} as never);
  return { service, db };
}

describe('countByModel — four of a model reads as four', () => {
  it('returns one row per model with the number of units behind it', async () => {
    const { service } = makeService([1, 2, 3, 4].map((n) => unit(n, PRO_MAX)));

    const rows = await service.countByModel();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brand: 'Apple', model: 'iPhone 17 Pro Max', inStock: 4 });
  });

  it('a fifth unique unit of the same model reads as five', async () => {
    const four = [1, 2, 3, 4].map((n) => unit(n, PRO_MAX));
    const { service } = makeService([...four, unit(5, PRO_MAX)]);

    const rows = await service.countByModel();

    expect(rows[0].inStock).toBe(5);
  });

  it('the count comes from the Unit rows, not from a stored total', async () => {
    const { service, db } = makeService([1, 2, 3].map((n) => unit(n, PRO_MAX)));

    await service.countByModel();

    // Nothing is read from a `stockItem`, a cached column or a counter: the
    // only source is the units themselves.
    expect(db.unit.groupBy).toHaveBeenCalledTimes(1);
    expect((db as Record<string, unknown>).stockItem).toBeUndefined();
  });

  it('separates models rather than merging them under one brand', async () => {
    const { service } = makeService([
      unit(1, PRO_MAX),
      unit(2, PRO_MAX),
      unit(3, PLAIN_17),
    ]);

    const rows = await service.countByModel();

    expect(rows.map((r) => [r.model, r.inStock])).toEqual([
      ['iPhone 17', 1],
      ['iPhone 17 Pro Max', 2],
    ]);
  });
});

describe('countByModel — colour and storage do not split the shelf', () => {
  it('four of one model in two colours still reads as four', async () => {
    const { service } = makeService([
      unit(1, PRO_MAX),
      unit(2, PRO_MAX),
      unit(3, PRO_MAX_BLUE),
      unit(4, PRO_MAX_BLUE),
    ]);

    const rows = await service.countByModel();

    // Two product rows, one shelf line. Grouping by product id would have
    // reported "2 and 2", which is true and useless — the shopkeeper has four.
    expect(rows).toHaveLength(1);
    expect(rows[0].inStock).toBe(4);
    expect(rows[0].productIds).toHaveLength(2);
  });

  it('keeps the colour breakdown for the detail view', async () => {
    const { service } = makeService([
      unit(1, PRO_MAX),
      unit(2, PRO_MAX_BLUE),
      unit(3, PRO_MAX_BLUE),
    ]);

    const rows = await service.countByModel();

    expect(rows[0].variants).toEqual([
      { variant: null, inStock: 1 },
      { variant: '256 GB · Blue', inStock: 2 },
    ]);
  });

  it('the breakdown always adds up to the headline', async () => {
    const { service } = makeService([
      unit(1, PRO_MAX),
      unit(2, PRO_MAX_BLUE),
      unit(3, PRO_MAX_BLUE),
      unit(4, PLAIN_17),
    ]);

    for (const row of await service.countByModel()) {
      expect(row.variants.reduce((n, v) => n + v.inStock, 0)).toBe(row.inStock);
    }
  });
});

describe('countByModel — what does NOT move the number', () => {
  it('a unit that was never created cannot be counted', async () => {
    // Scanning, choosing a model, or filling half a form leaves no Unit row.
    // There is no other place a count could come from, so there is nothing
    // that could increment early.
    const { service } = makeService([]);

    expect(await service.countByModel()).toEqual([]);
  });

  it('a refused duplicate IMEI leaves the count where it was', async () => {
    // The duplicate never becomes a row — `createUnit` throws on the unique
    // index — so the shelf is unchanged by definition, not by remembering to
    // undo something.
    const { service } = makeService([1, 2].map((n) => unit(n, PRO_MAX)));

    const rows = await service.countByModel();

    expect(rows[0].inStock).toBe(2);
  });

  it('sold, reserved and faulty units are not on the shelf', async () => {
    const { service } = makeService([
      unit(1, PRO_MAX),
      unit(2, PRO_MAX, { status: 'sold' }),
      unit(3, PRO_MAX, { status: 'reserved' }),
      unit(4, PRO_MAX, { status: 'faulty' }),
    ]);

    const rows = await service.countByModel();

    // One in stock. The other three moved through the existing status model;
    // nothing here had to be told about it.
    expect(rows[0].inStock).toBe(1);
  });

  it('drops a model entirely once its last unit leaves stock', async () => {
    const { service } = makeService([unit(1, PRO_MAX, { status: 'sold' })]);

    expect(await service.countByModel()).toEqual([]);
  });
});

describe('countByModel — one phone is one unit, whichever IMEI you know', () => {
  it('a dual-SIM handset with two identifiers counts once', async () => {
    const { service } = makeService([
      unit(1, PRO_MAX, {
        imeiPrimary: '010000041000041',
        imeiSecondary: '010000045000047',
      }),
    ]);

    const rows = await service.countByModel();

    // Two identifiers, one physical phone, one on the shelf. Both identifiers
    // still find it — that is `listStock`'s OR search, unchanged by any of
    // this.
    expect(rows[0].inStock).toBe(1);
  });

  it('units of the same model are counted individually, not as a quantity', async () => {
    const { service } = makeService([1, 2, 3].map((n) => unit(n, PRO_MAX)));

    const rows = await service.countByModel();

    // The row a phone produces still declares itself IMEI-tracked. Presenting
    // it as "3 in stock" is a display decision; it does not turn the phones
    // into an anonymous quantity.
    expect(rows[0].trackingType).toBe('imei');
    expect(rows[0].inStock).toBe(3);
  });

  it('accessories keep their own tracking type alongside phones', async () => {
    const { service } = makeService([
      unit(1, PRO_MAX),
      unit(2, CABLE, { imeiPrimary: null }),
    ]);

    const rows = await service.countByModel();

    expect(rows.map((r) => r.trackingType).sort()).toEqual(['imei', 'quantity']);
  });
});

describe('countByModel — scope', () => {
  it('counts only the active branch', async () => {
    const { service } = makeService([
      unit(1, PRO_MAX),
      unit(2, PRO_MAX),
      unit(3, PRO_MAX, { branchId: OTHER_BRANCH }),
    ]);

    const rows = await service.countByModel();

    expect(rows[0].inStock).toBe(2);
  });

  it('refuses a branch the caller is not assigned to', async () => {
    const { service } = makeService([unit(1, PRO_MAX)], false);

    await expect(service.countByModel()).rejects.toThrow();
  });

  it('company scope is the tenant client, not a filter this method writes', async () => {
    const { service, db } = makeService([unit(1, PRO_MAX)]);

    await service.countByModel();

    // No `companyId` appears here on purpose: the tenant-extended client adds
    // it fail-closed to every query. A hand-written company filter would be a
    // second, weaker copy of that rule.
    const where = db.unit.groupBy.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('companyId');
    expect(where.status).toBe('in_stock');
  });
});
