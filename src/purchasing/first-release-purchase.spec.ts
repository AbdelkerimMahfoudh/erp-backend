import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PurchasingService } from './purchasing.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { uuidToBin } from '../common/utils/uuid.util';

/**
 * First release: an ordinary purchase is anonymous and paid in full.
 *
 * No supplier is asked for, created or accepted; the amount paid is the
 * server's, never the client's; a non-cash purchase names an active account;
 * and the purchase, its payment and its stock are one transaction.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const BRANCH = uuidToBin('018f0000-0000-7000-8000-0000000000b1');
const PRODUCT = '018f0000-0000-7000-8000-00000000a001';
const ACCOUNT = '018f0000-0000-7000-8000-0000000acc01';
const KEY = '018f0000-0000-7000-8000-00000000e001';

const line = { productId: PRODUCT, unitCost: 1500, identifiers: ['356888000000001'] };

function harness(account: { isActive: boolean } | null = { isActive: true }, failUnit = false) {
  const writes = { purchases: [] as any[], payments: [] as any[], units: [] as any[], supplierWrites: 0 };
  const db: any = {
    purchase: { findFirst: jest.fn(async () => null) },
    receivingAccount: {
      findFirst: jest.fn(async () => (account ? { id: uuidToBin(ACCOUNT), label: 'Bankily', ...account } : null)),
    },
    product: { findMany: jest.fn(async () => [{ id: uuidToBin(PRODUCT), trackingType: 'imei', defaultPrice: 2000 }]) },
    supplier: new Proxy({}, { get: () => () => { writes.supplierWrites++; } }),
    $transaction: jest.fn(async (fn: any) => {
      // All-or-nothing: collect in a scratch set and publish only on success.
      const staged = { purchases: [] as any[], payments: [] as any[], units: [] as any[] };
      const tx = {
        purchase: { create: async ({ data }: any) => void staged.purchases.push(data) },
        purchaseItem: { create: async () => ({}) },
        supplierPayment: { create: async ({ data }: any) => void staged.payments.push(data) },
        supplier: db.supplier,
        recognitionOutbox: { createMany: async () => ({}) },
        rollupRequest: { createMany: async () => ({}) },
      };
      const result = await fn(tx);
      writes.purchases.push(...staged.purchases);
      writes.payments.push(...staged.payments);
      writes.units.push(...staged.units);
      return result;
    }),
  };
  const inventory: any = {
    findExistingIdentifiers: jest.fn(async () => new Set()),
    // No phone of the company was voided by a cancelled purchase (0079).
    findVoidedUnits: jest.fn(async () => new Map()),
    createUnit: jest.fn(async (_tx: unknown, data: any) => {
      if (failUnit) throw new Error('unit insert failed');
      writes.units.push(data);
      return {};
    }),
  };
  const strategies: any = {
    get: () => ({
      perUnit: true,
      identifierField: 'imeiPrimary',
      identifierLabel: 'IMEI',
      validateIdentifier: () => ({ ok: true }),
      normalize: (v: string) => v,
      recognitionKey: () => null,
    }),
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
    { assign: async () => '2026-09-22', today: async () => '2026-09-22' } as never,
    // The day is never closed here: a purchase reopens nothing (D10 is proven on the live copy).
    { autoReopenTx: async () => ({ reopened: false, closingId: null, reopenCount: 0, at: null }), afterReopenCommitted: async () => undefined } as never,
  );
  return { service, writes, db };
}

const SERVICE = readFileSync(join(__dirname, 'purchasing.service.ts'), 'utf8');

describe('the purchase contract', () => {
  const check = async (body: Record<string, unknown>) => {
    const dto = plainToInstance(CreatePurchaseDto, body);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  };

  it('needs no supplier', async () => {
    const errors = await check({ clientUuid: KEY, paymentMethod: 'cash', items: [line] });
    expect(errors).toHaveLength(0);
  });

  it('refuses a supplier — it is not part of the contract any more', async () => {
    const errors = await check({ clientUuid: KEY, paymentMethod: 'cash', supplierId: KEY, items: [line] });
    expect(errors.some((e) => e.property === 'supplierId')).toBe(true);
  });

  it('refuses an amount paid, so a partial or unpaid purchase cannot be sent', async () => {
    for (const paidAmount of [0, 500]) {
      const errors = await check({ clientUuid: KEY, paymentMethod: 'cash', paidAmount, items: [line] });
      expect(errors.some((e) => e.property === 'paidAmount')).toBe(true);
    }
  });

  it('refuses a due date — purchase credit is postponed', async () => {
    const errors = await check({ clientUuid: KEY, paymentMethod: 'cash', dueDate: '2026-10-01', items: [line] });
    expect(errors.some((e) => e.property === 'dueDate')).toBe(true);
  });

  it('requires a payment method', async () => {
    const errors = await check({ clientUuid: KEY, items: [line] });
    expect(errors.some((e) => e.property === 'paymentMethod')).toBe(true);
  });
});

describe('an ordinary purchase', () => {
  it('is paid in full by the server, with no supplier', async () => {
    const { service, writes } = harness();
    await service.createPurchase({ clientUuid: KEY, paymentMethod: 'cash', items: [line] } as never);
    expect(writes.purchases[0]).toMatchObject({ supplierId: null, total: 1500, amountPaid: 1500, status: 'paid', dueDate: null });
    expect(writes.payments[0]).toMatchObject({ supplierId: null, amount: 1500, method: 'cash', receivingAccountId: null });
    expect(writes.units[0]).toMatchObject({ supplierId: null, cost: 1500 });
  });

  it('never touches a supplier balance or creates a supplier', async () => {
    const { service, writes } = harness();
    await service.createPurchase({ clientUuid: KEY, paymentMethod: 'cash', items: [line] } as never);
    expect(writes.supplierWrites).toBe(0);
    const code = SERVICE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/supplier\.(create|update|upsert)/);
    expect(code).not.toMatch(/supplierSettlement/);
  });

  it('records the account a non-cash purchase was paid from', async () => {
    const { service, writes } = harness();
    await service.createPurchase({ clientUuid: KEY, paymentMethod: 'mobile', receivingAccountId: ACCOUNT, items: [line] } as never);
    expect(writes.payments[0]).toMatchObject({ method: 'mobile', amount: 1500, accountLabelSnapshot: 'Bankily' });
    expect(writes.payments[0].receivingAccountId).toEqual(uuidToBin(ACCOUNT));
  });

  it('refuses a non-cash purchase with no account, writing nothing', async () => {
    const { service, writes } = harness();
    await expect(
      service.createPurchase({ clientUuid: KEY, paymentMethod: 'bank', items: [line] } as never),
    ).rejects.toThrow(BadRequestException);
    expect(writes.purchases).toHaveLength(0);
  });

  it('refuses an inactive account, writing nothing', async () => {
    const { service, writes } = harness({ isActive: false });
    await expect(
      service.createPurchase({ clientUuid: KEY, paymentMethod: 'mobile', receivingAccountId: ACCOUNT, items: [line] } as never),
    ).rejects.toThrow(/no longer active/);
    expect(writes.purchases).toHaveLength(0);
  });

  it('refuses an unknown account', async () => {
    const { service } = harness(null);
    await expect(
      service.createPurchase({ clientUuid: KEY, paymentMethod: 'mobile', receivingAccountId: ACCOUNT, items: [line] } as never),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses an account on a cash purchase', async () => {
    const { service } = harness();
    await expect(
      service.createPurchase({ clientUuid: KEY, paymentMethod: 'cash', receivingAccountId: ACCOUNT, items: [line] } as never),
    ).rejects.toThrow(/drawer/);
  });

  it('is atomic: if the unit cannot be written, no purchase or payment survives', async () => {
    const { service, writes } = harness({ isActive: true }, true);
    await expect(
      service.createPurchase({ clientUuid: KEY, paymentMethod: 'cash', items: [line] } as never),
    ).rejects.toThrow(/unit insert failed/);
    expect(writes.purchases).toHaveLength(0);
    expect(writes.payments).toHaveLength(0);
  });

  it('hashes the payment into the request identity, so a changed account is a conflict not a replay', () => {
    expect(SERVICE).toContain('paymentMethod: dto.paymentMethod');
    expect(SERVICE).toContain('receivingAccountId: dto.receivingAccountId?.toLowerCase() ?? null');
  });
});
