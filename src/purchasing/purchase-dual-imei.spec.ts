import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PurchasingService } from './purchasing.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { TrackingStrategyRegistry } from '../tracking/tracking-strategy.registry';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';

/**
 * Receiving a dual-SIM phone: one unit, two IMEIs, and neither may already be
 * somebody's IMEI 1 or IMEI 2 — in stock or in the same delivery.
 *
 * Also pins what a partly refused delivery tells the client: which lines were
 * received, so correcting the rest and finishing again cannot send them twice.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const BRANCH = uuidToBin('018f0000-0000-7000-8000-0000000000b1');
const PHONE = '018f0000-0000-7000-8000-00000000a001';
const TV = '018f0000-0000-7000-8000-00000000a002';
const CABLE = '018f0000-0000-7000-8000-00000000a003';

/** A Luhn-valid IMEI from a 14-digit body. */
function imei(body14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body14[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body14 + ((10 - (sum % 10)) % 10);
}

const A1 = imei('35000000000001');
const A2 = imei('35000000000002');
const B1 = imei('35000000000003');
const B2 = imei('35000000000004');

type Voided = Record<string, { id: string; trackingType: string; asPrimary: boolean }>;

function makeService(registered: string[] = [], voided: Voided = {}) {
  const created: { imeiPrimary: string | null; imeiSecondary: string | null; serialNo: string | null }[] = [];
  const reactivated: { unitId: string; purchaseId: string; cost: number; imeiSecondary: string | null }[] = [];
  let stockReceipts = 0;
  const lookups: string[][] = [];

  const db: any = {
    purchase: { findFirst: jest.fn(async () => null) },
    receivingAccount: { findFirst: jest.fn(async () => null) },
    product: {
      findMany: jest.fn(async () => [
        { id: uuidToBin(PHONE), trackingType: 'imei', defaultPrice: 1000, companyId: COMPANY },
        { id: uuidToBin(TV), trackingType: 'serial', defaultPrice: 5000, companyId: COMPANY },
        { id: uuidToBin(CABLE), trackingType: 'quantity', defaultPrice: 20, companyId: COMPANY },
      ]),
    },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        purchase: { create: jest.fn(async ({ data }: any) => data) },
        purchaseItem: { create: jest.fn(async () => ({})) },
        supplierPayment: { create: jest.fn(async () => ({})) },
        stockItem: { upsert: jest.fn(async () => ({})) },
        $executeRaw: jest.fn(async () => {
          stockReceipts += 1;
          return 1;
        }),
        $queryRaw: jest.fn(async () => []),
        rollupRequest: { createMany: jest.fn(async () => ({})) },
      }),
    ),
  };

  const service = new PurchasingService(
    db as never,
    { companyId: () => COMPANY, requireBranchId: () => BRANCH, userId: () => null } as never,
    { record: jest.fn(), recordTx: jest.fn() } as never,
    {
      findExistingIdentifiers: jest.fn(async (ids: string[]) => {
        lookups.push(ids);
        return new Set(ids.filter((id) => registered.includes(id)));
      }),
      // Phones of the company whose purchase was cancelled (0079), by each identifier they carry.
      findVoidedUnits: jest.fn(async (ids: string[]) =>
        new Map(ids.filter((id) => voided[id]).map((id) => [id, { ...voided[id], id: uuidToBin(voided[id].id) }])),
      ),
      reactivateUnit: jest.fn(async (_tx: unknown, unitId: Buffer, data: any) => {
        reactivated.push({ unitId: binToUuid(unitId), purchaseId: binToUuid(data.purchaseId), cost: data.cost, imeiSecondary: data.imeiSecondary });
      }),
      createUnit: jest.fn(async (_tx: unknown, data: any) => {
        created.push({ imeiPrimary: data.imeiPrimary, imeiSecondary: data.imeiSecondary ?? null, serialNo: data.serialNo });
        return { id: uuidToBin(PHONE) };
      }),
    } as never,
    { emit: jest.fn() } as never,
    new TrackingStrategyRegistry(),
    { learn: jest.fn() } as never,
    { enqueueTx: jest.fn(async () => {}), processNow: jest.fn(async () => {}) } as never,
    { processNow: jest.fn(async () => undefined) } as never,
    { assign: async () => '2026-09-22', today: async () => '2026-09-22' } as never,
    // The day is never closed here: a purchase reopens nothing (D10 is proven on the live copy).
    { autoReopenTx: async () => ({ reopened: false, closingId: null, reopenCount: 0, at: null }), afterReopenCommitted: async () => undefined } as never,
  );

  return { service, created, reactivated, lookups, stockReceipts: () => stockReceipts };
}

const dto = (items: unknown[], clientUuid = '018f0000-0000-7000-8000-00000000e001') =>
  ({ clientUuid, paymentMethod: 'cash', items }) as never;

describe('receiving a phone with an optional IMEI 2', () => {
  it('stores IMEI 2 on the same unit as IMEI 1', async () => {
    const { service, created } = makeService();
    const res = await service.createPurchase(dto([{ productId: PHONE, unitCost: 800, units: [{ identifier: A1, imeiSecondary: A2 }] }]));
    expect(created).toEqual([{ imeiPrimary: A1, imeiSecondary: A2, serialNo: null }]);
    expect(res.unitsCreated).toBe(1);
    expect(res.accepted).toEqual({ identifiers: [A1], stockProductIds: [] });
  });

  it('one IMEI is enough, in either form', async () => {
    const { service, created } = makeService();
    await service.createPurchase(
      dto([{ productId: PHONE, unitCost: 800, identifiers: [A1], units: [{ identifier: B1 }] }]),
    );
    expect(created).toEqual([
      { imeiPrimary: A1, imeiSecondary: null, serialNo: null },
      { imeiPrimary: B1, imeiSecondary: null, serialNo: null },
    ]);
  });

  it('looks up BOTH IMEIs against stock', async () => {
    const { service, lookups } = makeService();
    await service.createPurchase(dto([{ productId: PHONE, unitCost: 800, units: [{ identifier: A1, imeiSecondary: A2 }] }]));
    expect(lookups[0].sort()).toEqual([A1, A2].sort());
  });

  it('refuses a phone whose IMEI 2 is already registered, keeping the pair together', async () => {
    const { service, created } = makeService([A2]);
    const res = await service.createPurchase(dto([{ productId: PHONE, unitCost: 800, units: [{ identifier: A1, imeiSecondary: A2 }] }]));
    expect(created).toEqual([]);
    expect(res.purchaseId).toBeNull();
    expect(res.rejected).toEqual([{ identifier: A1, reason: 'already registered', secondary: A2 }]);
  });

  it('refuses a second phone reusing another phone\'s IMEI 2 as its IMEI 1, in the same delivery', async () => {
    const { service, created } = makeService();
    const res = await service.createPurchase(
      dto([{ productId: PHONE, unitCost: 800, units: [{ identifier: A1, imeiSecondary: A2 }, { identifier: A2, imeiSecondary: B2 }] }]),
    );
    expect(created.map((c) => c.imeiPrimary)).toEqual([A1]);
    expect(res.rejected).toEqual([{ identifier: A2, reason: 'duplicate in batch', secondary: B2 }]);
  });

  it('refuses an IMEI 2 equal to IMEI 1, a bad IMEI 2, and an IMEI 2 on a serial product', async () => {
    const { service, created } = makeService();
    const res = await service.createPurchase(
      dto([
        { productId: PHONE, unitCost: 800, units: [{ identifier: A1, imeiSecondary: A1 }, { identifier: B1, imeiSecondary: '123456789012345' }] },
        { productId: TV, unitCost: 4000, units: [{ identifier: 'SN-TV-1', imeiSecondary: B2 }] },
      ]),
    );
    expect(created).toEqual([]);
    expect((res.rejected as { reason: string }[]).map((r) => r.reason)).toEqual([
      'secondary IMEI equals primary',
      'invalid secondary IMEI',
      'secondary IMEI on a product without IMEIs',
    ]);
  });

  it('names what a partly refused delivery received — units and stock lines', async () => {
    const { service } = makeService([B1]);
    const res = await service.createPurchase(
      dto([
        { productId: PHONE, unitCost: 800, units: [{ identifier: A1, imeiSecondary: A2 }, { identifier: B1 }] },
        { productId: CABLE, unitCost: 5, quantity: 10 },
      ]),
    );
    expect(res.purchaseId).not.toBeNull();
    expect(res.accepted).toEqual({ identifiers: [A1], stockProductIds: [CABLE] });
    expect(res.rejected).toEqual([{ identifier: B1, reason: 'already registered' }]);
  });
});

describe('the purchase contract', () => {
  const check = async (items: unknown[]) =>
    validate(plainToInstance(CreatePurchaseDto, dto(items) as object));

  it('accepts units with and without IMEI 2', async () => {
    expect(await check([{ productId: PHONE, unitCost: 1, units: [{ identifier: A1, imeiSecondary: A2 }, { identifier: B1 }] }])).toHaveLength(0);
  });

  it('refuses an IMEI 2 that is not 15 digits', async () => {
    const errors = await check([{ productId: PHONE, unitCost: 1, units: [{ identifier: A1, imeiSecondary: '12345' }] }]);
    expect(JSON.stringify(errors)).toMatch(/imeiSecondary must be 15 digits/);
  });
});

/**
 * A phone whose purchase was cancelled (0079) never entered the books. Receiving it
 * again under its own IMEI brings that same record back — IMEI uniqueness stays
 * exactly as it was: one IMEI, one record, for ever.
 */
describe('receiving again a phone whose purchase was cancelled', () => {
  const VOIDED = '018f0000-0000-7000-8000-00000000d001';

  it('brings the same record back at the new purchase\'s cost, and creates none', async () => {
    const { service, created, reactivated } = makeService([], { [A1]: { id: VOIDED, trackingType: 'imei', asPrimary: true } });
    const res = await service.createPurchase(dto([{ productId: PHONE, unitCost: 750, identifiers: [A1] }]));
    expect(created).toEqual([]);
    expect(reactivated).toEqual([{ unitId: VOIDED, purchaseId: res.purchaseId, cost: 750, imeiSecondary: null }]);
    expect(res.unitsCreated).toBe(1);
    expect(res.accepted.identifiers).toEqual([A1]);
  });

  it('keeps an IMEI 2 that is its own, and takes a new one the delivery states', async () => {
    const { service, reactivated } = makeService([], {
      [A1]: { id: VOIDED, trackingType: 'imei', asPrimary: true },
      [A2]: { id: VOIDED, trackingType: 'imei', asPrimary: false },
    });
    await service.createPurchase(dto([{ productId: PHONE, unitCost: 750, units: [{ identifier: A1, imeiSecondary: A2 }] }]));
    expect(reactivated[0]).toMatchObject({ unitId: VOIDED, imeiSecondary: A2 });
  });

  it('refuses a number that is only a voided phone\'s IMEI 2 — it is still that phone\'s', async () => {
    const { service, created, reactivated } = makeService([], { [A2]: { id: VOIDED, trackingType: 'imei', asPrimary: false } });
    const res = await service.createPurchase(dto([{ productId: PHONE, unitCost: 750, identifiers: [A2] }]));
    expect(created).toEqual([]);
    expect(reactivated).toEqual([]);
    expect(res.rejected).toEqual([{ identifier: A2, reason: 'already registered' }]);
  });

  it('refuses an IMEI 2 that belongs to ANOTHER voided phone', async () => {
    const OTHER = '018f0000-0000-7000-8000-00000000d002';
    const { service, reactivated } = makeService([], {
      [A1]: { id: VOIDED, trackingType: 'imei', asPrimary: true },
      [B2]: { id: OTHER, trackingType: 'imei', asPrimary: false },
    });
    const res = await service.createPurchase(dto([{ productId: PHONE, unitCost: 750, units: [{ identifier: A1, imeiSecondary: B2 }] }]));
    expect(reactivated).toEqual([]);
    expect(res.rejected).toEqual([{ identifier: A1, reason: 'already registered', secondary: B2 }]);
  });

  it('never brings a record back as another kind of item', async () => {
    const { service, reactivated } = makeService([], { [A1]: { id: VOIDED, trackingType: 'serial', asPrimary: true } });
    const res = await service.createPurchase(dto([{ productId: PHONE, unitCost: 750, identifiers: [A1] }]));
    expect(reactivated).toEqual([]);
    expect(res.rejected[0]).toMatchObject({ identifier: A1, reason: 'already registered' });
  });

  it('asks for live phones without the voided ones, so a voided one is never both taken and free', async () => {
    const { service } = makeService();
    const inventory = (service as any).inventory;
    await service.createPurchase(dto([{ productId: PHONE, unitCost: 750, identifiers: [A1] }]));
    expect(inventory.findExistingIdentifiers).toHaveBeenCalledWith([A1], { includeVoided: false });
  });
});
