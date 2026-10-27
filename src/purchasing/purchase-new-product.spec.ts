import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PurchasingService } from './purchasing.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * Scanner-led intake creates the product and receives it in ONE transaction
 * (D223). The product, the unit, the cost, the payment and the audit exist
 * together or not at all, and nothing reports a product-only success.
 *
 * All identifiers here are fictional test values.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const BRANCH = uuidToBin('018f0000-0000-7000-8000-0000000000b1');
const EXISTING = '018f0000-0000-7000-8000-00000000a001';
const KEY = '018f0000-0000-7000-8000-00000000e001';

const newPhone = { brand: 'Fictiva', model: 'Test Phone 1', variant: '128GB Grey', trackingType: 'imei' };
const newLine = (over: Record<string, unknown> = {}) => ({
  newProduct: newPhone,
  unitCost: 900,
  identifiers: ['356888000000001'],
  ...over,
});
const body = (items: unknown[], over: Record<string, unknown> = {}) =>
  ({ clientUuid: KEY, paymentMethod: 'cash', items, ...over }) as never;

interface Options {
  failUnit?: boolean;
  registered?: string[];
  existingProduct?: boolean;
  mayManageCatalog?: boolean;
}

function harness(opts: Options = {}) {
  const writes = { products: [] as any[], purchases: [] as any[], units: [] as any[], payments: [] as any[] };
  const purchases: any[] = [];
  const db: any = {
    purchase: {
      findFirst: jest.fn(async ({ where }: any) =>
        purchases.find((p) => p.clientUuid.equals(where.clientUuid)) ?? null,
      ),
    },
    receivingAccount: { findFirst: jest.fn(async () => null) },
    product: {
      findMany: jest.fn(async () => [{ id: uuidToBin(EXISTING), trackingType: 'imei', defaultPrice: 2000 }]),
      findFirst: jest.fn(async ({ where }: any) => {
        if (opts.existingProduct) return { id: uuidToBin(EXISTING) };
        return writes.products.find((p) => p.brand === where.brand && p.model === where.model) ?? null;
      }),
    },
    $transaction: jest.fn(async (fn: any) => {
      // All-or-nothing: collect in a scratch set and publish only on success.
      const staged = { products: [] as any[], purchases: [] as any[], units: [] as any[], payments: [] as any[] };
      const tx = {
        product: { create: async ({ data }: any) => (staged.products.push(data), data) },
        purchase: { create: async ({ data }: any) => void staged.purchases.push(data) },
        purchaseItem: { create: async () => ({}) },
        supplierPayment: { create: async ({ data }: any) => void staged.payments.push(data) },
        rollupRequest: { createMany: async () => ({}) },
        staged,
      };
      const result = await fn(tx);
      writes.products.push(...staged.products);
      writes.purchases.push(...staged.purchases);
      writes.units.push(...staged.units);
      writes.payments.push(...staged.payments);
      purchases.push(...staged.purchases.map((p) => ({ ...p, items: [], units: staged.units.map((u) => ({ ...u, id: newUuidV7Bin() })), total: p.total })));
      return result;
    }),
  };
  const inventory: any = {
    findExistingIdentifiers: jest.fn(async (ids: string[]) => new Set(ids.filter((id) => opts.registered?.includes(id)))),
    findVoidedUnits: jest.fn(async () => new Map()),
    createUnit: jest.fn(async (tx: any, data: any) => {
      if (opts.failUnit) throw new Error('unit insert failed');
      tx.staged.units.push({ ...data, imeiPrimary: data.imeiPrimary });
      return {};
    }),
  };
  const strategies: any = {
    get: (mode: string) => ({
      perUnit: mode !== 'quantity',
      identifierField: mode === 'serial' ? 'serialNo' : 'imeiPrimary',
      identifierLabel: mode === 'serial' ? 'Serial' : 'IMEI',
      validateIdentifier: () => ({ ok: true }),
      normalize: (v: string) => v,
      recognitionKey: () => null,
    }),
  };
  const catalog: any = {
    assertMayManageCatalog: jest.fn(async () => {
      if (opts.mayManageCatalog === false) throw new ForbiddenException({ code: 'catalog_manage_required' });
    }),
    prepareProduct: jest.fn(async (np: any) => ({
      data: {
        id: newUuidV7Bin(),
        companyId: COMPANY,
        brand: np.brand,
        model: np.model,
        variant: np.variant ?? null,
        trackingType: np.trackingType ?? 'imei',
        barcode: null,
      },
      extras: [],
    })),
    insertProductTx: jest.fn(async (tx: any, prepared: any) => tx.product.create({ data: prepared.data })),
  };
  const service = new PurchasingService(
    db,
    { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => null } as never,
    { recordTx: async () => ({}) } as never,
    inventory,
    { emit: async () => ({}) } as never,
    strategies,
    {} as never,
    { enqueueTx: async () => ({}), processNow: async () => ({}) } as never,
    { processNow: async () => undefined } as never,
    { assign: async () => '2026-10-27', today: async () => '2026-10-27' } as never,
    { assertCounterOpen: async () => undefined, assertCounterOpenTx: async () => undefined } as never,
    catalog,
  );
  return { service, writes, catalog, db };
}

describe('creating a product while receiving it (D223)', () => {
  it('creates the product and its unit in the same transaction', async () => {
    const h = harness();
    const result: any = await h.service.createPurchase(body([newLine()]));

    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(h.writes.products).toHaveLength(1);
    expect(h.writes.units).toHaveLength(1);
    expect(h.writes.units[0].productId.equals(h.writes.products[0].id)).toBe(true);
    expect(result.unitsCreated).toBe(1);
    expect(result.createdProducts).toEqual([
      expect.objectContaining({ brand: 'Fictiva', model: 'Test Phone 1', variant: '128GB Grey' }),
    ]);
  });

  it('leaves no product behind when the stock write fails', async () => {
    const h = harness({ failUnit: true });
    await expect(h.service.createPurchase(body([newLine()]))).rejects.toThrow('unit insert failed');
    expect(h.writes.products).toHaveLength(0);
    expect(h.writes.purchases).toHaveLength(0);
    expect(h.writes.payments).toHaveLength(0);
  });

  it('creates no product when every line is refused: never a product-only success', async () => {
    const h = harness({ registered: ['356888000000001'] });
    const result: any = await h.service.createPurchase(body([newLine()]));
    expect(result.purchaseId).toBeNull();
    expect(result.createdProducts).toEqual([]);
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.writes.products).toHaveLength(0);
  });

  it('creates only the new products whose lines are received', async () => {
    const h = harness({ registered: ['356888000000002'] });
    const other = { brand: 'Fictiva', model: 'Test Phone 2', trackingType: 'imei' };
    const result: any = await h.service.createPurchase(
      body([newLine(), newLine({ newProduct: other, identifiers: ['356888000000002'] })]),
    );
    expect(h.writes.products.map((p) => p.model)).toEqual(['Test Phone 1']);
    expect(result.createdProducts).toHaveLength(1);
    expect(result.rejected).toEqual([expect.objectContaining({ identifier: '356888000000002' })]);
  });

  it('refuses a product that already exists, before anything is written', async () => {
    const h = harness({ existingProduct: true });
    const attempt = h.service.createPurchase(body([newLine()]));
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(h.service.createPurchase(body([newLine()]))).rejects.toMatchObject({
      response: { code: 'product_exists', productId: EXISTING },
    });
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('needs catalog.manage to create, checked before anything is written', async () => {
    const h = harness({ mayManageCatalog: false });
    await expect(h.service.createPurchase(body([newLine()]))).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.catalog.prepareProduct).not.toHaveBeenCalled();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('does not ask for catalog.manage when every line names an existing product', async () => {
    const h = harness();
    await h.service.createPurchase(body([{ productId: EXISTING, unitCost: 900, identifiers: ['356888000000003'] }]));
    expect(h.catalog.assertMayManageCatalog).not.toHaveBeenCalled();
    expect(h.writes.products).toHaveLength(0);
  });

  it('refuses a line naming both an existing and a new product, or neither', async () => {
    const h = harness();
    await expect(
      h.service.createPurchase(body([newLine({ productId: EXISTING })])),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.service.createPurchase(body([{ unitCost: 900, identifiers: ['356888000000004'] }])),
    ).rejects.toMatchObject({ response: { code: 'product_or_new_product' } });
  });

  it('files several lines of one new product under ONE product', async () => {
    const h = harness();
    const result: any = await h.service.createPurchase(
      body([newLine(), newLine({ identifiers: ['356888000000005'], unitCost: 950 })]),
    );
    expect(h.writes.products).toHaveLength(1);
    expect(result.unitsCreated).toBe(2);
  });

  it('refuses two lines that describe the same new product differently', async () => {
    const h = harness();
    await expect(
      h.service.createPurchase(
        body([newLine(), newLine({ newProduct: { ...newPhone, trackingType: 'serial' }, identifiers: ['SN-FICT-0001'] })]),
      ),
    ).rejects.toMatchObject({ response: { code: 'new_product_conflict' } });
  });

  it('replays the same request with the product it created, and creates nothing twice', async () => {
    const h = harness();
    const first: any = await h.service.createPurchase(body([newLine()]));
    const again: any = await h.service.createPurchase(body([newLine()]));
    expect(again.replayed).toBe(true);
    expect(again.purchaseId).toBe(first.purchaseId);
    expect(again.createdProducts).toEqual(first.createdProducts);
    expect(h.writes.products).toHaveLength(1);
  });

  it('treats the same request id with a different new product as a conflict', async () => {
    const h = harness();
    await h.service.createPurchase(body([newLine()]));
    await expect(
      h.service.createPurchase(body([newLine({ newProduct: { ...newPhone, variant: '256GB Grey' } })])),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.writes.products).toHaveLength(1);
  });

  /**
   * A request without a new product must hash exactly as before D223, or a retry
   * left pending across the deploy would read as a conflict.
   */
  it('hashes a request without a new product exactly as before', async () => {
    const h = harness();
    await h.service.createPurchase(body([{ productId: EXISTING, unitCost: 900, identifiers: ['356888000000006'] }]));
    const before = createHash('sha256')
      .update(
        JSON.stringify({
          paymentMethod: 'cash',
          receivingAccountId: null,
          referenceNo: null,
          items: [{ productId: EXISTING, unitCost: 900, quantity: null, price: null, identifiers: ['356888000000006'] }],
        }),
      )
      .digest('hex');
    expect(h.writes.purchases[0].clientRequestHash).toBe(before);
  });
});

describe('the new-product contract', () => {
  const check = async (raw: Record<string, unknown>) =>
    validate(plainToInstance(CreatePurchaseDto, raw), { whitelist: true, forbidNonWhitelisted: true });

  it('accepts a line with a new product and no product id', async () => {
    expect(await check({ clientUuid: KEY, paymentMethod: 'cash', items: [newLine()] })).toEqual([]);
  });

  it('refuses a price or a cost on the new product: intake records buying cost on the line only', async () => {
    const errors = await check({
      clientUuid: KEY,
      paymentMethod: 'cash',
      items: [newLine({ newProduct: { ...newPhone, defaultPrice: 1200, defaultCost: 900 } })],
    });
    expect(JSON.stringify(errors)).toMatch(/defaultPrice/);
    expect(JSON.stringify(errors)).toMatch(/defaultCost/);
  });
});
