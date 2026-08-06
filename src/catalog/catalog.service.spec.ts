import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * The catalog contract (G1).
 *
 * Two rules carry most of the weight here and are worth stating plainly:
 *
 *  1. **A Product IS an exact sellable variant.** iPhone 13 Pro Max 256 GB
 *     Sierra Blue is not the same row as the 128 GB one, and the tests below
 *     prove the two coexist and stay distinguishable.
 *  2. **`catalog.manage` is not pricing authority.** Metadata has no price
 *     field at all, and a caller without `price.edit` cannot set one at
 *     creation either. Cost never belongs to product metadata.
 *
 * The Prisma double stores what the database stores and enforces the real
 * constraints — company scoping, the per-company unique barcode, and the
 * history that freezes tracking mode — so a service that forgot one would fail
 * here rather than in a shop.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const USER = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const BRANCH = uuidToBin('018f0000-0000-7000-8000-00000000b001');

interface ProductRow {
  id: Buffer;
  companyId: Buffer;
  categoryId: Buffer | null;
  brand: string;
  model: string;
  variant: string | null;
  trackingType: string;
  specifications: unknown;
  barcode: string | null;
  defaultCost: unknown;
  defaultPrice: unknown;
  reorderThreshold: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  category?: { name: string } | null;
}

interface CategoryRow {
  id: Buffer;
  companyId: Buffer;
  name: string;
  defaultTrackingType: string;
  attributeSchema: unknown;
  isActive: boolean;
}

function product(over: Partial<ProductRow> = {}): ProductRow {
  return {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    categoryId: null,
    brand: 'Apple',
    model: 'iPhone 13 Pro Max',
    variant: '256GB Sierra Blue',
    trackingType: 'imei',
    specifications: null,
    barcode: null,
    defaultCost: null,
    defaultPrice: null,
    reorderThreshold: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    category: null,
    ...over,
  };
}

function makeService(
  seed: {
    products?: ProductRow[];
    categories?: CategoryRow[];
    permissions?: string[];
    companyId?: Buffer;
    units?: { productId: Buffer; branchId: Buffer; status: string }[];
    stock?: { productId: Buffer; branchId: Buffer; quantity: number; price: number }[];
    purchaseItems?: { productId: Buffer }[];
    saleItems?: { productId: Buffer; price: number }[];
  } = {},
) {
  const companyId = seed.companyId ?? COMPANY;
  const products = seed.products ?? [];
  const categories = seed.categories ?? [];
  const units = seed.units ?? [];
  const stock = seed.stock ?? [];
  const purchaseItems = seed.purchaseItems ?? [];
  const saleItems = seed.saleItems ?? [];
  const audits: any[] = [];
  const recognitions: { codeType: string; code: string; productId: Buffer }[] = [];
  const enqueued: any[] = [];

  // The tenant extension injects companyId into every where clause; the double
  // must too, or an unscoped query would pass here and leak in production.
  const scoped = (where: any = {}) => ({ companyId, ...where });
  const inCompany = (row: { companyId: Buffer }) => row.companyId.equals(companyId);

  const matchProduct = (p: ProductRow, rawWhere: any = {}) => {
    const w = scoped(rawWhere);
    if (!inCompany(p)) return false;
    if (w.id && !p.id.equals(w.id)) return false;
    if (w.barcode !== undefined && p.barcode !== w.barcode) return false;
    if (w.categoryId !== undefined && !(p.categoryId && p.categoryId.equals(w.categoryId))) return false;
    if (w.trackingType !== undefined && p.trackingType !== w.trackingType) return false;
    if (w.deletedAt !== undefined) {
      if (w.deletedAt === null && p.deletedAt !== null) return false;
      if (w.deletedAt?.not === null && p.deletedAt === null) return false;
    }
    if (w.OR) {
      const hit = w.OR.some((clause: any) => {
        const [field, cond] = Object.entries(clause)[0] as [string, any];
        // Specification matches arrive as an id list from the raw query, because
        // Prisma's JSON `string_contains` needs a path MySQL cannot supply here.
        if (field === 'id' && cond.in) return cond.in.some((id: Buffer) => p.id.equals(id));
        const value = (p as any)[field] ?? '';
        return String(value).toLowerCase().includes(String(cond.contains).toLowerCase());
      });
      if (!hit) return false;
    }
    return true;
  };

  const db: any = {
    product: {
      create: jest.fn(async ({ data }: any) => {
        // The (companyId, barcode) unique index, enforced for real.
        if (data.barcode && products.some((p) => inCompany(p) && p.barcode === data.barcode)) {
          const e: any = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        const row = product({ ...data, deletedAt: null });
        products.push(row);
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where, include }: any = {}) => {
        const hit = products.find((p) => matchProduct(p, where));
        if (!hit) return null;
        const cat = categories.find((c) => hit.categoryId && c.id.equals(hit.categoryId));
        return include?.category ? { ...hit, category: cat ? { name: cat.name } : null } : { ...hit };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const hit = products.find((p) => p.id.equals(where.id));
        if (!hit) throw new Error('not found');
        return { ...hit };
      }),
      findMany: jest.fn(async ({ where, orderBy, take, cursor, skip }: any = {}) => {
        let hits = products.filter((p) => matchProduct(p, where));
        if (orderBy?.id === 'desc') {
          hits = [...hits].sort((a, b) => Buffer.compare(b.id, a.id));
        }
        if (cursor) {
          const at = hits.findIndex((p) => p.id.equals(cursor.id));
          hits = at >= 0 ? hits.slice(at + (skip ?? 0)) : [];
        }
        return (take ? hits.slice(0, take) : hits).map((p) => ({ ...p }));
      }),
      count: jest.fn(async ({ where }: any = {}) => products.filter((p) => matchProduct(p, where)).length),
      update: jest.fn(async ({ where, data }: any) => {
        const row = products.find((p) => p.id.equals(where.id))!;
        for (const [k, v] of Object.entries(data)) {
          if (k === 'category') {
            row.categoryId = (v as any).connect ? (v as any).connect.id : null;
          } else {
            (row as any)[k] = v;
          }
        }
        return { ...row };
      }),
    },
    productCategory: {
      findUnique: jest.fn(async ({ where }: any) => {
        const hit = categories.find((c) => c.id.equals(where.id) && inCompany(c));
        return hit ? { ...hit } : null;
      }),
    },
    productRecognition: {
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = recognitions.length;
        for (let i = recognitions.length - 1; i >= 0; i--) {
          const r = recognitions[i];
          if (r.codeType === where.codeType && r.code === where.code && r.productId.equals(where.productId)) {
            recognitions.splice(i, 1);
          }
        }
        return { count: before - recognitions.length };
      }),
    },
    unit: {
      groupBy: jest.fn(async ({ where }: any) => {
        const hits = units.filter((u) => u.productId.equals(where.productId) && u.status === where.status);
        const byBranch = new Map<string, number>();
        for (const u of hits) byBranch.set(u.branchId.toString('hex'), (byBranch.get(u.branchId.toString('hex')) ?? 0) + 1);
        return [...byBranch].map(([hex, n]) => ({ branchId: Buffer.from(hex, 'hex'), _count: { _all: n } }));
      }),
      count: jest.fn(async ({ where }: any) => units.filter((u) => u.productId.equals(where.productId)).length),
    },
    stockItem: {
      findMany: jest.fn(async ({ where }: any) =>
        stock.filter((s) => s.productId.equals(where.productId)).map((s) => ({ ...s })),
      ),
      count: jest.fn(async ({ where }: any) => stock.filter((s) => s.productId.equals(where.productId)).length),
    },
    purchaseItem: {
      count: jest.fn(async ({ where }: any) => purchaseItems.filter((p) => p.productId.equals(where.productId)).length),
    },
    saleItem: {
      count: jest.fn(async ({ where }: any) => saleItems.filter((s) => s.productId.equals(where.productId)).length),
      findFirst: jest.fn(async ({ where }: any) => {
        const hit = saleItems.find((s) => s.productId.equals(where.productId));
        return hit ? { price: hit.price, sale: { soldAt: new Date('2026-02-02T00:00:00Z') } } : null;
      }),
    },
    branch: {
      findMany: jest.fn(async () => [{ id: BRANCH, name: 'Main Store' }]),
    },
    userBranch: {
      findMany: jest.fn(async () => [{ branchId: BRANCH }]),
    },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg))),
    // The specification search is a raw query (see the service for why). The
    // double answers it the way MySQL does: match the serialized document.
    $queryRaw: jest.fn(async (_strings: unknown, ...values: unknown[]) => {
      const needle = String(values[1] ?? '').replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
      return products
        .filter((p) => inCompany(p) && p.specifications && JSON.stringify(p.specifications).toLowerCase().includes(needle))
        .map((p) => ({ id: p.id }));
    }),
  };

  const permissions = new Set(seed.permissions ?? ['catalog.manage']);

  const service = new CatalogService(
    db as never,
    { companyId: () => companyId, branchId: () => BRANCH, userId: () => USER } as never,
    { record: jest.fn(async (p: unknown) => void audits.push(p)), recordTx: jest.fn(async (_tx: unknown, p: unknown) => void audits.push(p)) } as never,
    { parseSchema: () => ({}), validateValues: () => ({ extras: [] }) } as never,
    {} as never,
    {
      enqueueTx: jest.fn(async (_tx: unknown, rows: any[]) => {
        enqueued.push(...rows);
        for (const r of rows) recognitions.push({ codeType: r.codeType, code: r.code, productId: r.productId });
      }),
      processNow: jest.fn(async () => undefined),
    } as never,
    { getEffectivePermissions: jest.fn(async () => permissions) } as never,
    { get: (key: string) => (key === 'permissions' ? permissions : binToUuid(USER)) } as never,
  );

  return { service, db, products, categories, audits, recognitions, enqueued };
}

const baseDto = (over: Partial<CreateProductDto> = {}): CreateProductDto =>
  ({ brand: 'Apple', model: 'iPhone 13 Pro Max', variant: '256GB Sierra Blue', ...over }) as CreateProductDto;

// ───────────────────────────── identity ─────────────────────────────────────

describe('a Product is an exact sellable variant', () => {
  it('creates the exact variant it was given, trimmed', async () => {
    const { service, products } = makeService();

    await service.create(baseDto({ brand: '  Apple ', model: ' iPhone 13 Pro Max ', variant: ' 256GB Sierra Blue ' }));

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ brand: 'Apple', model: 'iPhone 13 Pro Max', variant: '256GB Sierra Blue' });
  });

  it('keeps two storage variants of the same model distinguishable', async () => {
    const { service, products } = makeService();

    await service.create(baseDto({ variant: '256GB Sierra Blue' }));
    await service.create(baseDto({ variant: '128GB Sierra Blue' }));

    expect(products).toHaveLength(2);
    const labels = (await service.listPage({} as never)).rows.map((r) => r.label);
    expect(labels).toContain('Apple iPhone 13 Pro Max 256GB Sierra Blue');
    expect(labels).toContain('Apple iPhone 13 Pro Max 128GB Sierra Blue');
  });

  it('an empty variant is stored as null, not as an empty string', async () => {
    const { service, products } = makeService();
    await service.create(baseDto({ variant: '   ' }));
    expect(products[0].variant).toBeNull();
  });
});

// ───────────────────────────── barcode ──────────────────────────────────────

describe('barcode', () => {
  it('normalizes and learns it for the scanner in the same transaction', async () => {
    const { service, products, recognitions } = makeService();

    await service.create(baseDto({ barcode: ' abc-123 ' }));

    expect(products[0].barcode).toBe('ABC-123');
    expect(recognitions).toEqual([
      expect.objectContaining({ codeType: 'barcode', code: 'ABC-123', productId: products[0].id }),
    ]);
  });

  it('refuses a barcode another product already uses (409), never a silent steal', async () => {
    const existing = product({ barcode: 'SHARED1' });
    const { service, products } = makeService({ products: [existing] });

    await expect(service.create(baseDto({ model: 'Other', barcode: 'shared1' }))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(products).toHaveLength(1);
  });

  it('moving a barcode drops the old scanner mapping and learns the new one', async () => {
    const p = product({ barcode: 'OLD1' });
    const { service, recognitions } = makeService({ products: [p] });
    recognitions.push({ codeType: 'barcode', code: 'OLD1', productId: p.id });

    await service.update(binToUuid(p.id), { barcode: 'NEW1' } as UpdateProductDto);

    // The old code must no longer resolve to this product, or the next scan of
    // it would confidently open the wrong one.
    expect(recognitions.find((r) => r.code === 'OLD1')).toBeUndefined();
    expect(recognitions.find((r) => r.code === 'NEW1')?.productId).toEqual(p.id);
  });

  it('clearing the barcode removes its mapping', async () => {
    const p = product({ barcode: 'OLD1' });
    const { service, recognitions } = makeService({ products: [p] });
    recognitions.push({ codeType: 'barcode', code: 'OLD1', productId: p.id });

    await service.update(binToUuid(p.id), { barcode: '' } as UpdateProductDto);

    expect(recognitions).toHaveLength(0);
  });
});

// ───────────────────────── price / cost boundary ────────────────────────────

describe('catalog.manage is not pricing authority', () => {
  it('refuses a selling price from a caller who lacks price.edit', async () => {
    const { service, products } = makeService({ permissions: ['catalog.manage'] });

    await expect(service.create(baseDto({ defaultPrice: 999 }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(products).toHaveLength(0);
  });

  it('refuses a cost the same way — cost belongs to receiving, not metadata', async () => {
    const { service } = makeService({ permissions: ['catalog.manage'] });
    await expect(service.create(baseDto({ defaultCost: 500 }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows it when the caller also holds price.edit', async () => {
    const { service, products } = makeService({ permissions: ['catalog.manage', 'price.edit'] });

    await service.create(baseDto({ defaultPrice: 999 }));

    expect(products[0].defaultPrice).toBe(999);
  });

  it('the metadata edit has no price or cost field to smuggle one through', async () => {
    const p = product({ defaultPrice: 100 });
    const { service } = makeService({ products: [p], permissions: ['catalog.manage'] });

    await service.update(binToUuid(p.id), { brand: 'Renamed', defaultPrice: 5, defaultCost: 5 } as never);

    // Whitelisting is what the global pipe does; the service must also simply
    // have nowhere to put them.
    expect(p.defaultPrice).toBe(100);
    expect(p.defaultCost).toBeNull();
  });

  it('rejects cost/price/margin smuggled into specifications', async () => {
    const { service } = makeService();
    for (const key of ['cost', 'price', 'unit_cost', 'margin', 'profit']) {
      await expect(service.create(baseDto({ specifications: { [key]: 10 } }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });
});

// ───────────────────────── specifications bounds ────────────────────────────

describe('specifications are bounded', () => {
  it('accepts an ordinary variant spec', async () => {
    const { service, products } = makeService();
    await service.create(baseDto({ specifications: { storage: '256GB', color: 'Sierra Blue' } }));
    expect(products[0].specifications).toEqual({ storage: '256GB', color: 'Sierra Blue' });
  });

  it('rejects too many fields, over-long values and excessive nesting', async () => {
    const { service } = makeService();
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, i]));
    await expect(service.create(baseDto({ specifications: many }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(baseDto({ specifications: { a: 'x'.repeat(201) } }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.create(baseDto({ specifications: { a: { b: { c: { d: 1 } } } } })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ───────────────────────────── category ─────────────────────────────────────

describe('category', () => {
  it("rejects another company's category as not found", async () => {
    const foreign: CategoryRow = {
      id: newUuidV7Bin(),
      companyId: OTHER_COMPANY,
      name: 'Theirs',
      defaultTrackingType: 'quantity',
      attributeSchema: null,
      isActive: true,
    };
    const { service, products } = makeService({ categories: [foreign] });

    await expect(service.create(baseDto({ categoryId: binToUuid(foreign.id) }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(products).toHaveLength(0);
  });

  it('takes its tracking mode from the category by default', async () => {
    const cat: CategoryRow = {
      id: newUuidV7Bin(),
      companyId: COMPANY,
      name: 'Accessories',
      defaultTrackingType: 'quantity',
      attributeSchema: null,
      isActive: true,
    };
    const { service, products } = makeService({ categories: [cat] });

    await service.create(baseDto({ categoryId: binToUuid(cat.id) }));

    expect(products[0].trackingType).toBe('quantity');
  });
});

// ───────────────────────── tracking-mode immutability ───────────────────────

describe('tracking mode freezes once history exists', () => {
  it('can change while the product has never been stocked or sold', async () => {
    const p = product({ trackingType: 'imei' });
    const { service } = makeService({ products: [p] });

    await service.update(binToUuid(p.id), { trackingType: 'quantity' } as UpdateProductDto);

    expect(p.trackingType).toBe('quantity');
  });

  it.each([
    ['units', { units: [{ productId: undefined as never, branchId: BRANCH, status: 'in_stock' }] }],
    ['stock', { stock: [{ productId: undefined as never, branchId: BRANCH, quantity: 3, price: 10 }] }],
    ['purchase history', { purchaseItems: [{ productId: undefined as never }] }],
    ['sale history', { saleItems: [{ productId: undefined as never, price: 10 }] }],
  ])('refuses once %s exists', async (_label, extra) => {
    const p = product({ trackingType: 'imei' });
    // Point the seeded history at this product.
    for (const rows of Object.values(extra)) (rows as any[]).forEach((r) => (r.productId = p.id));
    const { service } = makeService({ products: [p], ...(extra as object) });

    await expect(
      service.update(binToUuid(p.id), { trackingType: 'quantity' } as UpdateProductDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(p.trackingType).toBe('imei');
  });
});

// ───────────────────────────── lifecycle ────────────────────────────────────

describe('lifecycle: archive and restore, never delete', () => {
  it('archives without deleting the row, and audits the status change', async () => {
    const p = product();
    const { service, products, audits } = makeService({ products: [p] });

    const view = await service.setActive(binToUuid(p.id), false);

    expect(products).toHaveLength(1); // never hard-deleted
    expect(p.deletedAt).toBeInstanceOf(Date);
    expect(view.isActive).toBe(false);
    const entry = audits.find((a) => a.entityType === 'Product' && a.action === 'status_change');
    expect(entry.before).toEqual({ isActive: true });
    expect(entry.after).toEqual({ isActive: false });
  });

  it('hides archived products from the default catalog list but keeps them findable', async () => {
    const live = product({ model: 'Live' });
    const archived = product({ model: 'Archived', deletedAt: new Date() });
    const { service } = makeService({ products: [live, archived] });

    const def = await service.listPage({} as never);
    expect(def.rows.map((r) => r.model)).toEqual(['Live']);

    const inactive = await service.listPage({ active: 'inactive' } as never);
    expect(inactive.rows.map((r) => r.model)).toEqual(['Archived']);

    const all = await service.listPage({ active: 'all' } as never);
    expect(all.rows).toHaveLength(2);
  });

  it('an archived product still reports its existing stock — it stays sellable', async () => {
    const p = product({ trackingType: 'quantity', deletedAt: new Date() });
    const { service } = makeService({
      products: [p],
      stock: [{ productId: p.id, branchId: BRANCH, quantity: 4, price: 25 }],
    });

    const detail = await service.getDetail(binToUuid(p.id));

    expect(detail.isActive).toBe(false);
    expect(detail.totalStock).toBe(4);
  });

  it('restores an archived product, and both verbs are idempotent', async () => {
    const p = product({ deletedAt: new Date() });
    const { service } = makeService({ products: [p] });

    await service.setActive(binToUuid(p.id), true);
    expect(p.deletedAt).toBeNull();

    const again = await service.setActive(binToUuid(p.id), true);
    expect(again.isActive).toBe(true);
  });
});

// ───────────────────────── list, search, pagination ─────────────────────────

describe('browsing', () => {
  it('searches brand, model, variant, barcode and specifications', async () => {
    const { service } = makeService({
      products: [
        product({ brand: 'Apple', model: 'iPhone 13', variant: '256GB Sierra Blue', barcode: 'AAA1' }),
        product({ brand: 'Samsung', model: 'Galaxy S22', variant: '128GB Black', barcode: 'BBB2' }),
        product({ brand: 'Anker', model: 'PowerCore', variant: null, specifications: { color: 'Sierra Blue' } }),
      ],
    });

    const byBrand = await service.listPage({ q: 'samsung' } as never);
    expect(byBrand.rows.map((r) => r.brand)).toEqual(['Samsung']);

    const byBarcode = await service.listPage({ q: 'AAA1' } as never);
    expect(byBarcode.rows.map((r) => r.model)).toEqual(['iPhone 13']);

    // "Sierra Blue" appears as a variant on one and inside specifications on
    // another — both must be findable by the words a person actually types.
    const bySpec = await service.listPage({ q: 'Sierra Blue' } as never);
    expect(bySpec.rows).toHaveLength(2);
  });

  it('filters by category and tracking mode', async () => {
    const cat = newUuidV7Bin();
    const { service } = makeService({
      products: [
        product({ model: 'Phone', trackingType: 'imei', categoryId: cat }),
        product({ model: 'Cable', trackingType: 'quantity' }),
      ],
    });

    expect((await service.listPage({ trackingType: 'quantity' } as never)).rows.map((r) => r.model)).toEqual(['Cable']);
    expect((await service.listPage({ categoryId: binToUuid(cat) } as never)).rows.map((r) => r.model)).toEqual(['Phone']);
  });

  it('pages with a cursor and never repeats or skips a row', async () => {
    const many = Array.from({ length: 7 }, (_, i) => product({ model: `P${i}` }));
    const { service } = makeService({ products: many });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: any = await service.listPage({ limit: 3, ...(cursor ? { cursor } : {}) } as never);
      seen.push(...res.rows.map((r: any) => r.id));
      cursor = res.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7); // no duplicates
  });

  it('reports the filtered total alongside the page', async () => {
    const { service } = makeService({ products: [product(), product({ model: 'B' }), product({ model: 'C' })] });
    const res = await service.listPage({ limit: 2 } as never);
    expect(res.rows).toHaveLength(2);
    expect(res.totalActive).toBe(3);
    expect(res.nextCursor).not.toBeNull();
  });

  it('marks serialized and quantity rows so the UI never has to guess', async () => {
    const { service } = makeService({
      products: [product({ trackingType: 'imei' }), product({ model: 'Cable', trackingType: 'quantity' })],
    });
    const rows = await service.listPage({} as never);
    expect(rows.rows.find((r) => r.model === 'Cable')!.serialized).toBe(false);
    expect(rows.rows.find((r) => r.trackingType === 'imei')!.serialized).toBe(true);
  });
});

// ───────────────────────── company isolation ────────────────────────────────

describe('company isolation', () => {
  it("never lists, reads or edits another company's product", async () => {
    const foreign = product({ companyId: OTHER_COMPANY, model: 'Theirs' });
    const { service } = makeService({ products: [foreign] });

    expect((await service.listPage({ active: 'all' } as never)).rows).toEqual([]);
    await expect(service.getDetail(binToUuid(foreign.id))).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.update(binToUuid(foreign.id), { brand: 'Hijacked' } as UpdateProductDto),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(foreign.brand).toBe('Apple');
  });

  it('a malformed or unknown id is not found', async () => {
    const { service } = makeService();
    await expect(service.getDetail('not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getDetail(binToUuid(newUuidV7Bin()))).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ───────────────────────────── detail + update ──────────────────────────────

describe('detail', () => {
  it('summarises stock per accessible branch and the existing price information', async () => {
    const p = product({ trackingType: 'quantity' });
    const { service } = makeService({
      products: [p],
      stock: [{ productId: p.id, branchId: BRANCH, quantity: 6, price: 30 }],
      saleItems: [{ productId: p.id, price: 28 }],
    });

    const detail = await service.getDetail(binToUuid(p.id));

    expect(detail.stockByBranch).toEqual([
      { branchId: binToUuid(BRANCH), branchName: 'Main Store', quantity: 6, price: 30 },
    ]);
    expect(detail.totalStock).toBe(6);
    expect(detail.lastSoldPrice).toBe(28);
    // No IMEI list on the catalog response — unit lists stay on inventory.
    expect(JSON.stringify(detail)).not.toContain('imei');
  });

  it('tells the client whether tracking mode can still change', async () => {
    // The edit form disables the control instead of letting the user try and
    // collect a 409, so the flag has to be honest in both directions.
    const fresh = product();
    const used = product({ model: 'Used' });
    const ctx = makeService({ products: [fresh, used], units: [{ productId: used.id, branchId: BRANCH, status: 'in_stock' }] });

    expect((await ctx.service.getDetail(binToUuid(fresh.id))).canChangeTracking).toBe(true);
    expect((await ctx.service.getDetail(binToUuid(used.id))).canChangeTracking).toBe(false);
  });

  it('counts in-stock units per branch for a serialized product', async () => {
    const p = product({ trackingType: 'imei' });
    const { service } = makeService({
      products: [p],
      units: [
        { productId: p.id, branchId: BRANCH, status: 'in_stock' },
        { productId: p.id, branchId: BRANCH, status: 'in_stock' },
        { productId: p.id, branchId: BRANCH, status: 'sold' },
      ],
    });

    const detail = await service.getDetail(binToUuid(p.id));

    expect(detail.totalStock).toBe(2); // sold units are not stock
    expect(detail.stockByBranch[0].price).toBeNull(); // serialized has no stock price
  });
});

describe('metadata update', () => {
  it('edits identity without touching stock history, and audits old and new', async () => {
    const p = product({ brand: 'Aple' });
    const { service, audits } = makeService({
      products: [p],
      units: [{ productId: p.id, branchId: BRANCH, status: 'in_stock' }],
    });

    const view = await service.update(binToUuid(p.id), { brand: 'Apple' } as UpdateProductDto);

    expect(view.brand).toBe('Apple');
    const entry = audits.find((a) => a.entityType === 'Product' && a.action === 'update');
    expect(entry.before).toEqual({ brand: 'Aple' });
    expect(entry.after).toEqual({ brand: 'Apple' });
    // The unit is still attached and still counted.
    expect(view.totalStock).toBe(1);
  });

  it('rejects an empty edit rather than writing a no-op', async () => {
    const p = product();
    const { service } = makeService({ products: [p] });
    await expect(service.update(binToUuid(p.id), {} as UpdateProductDto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('never records a price or a cost in the audit trail', async () => {
    const p = product({ defaultPrice: 100, defaultCost: 60 });
    const { service, audits } = makeService({ products: [p] });

    await service.update(binToUuid(p.id), { model: 'Renamed' } as UpdateProductDto);

    const entry = audits.find((a) => a.action === 'update');
    expect(JSON.stringify(entry)).not.toMatch(/defaultPrice|defaultCost|100|60/);
  });
});
