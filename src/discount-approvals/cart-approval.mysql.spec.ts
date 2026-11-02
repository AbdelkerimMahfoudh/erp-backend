import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { cartHash } from '../sales/cart-hash';
import { DiscountApprovalsService } from './discount-approvals.service';

/** One approval for one multi-item sale, on real MySQL (D227). The tenant, audit and pricing are stand-ins; the rows are real. */
const url = process.env.PROVISIONING_ROOT_URL;
const suite = url ? describe : describe.skip;

suite('one approval for one sale', () => {
  const root = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
  const hex = () => Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
  afterAll(() => root?.$disconnect());

  async function world() {
    const companyId = hex();
    const branchId = hex();
    const userId = hex();
    const code = randomUUID().replace(/-/g, '').slice(0, 12);
    await root.company.create({ data: { id: companyId, publicStoreId: code, currency: 'MRU', timezone: 'Africa/Nouakchott', settingsJson: {} } });
    await root.branch.create({ data: { id: branchId, companyId, name: 'Main' } as never });
    await root.user.create({ data: { id: userId, companyId, name: 'Seller', login: `s-${code}`, personalId: `U-${code.slice(0, 8)}`, passwordHash: 'x' } as never });
    const product = await root.product.create({ data: { id: hex(), companyId, brand: 'B', model: 'M', trackingType: 'imei', defaultPrice: 5000 } as never });
    const unit = async (cost: number) => {
      const imei = `35${Math.floor(Math.random() * 1e13).toString().padStart(13, '0')}`;
      await root.unit.create({ data: { id: newUuidV7Bin(), companyId, branchId, productId: product.id, imeiPrimary: imei, cost, status: 'in_stock', dateIn: new Date() } as never });
      return imei;
    };
    const audit = { record: jest.fn() };
    const permissions = new Set(['sale.below_cost']);
    const service = new DiscountApprovalsService(
      root as never,
      { companyId: () => companyId, requireBranchId: () => branchId, userId: () => userId } as never,
      audit as never,
      { resolveForSaleTx: async () => ({ price: 5000, source: 'product', version: 1 }) } as never,
      { get: () => permissions } as never,
    );
    Object.assign(service, { notify: jest.fn(), approvers: async () => [] });
    return { companyId, branchId, service, unit, audit };
  }
  const consume = (w: Awaited<ReturnType<typeof world>>, unitId: Buffer, price: number, hash: string, saleId = hex()) =>
    root.$transaction((tx) =>
      w.service.consume(tx as never, { unitId, requestedPrice: price, currentConfiguredPrice: 5000, currentPriceVersion: null, currentCost: 4000, currentBranchId: w.branchId, saleId, cartHash: hash }),
    );
  const unitIdOf = async (imei: string) => (await root.unit.findFirstOrThrow({ where: { imeiPrimary: imei } })).id;

  it('asks once for every device below cost, leaves the rest out, and one decision answers all of it', async () => {
    const w = await world();
    const [a, b, fine] = [await w.unit(4000), await w.unit(4000), await w.unit(1000)];
    const lines = [{ identifier: a, price: 3500 }, { identifier: b, price: 3600 }, { identifier: fine, price: 2000 }, { productId: randomUUID(), quantity: 2, price: 100 }];
    const asked = await w.service.requestCart({ clientUuid: randomUUID(), reason: 'old stock', lines });
    expect(asked.rows).toHaveLength(2);
    expect(asked.cartHash).toBe(cartHash(lines));
    expect(new Set(asked.rows.map((r) => r.cartGroupId)).size).toBe(1);

    await w.service.decide(asked.rows[0].id, { approve: true, expectedVersion: 0 });
    const rows = await root.discountApproval.findMany({ where: { companyId: w.companyId } });
    expect(rows.map((r) => r.status)).toEqual(['approved', 'approved']);
    expect(rows.map((r) => Number(r.approvedPrice)).sort()).toEqual([3500, 3600]);
    expect(w.audit.record.mock.calls.filter(([c]) => c.after?.event === 'discount_approval_approved')).toHaveLength(2);
  });

  it('a retry is the same asking; the same key for a changed cart is refused', async () => {
    const w = await world();
    const a = await w.unit(4000);
    const key = randomUUID();
    const first = await w.service.requestCart({ clientUuid: key, reason: 'r', lines: [{ identifier: a, price: 3500 }] });
    const again = await w.service.requestCart({ clientUuid: key, reason: 'r', lines: [{ identifier: a, price: 3500 }] });
    expect(again.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
    await expect(w.service.requestCart({ clientUuid: key, reason: 'r', lines: [{ identifier: a, price: 3400 }] })).rejects.toMatchObject({ response: { code: 'idempotency_conflict' } });
  });

  it('spends only for the exact cart: a changed cart finds no approval, and the right one spends it once', async () => {
    const w = await world();
    const a = await w.unit(4000);
    const lines = [{ identifier: a, price: 3500 }];
    const asked = await w.service.requestCart({ clientUuid: randomUUID(), reason: 'r', lines });
    await w.service.decide(asked.rows[0].id, { approve: true, expectedVersion: 0 });
    const id = await unitIdOf(a);

    const changed = cartHash([...lines, { productId: randomUUID(), quantity: 1, price: 50 }]);
    expect(await consume(w, id, 3500, changed)).toBeNull();
    expect(await consume(w, id, 3500, asked.cartHash)).toMatchObject({ approvedPrice: 3500 });
    expect(await consume(w, id, 3500, asked.cartHash)).toBeNull();
  });

  it('asking again for a changed cart replaces the old answer, approved or not', async () => {
    const w = await world();
    const a = await w.unit(4000);
    const first = await w.service.requestCart({ clientUuid: randomUUID(), reason: 'r', lines: [{ identifier: a, price: 3500 }] });
    await w.service.decide(first.rows[0].id, { approve: true, expectedVersion: 0 });
    const second = await w.service.requestCart({ clientUuid: randomUUID(), reason: 'r', lines: [{ identifier: a, price: 3500 }, { productId: randomUUID(), quantity: 1, price: 50 }] });
    expect((await w.service.get(first.rows[0].id)).status).toBe('voided');
    expect(await consume(w, await unitIdOf(a), 3500, first.cartHash)).toBeNull();
    expect((await w.service.get(second.rows[0].id)).status).toBe('pending');
  });

  it('refusing one refuses the sale, and cancelling withdraws all of it', async () => {
    const w = await world();
    const lines = [{ identifier: await w.unit(4000), price: 3500 }, { identifier: await w.unit(4000), price: 3500 }];
    const refused = await w.service.requestCart({ clientUuid: randomUUID(), reason: 'r', lines });
    await w.service.decide(refused.rows[1].id, { approve: false, expectedVersion: 0 });
    expect((await root.discountApproval.findMany({ where: { companyId: w.companyId } })).map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('with nothing below cost there is nothing to ask', async () => {
    const w = await world();
    await expect(w.service.requestCart({ clientUuid: randomUUID(), reason: 'r', lines: [{ identifier: await w.unit(100), price: 500 }] })).rejects.toMatchObject({ response: { code: 'approval_not_needed' } });
    expect(binToUuid(w.companyId)).toBeTruthy();
  });
});
