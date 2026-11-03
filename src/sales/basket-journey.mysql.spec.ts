import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * The whole basket through the real API, real guards and real MySQL (D227): a phone and accessories, changed quantities, one
 * approval, split payment, one sale, a retry, and an accessory line returned part by part. Nothing is mocked. What this does
 * not exercise is the phone's own screens; those are the render and visual gates.
 *
 * Env-gated, as `sale-http.mysql.spec`: SALE_ROOT_URL and SALE_APP_URL to a DISPOSABLE database.
 */
const ROOT_URL = process.env.SALE_ROOT_URL ?? '';
const APP_URL = process.env.SALE_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(240_000);

run('a basket from counter to returns', () => {
  let app: INestApplication;
  let root: PrismaClient;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', APP_DATABASE_URL: APP_URL, JWT_ACCESS_SECRET: 'basket-journey-secret-basket-journey-secret', THROTTLE_LIMIT: '100000', AUTH_THROTTLE_LIMIT: '100000' });
    const { AppModule } = await import('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
  });
  afterAll(async () => {
    await root?.$disconnect();
    await app?.close();
  });

  async function shop() {
    const { RegistrationService } = await import('../platform/registration.service');
    const { SessionsService } = await import('../auth/sessions.service');
    const { TokensService } = await import('../auth/tokens.service');
    const t = randomUUID().replace(/-/g, '').slice(0, 10);
    const reg = await app.get(RegistrationService).register({
      idempotencyKey: `basket-${t}`,
      ownerName: 'Owner',
      businessName: `Shop ${t}`,
      branchName: `Centre ${t}`,
      phone: `+2224${String(parseInt(t.slice(0, 7), 16)).padStart(7, '0').slice(-7)}`,
      password: 'correct horse battery',
      language: 'en',
    });
    const companyId = uuidToBin(reg.companyId);
    const branchId = uuidToBin(reg.branchId);
    await root.subscription.updateMany({ where: { companyId }, data: { status: 'activated', currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });

    const client = async (userId: string) => {
      const secret = app.get(TokensService).generateRefreshSecret();
      const sessionId = await app.get(SessionsService).create({ companyId, userId: uuidToBin(userId), secret });
      const token = app.get(TokensService).signAccessToken(userId, reg.companyId, binToUuid(sessionId)).token;
      const send = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(`${base}/api/v1/${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-branch-id': reg.branchId, 'user-agent': 'basket-journey' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await r.text();
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
        return { status: r.status, body: json };
      };
      return { post: (p: string, b: unknown) => send('POST', p, b), patch: (p: string, b: unknown) => send('PATCH', p, b), get: (p: string) => send('GET', p) };
    };
    const owner = await client(reg.ownerUserId);

    const staffId = newUuidV7Bin();
    const role = await root.role.findFirstOrThrow({ where: { companyId, key: 'store_employee' } });
    await root.user.create({ data: { id: staffId, companyId, name: 'Staff', login: `s-${t}`, personalId: `U-${t.slice(0, 8)}`, passwordHash: 'x', isActive: true } as never });
    await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId, userId: staffId, branchId, roleId: role.id } });
    const staff = await client(binToUuid(staffId));

    const product = async (model: string, trackingType: 'serial' | 'quantity', defaultPrice: number) => {
      const id = newUuidV7Bin();
      await root.product.create({ data: { id, companyId, brand: 'Test', model: `${model}${t}`, trackingType, defaultPrice } as never });
      return id;
    };
    const stock = async (productId: Buffer, quantity: number, cost: number) =>
      root.stockItem.create({ data: { id: newUuidV7Bin(), companyId, productId, branchId, quantity, cost, price: null } });

    const phone = await product('Phone', 'serial', 1000);
    const serial = `SN${t}`;
    await root.unit.create({ data: { id: newUuidV7Bin(), companyId, productId: phone, branchId, serialNo: serial, cost: 600, status: 'in_stock' } as never });
    const covers = await product('Cover', 'quantity', 50);
    await stock(covers, 10, 20);
    const cables = await product('Cable', 'quantity', 15);
    await stock(cables, 5, 5);

    const accountId = newUuidV7Bin();
    await root.receivingAccount.create({ data: { id: accountId, companyId, provider: 'bankily', label: `Bankily ${t}` } });
    const opened = await owner.post('closings/open', { openingMoney: { decision: 'set', cashAmount: 0 } });
    if (opened.status >= 300) throw new Error(JSON.stringify(opened.body));
    return { companyId, branchId, owner, staff, serial, covers, cables, accountId: binToUuid(accountId) };
  }

  const shelf = async (s: { companyId: Buffer }, productId: Buffer) => {
    const row = await root.stockItem.findFirstOrThrow({ where: { companyId: s.companyId, productId } });
    return { quantity: row.quantity, cost: Number(row.cost) };
  };

  /** Phone 1000, 5 covers at 15.01 (below their cost of 20), 2 cables. */
  const cartOf = (s: Awaited<ReturnType<typeof shop>>, coverQuantity = 5) => ({
    lines: [
      { identifier: s.serial, price: 1000 },
      { productId: binToUuid(s.covers), quantity: coverQuantity, price: 15.01 },
      { productId: binToUuid(s.cables), quantity: 2, price: 15 },
    ],
  });
  const totalOf = (coverQuantity = 5) => Math.round((1000 + coverQuantity * 15.01 + 30) * 100) / 100;

  async function soldBasket() {
    const s = await shop();
    const coverLineTotal = 75.05;
    const total = totalOf();
    const payments = [{ method: 'cash', amount: 500 }, { method: 'bank', amount: Math.round((total - 500) * 100) / 100, receivingAccountId: s.accountId }];

    // Edited before asking: the server's figures follow the quantity.
    const first = await s.staff.post('sales/check', cartOf(s, 3));
    expect(first.body.lines[1]).toMatchObject({ ok: true, charged: 15.01, setPrice: 50, quantity: 3 });
    const checked = await s.staff.post('sales/check', cartOf(s));
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ ok: true, total });
    expect(checked.body.lines[1].lineTotal).toBe(coverLineTotal);

    // Below cost, and an Employee: refused, nothing written, naming this cart.
    const refused = await s.staff.post('sales', { clientUuid: randomUUID(), ...cartOf(s), payments, overrideReason: 'old stock' });
    expect({ status: refused.status, body: refused.body }).toMatchObject({ status: 403 });
    expect(refused.body).toMatchObject({ code: 'approval_required', cartHash: checked.body.cartHash });
    expect(await root.sale.count({ where: { companyId: s.companyId } })).toBe(0);

    const asked = await s.staff.post('discount-approvals/cart', { clientUuid: randomUUID(), reason: 'old stock', ...cartOf(s) });
    expect(asked.status).toBe(201);
    expect(asked.body.rows).toHaveLength(1);
    expect(asked.body.rows[0]).toMatchObject({ unitId: '', quantity: 5, requestedPrice: 15.01 });

    // An Employee cannot answer it.
    expect((await s.staff.post(`discount-approvals/${asked.body.rows[0].id}/decide`, { approve: true, expectedVersion: 0 })).status).toBe(403);
    expect((await s.owner.post(`discount-approvals/${asked.body.rows[0].id}/decide`, { approve: true, expectedVersion: 0 })).status).toBeLessThan(300);

    // Approved, then the quantity changes: that cart was not approved.
    const changed = await s.staff.post('sales', { clientUuid: randomUUID(), ...cartOf(s, 4), payments: [{ method: 'cash', amount: totalOf(4) }], overrideReason: 'old stock' });
    expect(changed.status).toBe(403);
    expect(changed.body.code).toBe('approval_required');
    // So does another price on the approved line.
    const repriced = cartOf(s);
    repriced.lines[1].price = 15;
    expect((await s.staff.post('sales', { clientUuid: randomUUID(), ...repriced, payments: [{ method: 'cash', amount: 1097.99 + 0.01 * 0 }], overrideReason: 'old stock' })).status).toBeGreaterThanOrEqual(400);

    // A sale-wide discount may not push an approved line further below cost for someone who may not accept the loss.
    expect((await s.staff.post('sales', { clientUuid: randomUUID(), ...cartOf(s), saleDiscount: 7, payments: [{ method: 'cash', amount: total - 7 }], overrideReason: 'old stock' })).status).toBe(403);

    const key = randomUUID();
    const sold = await s.staff.post('sales', { clientUuid: key, ...cartOf(s), payments, overrideReason: 'old stock' });
    if (sold.status !== 201) throw new Error(JSON.stringify(sold.body));
    // The retry is the same sale.
    const again = await s.staff.post('sales', { clientUuid: key, ...cartOf(s), payments, overrideReason: 'old stock' });
    expect(again.status).toBeLessThan(300);
    expect(again.body.id).toBe(sold.body.id);

    expect(await root.sale.count({ where: { companyId: s.companyId } })).toBe(1);
    const sale = await root.sale.findFirstOrThrow({ where: { companyId: s.companyId }, include: { items: true, payments: true } });
    expect(sale.items).toHaveLength(3);
    expect(Number(sale.total)).toBe(total);
    expect(sale.payments.map((p) => Number(p.amount)).sort((a, b) => a - b)).toEqual([500, Math.round((total - 500) * 100) / 100]);
    // The approval is spent: the same cart again has nothing to spend.
    expect(await root.discountApproval.count({ where: { companyId: s.companyId, status: 'consumed' } })).toBe(1);
    expect((await shelf(s, s.covers)).quantity).toBe(5);
    expect((await shelf(s, s.cables)).quantity).toBe(3);

    const coverLine = sale.items.find((i) => i.productId?.equals(s.covers) && !i.unitId)!;
    return { s, sale, coverLine };
  }

  const raise = (s: Awaited<ReturnType<typeof shop>>, saleItemId: Buffer, quantity: number, clientUuid = randomUUID()) =>
    s.owner.post('returns', { saleItemId: binToUuid(saleItemId), quantity, requestReason: 'changed mind', custody: 'store_holds', clientUuid });
  /** The real order: responsibility decided, then approved on the version that left. */
  const approve = async (s: Awaited<ReturnType<typeof shop>>, r: { id: string }, disposition?: string) => {
    let current = (await s.owner.get(`returns/${r.id}`)).body;
    if (current.investigation?.responsibility !== 'store_or_product_fault' && current.responsibility !== 'store_or_product_fault') {
      const investigated = await s.owner.patch(`returns/${r.id}/investigation`, { responsibility: 'store_or_product_fault', expectedVersion: current.version });
      if (investigated.status >= 300) throw new Error(JSON.stringify(investigated.body));
      current = (await s.owner.get(`returns/${r.id}`)).body;
    }
    return s.owner.post(`returns/${r.id}/approve`, { expectedVersion: current.version, exceptionReason: 'outside the window, allowed by the owner', ...(disposition ? { disposition } : {}) });
  };

  it('sells once, returns part by part to exactly the line, with stock and reports following', async () => {
    const { s, sale, coverLine } = await soldBasket();
    const lineShare = async () => {
      const { lineShareCents } = await import('./sale-shares');
      const cents = lineShareCents(sale.items.map((i) => ({ id: i.id, price: i.price, quantity: i.quantity, discount: i.discount })) as never, sale.total as never);
      return Number(cents.get(coverLine.id.toString('hex'))!) / 100;
    };
    const whole = await lineShare();
    const cost = Number(coverLine.cost);

    // Two back today, on the shelf again at their own cost.
    const firstReturn = await raise(s, coverLine.id, 2);
    expect({ status: firstReturn.status, body: firstReturn.body }).toMatchObject({ status: 201 });
    expect((await approve(s, firstReturn.body)).body.code).toBe('disposition_required');
    expect((await shelf(s, s.covers)).quantity).toBe(5);
    const first = await approve(s, firstReturn.body, 'sellable');
    expect({ status: first.status, body: first.body }).toMatchObject({ status: expect.any(Number) });
    expect(first.status).toBeLessThan(300);
    expect(await shelf(s, s.covers)).toEqual({ quantity: 7, cost: 20 });

    // One later, damaged: nothing joins the shelf, nothing resells, no cost comes back.
    const second = await raise(s, coverLine.id, 1);
    expect((await approve(s, second.body, 'damaged')).status).toBeLessThan(300);
    expect((await shelf(s, s.covers)).quantity).toBe(7);

    // More than is left is refused, and says what is.
    const tooMany = await raise(s, coverLine.id, 3);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body).toMatchObject({ code: 'return_quantity_exceeded', remaining: 2 });

    // The same request twice at once is one return.
    const key = randomUUID();
    const twins = await Promise.all([raise(s, coverLine.id, 1, key), raise(s, coverLine.id, 1, key)]);
    expect(twins.map((t) => t.status).every((c) => c < 300)).toBe(true);
    expect(twins[0].body.id).toBe(twins[1].body.id);
    expect((await approve(s, twins[0].body, 'sellable')).status).toBeLessThan(300);

    // One piece left, two people at once: exactly one gets it.
    const race = await Promise.all([raise(s, coverLine.id, 1), raise(s, coverLine.id, 1)]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    const last = race.find((r) => r.status === 201)!;
    expect((await approve(s, last.body, 'sellable')).status).toBeLessThan(300);
    expect(await shelf(s, s.covers)).toEqual({ quantity: 9, cost: 20 });

    // Everything back: exactly the line's own money, never a cent past it.
    const reversals = await root.returnReversal.findMany({ where: { saleItemId: coverLine.id } });
    expect(reversals).toHaveLength(4);
    const refunded = Math.round(reversals.reduce((n, v) => n + Number(v.grossRefund), 0) * 100) / 100;
    expect(refunded).toBe(whole);
    expect(reversals.map((v) => v.returnedQuantity).reduce((a, b) => a! + b!, 0)).toBe(5);
    const costBack = reversals.reduce((n, v) => n + Number(v.lineCost), 0);
    expect(costBack).toBe(cost * 4); // the damaged piece credits nothing
    expect(costBack).toBeLessThanOrEqual(cost * coverLine.quantity);

    // The closing report for the day counts it all.
    const report = await s.owner.get('closings/report');
    expect(report.status).toBe(200);
    expect(report.body.sales).toMatchObject({ value: 1105.05, itemsSold: 8, netSalesValue: 1030, owed: 0, returns: { count: 4, netRefundDue: whole }, collected: { atCheckout: 1105.05 } });
    // Paid 1 105.05, half and half by channel; cost 600 + 100 + 10; four covers' cost came back, the damaged one's did not.
    expect(report.body.result).toMatchObject({ status: expect.not.stringMatching('cannot_calculate'), missingCostLines: 0, netSales: 1030, costOfUnitsSold: 630, returnsCostCredited: 80, grossProfit: 400 });
    const channels = report.body.money.channels as { channel: string; in: { todaysSales: number } }[];
    expect(channels.find((c) => c.channel === 'cash')!.in.todaysSales).toBe(500);
    expect(channels.find((c) => c.channel === 'account')!.in.todaysSales).toBe(605.05);
    expect(await root.sale.count({ where: { companyId: s.companyId } })).toBe(1);
    // A return writes to no sale, line or payment.
    expect(Number((await root.sale.findFirstOrThrow({ where: { id: sale.id } })).total)).toBe(Number(sale.total));
  });

  it('with a sale-wide discount and awkward cents, repeated returns add up to exactly what the line brought in', async () => {
    const s = await shop();
    const lines = [{ identifier: s.serial, price: 1000 }, { productId: binToUuid(s.covers), quantity: 3, price: 33.33 }];
    const total = Math.round((1000 + 99.99 - 7) * 100) / 100;
    const sold = await s.owner.post('sales', { clientUuid: randomUUID(), lines, saleDiscount: 7, payments: [{ method: 'cash', amount: total }] });
    if (sold.status !== 201) throw new Error(JSON.stringify(sold.body));
    const sale = await root.sale.findFirstOrThrow({ where: { companyId: s.companyId }, include: { items: true } });
    const line = sale.items.find((i) => !i.unitId)!;
    const { lineShareCents } = await import('./sale-shares');
    const whole = Number(lineShareCents(sale.items.map((i) => ({ id: i.id, price: i.price, quantity: i.quantity, discount: i.discount })) as never, sale.total as never).get(line.id.toString('hex'))!) / 100;
    expect(whole).toBeLessThan(99.99);
    const refunds: number[] = [];
    for (const [i, disposition] of ['sellable', 'damaged', 'sellable'].entries()) {
      const r = await raise(s, line.id, 1);
      expect(r.status).toBe(201);
      const a = await approve(s, r.body, disposition);
      if (a.status >= 300) throw new Error(`${i} ${JSON.stringify(a.body)}`);
      const v = await root.returnReversal.findFirstOrThrow({ where: { returnRequestId: uuidToBin(r.body.id) } });
      refunds.push(Number(v.grossRefund));
    }
    expect(Math.round(refunds.reduce((a, b) => a + b, 0) * 100) / 100).toBe(whole);
    expect(Math.max(...refunds) - Math.min(...refunds)).toBeLessThanOrEqual(0.011);
    expect((await raise(s, line.id, 1)).body).toMatchObject({ code: 'return_quantity_exceeded', remaining: 0 });
    expect((await shelf(s, s.covers)).quantity).toBe(9);
    const rollup = await root.returnReversal.aggregate({ where: { saleItemId: line.id }, _sum: { lineCost: true } });
    expect(Number(rollup._sum.lineCost)).toBe(40);
  });

  it('maintenance income: once per request, its own lines in the closing, never a sale or stock, reversed by an entry', async () => {
    const s = await shop();
    const key = randomUUID();
    const body = { clientUuid: key, description: 'Screen replaced', repairCost: 300, customerPaid: 800, paidMethod: 'account', paidAccountId: s.accountId, costMethod: 'cash' };
    const first = await s.owner.post('maintenance', body);
    if (first.status !== 201) throw new Error(JSON.stringify(first.body));
    expect(first.body).toMatchObject({ customerPaid: 800, repairAmount: 300, profit: 500, paidMethod: 'account', costMethod: 'cash' });
    const again = await s.owner.post('maintenance', body);
    expect(again.body.id).toBe(first.body.id);
    expect((await s.owner.post('maintenance', { ...body, customerPaid: 900 })).body.code).toBe('idempotency_conflict');
    // Rules: each money leg needs its channel; both zero needs saying.
    expect((await s.owner.post('maintenance', { clientUuid: randomUUID(), description: 'x', repairCost: 0, customerPaid: 10 })).body.code).toBe('paid_destination_required');
    expect((await s.owner.post('maintenance', { clientUuid: randomUUID(), description: 'x', repairCost: 10, customerPaid: 0 })).body.code).toBe('cost_source_required');
    expect((await s.owner.post('maintenance', { clientUuid: randomUUID(), description: 'x', repairCost: 0, customerPaid: 0 })).body.code).toBe('zero_needs_confirmation');
    // An Employee has it only by grant.
    expect((await s.staff.post('maintenance', { ...body, clientUuid: randomUUID() })).status).toBe(403);

    expect(await root.sale.count({ where: { companyId: s.companyId } })).toBe(0);
    let report = (await s.owner.get('closings/report')).body;
    expect(report.sales.value).toBe(0);
    expect(report.result.maintenanceNet).toBe(500);
    const row = (channel: string) => report.money.channels.find((c: { channel: string }) => c.channel === channel);
    expect(row('account').in.maintenance).toBe(800);
    expect(row('cash').out.maintenance).toBe(300);
    expect(report.expected.cash.expected).toBe(-300);

    const list = await s.owner.get('maintenance');
    expect(list.body.totals).toEqual({ revenue: 800, cost: 300, profit: 500 });

    const reversal = await s.owner.post(`maintenance/${first.body.id}/reverse`, { clientUuid: randomUUID(), reason: 'wrong shop' });
    if (reversal.status >= 300) throw new Error(JSON.stringify(reversal.body));
    const twice = await s.owner.post(`maintenance/${first.body.id}/reverse`, { clientUuid: randomUUID(), reason: 'again' });
    expect(twice.body.id).toBe(reversal.body.id);
    report = (await s.owner.get('closings/report')).body;
    expect(report.result.maintenanceNet).toBe(0);
    expect((await s.owner.get('maintenance')).body.totals).toEqual({ revenue: 0, cost: 0, profit: 0 });
  });

  it('a day with cash repairs and part-returned accessories really closes, and refuses anything after', async () => {
    const { s, coverLine } = await soldBasket();
    const r = await raise(s, coverLine.id, 2);
    if ((await approve(s, r.body, 'sellable')).status >= 300) throw new Error('approve');
    await s.owner.post('maintenance', { clientUuid: randomUUID(), description: 'Battery', repairCost: 100, customerPaid: 350, paidMethod: 'cash', costMethod: 'cash' });
    const report = (await s.owner.get('closings/report')).body;
    expect(report.result.maintenanceNet).toBe(250);
    const closed = await s.owner.post('closings', { countedCash: report.expected.cash.expected, acknowledgeUnverified: true, reason: 'accounts checked tomorrow' });
    if (closed.status >= 300) throw new Error(JSON.stringify(closed.body));
    const later = await s.owner.post('maintenance', { clientUuid: randomUUID(), description: 'Late', repairCost: 0, customerPaid: 10, paidMethod: 'cash' });
    expect(later.status).toBeGreaterThanOrEqual(400);
    expect(await root.maintenanceRecord.count({ where: { companyId: s.companyId } })).toBe(1);
    const frozen = await root.closingChannelCount.findFirstOrThrow({ where: { companyId: s.companyId, channel: 'cash' } });
    expect(Number(frozen.maintenanceIn)).toBe(350);
    expect(Number(frozen.maintenanceOut)).toBe(100);
  });

  describe('dedicated money balances (D227)', () => {
    const track = (s: Awaited<ReturnType<typeof shop>>, location: string, openingAmount: number, effectiveDate: string) => s.owner.post('money/tracking', { location, on: true, openingAmount, effectiveDate });
    const sell = (s: Awaited<ReturnType<typeof shop>>, payments: unknown[]) => s.owner.post('sales', { clientUuid: randomUUID(), lines: [{ identifier: s.serial, price: 1000 }], payments });
    const today = (s: Awaited<ReturnType<typeof shop>>) => s.owner.get('closings/business-day').then((r) => r.body.businessDate as string);

    it('every location off by default: money is reported, no balance is claimed, no count is asked', async () => {
      const s = await shop();
      expect((await sell(s, [{ method: 'cash', amount: 1000 }])).status).toBe(201);
      const balances = (await s.owner.get('money/tracking')).body;
      expect(balances.locations.every((l: { on: boolean }) => !l.on)).toBe(true);
      expect(JSON.stringify(balances)).not.toContain('expected');
      const report = (await s.owner.get('closings/report')).body;
      expect(report.money.channels.find((c: { channel: string }) => c.channel === 'cash')).toMatchObject({ countable: false, in: { todaysSales: 1000 } });
      expect(report.close.unverified).toEqual([]);
      expect((await s.owner.post('closings', {})).status).toBeLessThan(300);
    });

    it('dedicated cash with a personal Bankily: only the cash is claimed, and needs its count', async () => {
      const s = await shop();
      expect((await s.owner.post('money/tracking', { location: 'cash', on: true })).body.code).toBe('opening_required');
      await track(s, 'cash', 200, await today(s));
      expect((await sell(s, [{ method: 'cash', amount: 400 }, { method: 'bank', amount: 600, receivingAccountId: s.accountId }])).status).toBe(201);
      const { locations } = (await s.owner.get('money/tracking')).body;
      expect(locations.find((l: { location: string }) => l.location === 'cash')).toMatchObject({ on: true, moneyIn: 400, expected: 600 });
      expect(locations.find((l: { location: string }) => l.location === s.accountId)).toEqual(expect.objectContaining({ on: false }));
      expect((await s.owner.get('closings/report')).body.close.unverified).toEqual(['cash:NONE']);
    });

    it('dedicated Bankily with personal cash: the reverse', async () => {
      const s = await shop();
      await track(s, s.accountId, 50, await today(s));
      await sell(s, [{ method: 'cash', amount: 400 }, { method: 'bank', amount: 600, receivingAccountId: s.accountId }]);
      const { locations } = (await s.owner.get('money/tracking')).body;
      expect(locations.find((l: { location: string }) => l.location === s.accountId)).toMatchObject({ on: true, expected: 650 });
      expect(locations.find((l: { location: string }) => l.location === 'cash').on).toBe(false);
    });

    it('off keeps the history and hides the claim; on again needs a new opening, never the stale one', async () => {
      const s = await shop();
      await track(s, 'cash', 200, await today(s));
      await s.owner.post('money/tracking', { location: 'cash', on: false });
      expect((await s.owner.get('money/tracking')).body.locations[0]).toEqual(expect.objectContaining({ on: false }));
      expect((await s.owner.post('money/tracking', { location: 'cash', on: true })).body.code).toBe('opening_required');
      await track(s, 'cash', 75, await today(s));
      expect((await s.owner.get('money/tracking')).body.locations[0]).toMatchObject({ on: true, expected: 75 });
      expect(await root.moneyLocationTracking.count({ where: { companyId: s.companyId } })).toBe(1);
    });

    it('tracked cash has one figure: the balances screen and the closing agree, across days and after off and on again', async () => {
      const s = await shop();
      const day = await today(s);
      const yesterday = new Date(Date.parse(`${day}T00:00:00.000Z`) - 86400000).toISOString().slice(0, 10);
      const agree = async (figure: number) => {
        const screen = (await s.owner.get('money/tracking')).body.locations[0].expected;
        const closing = (await s.owner.get('closings/report')).body.expected.cash.expected;
        expect({ screen, closing }).toEqual({ screen: figure, closing: figure });
      };
      await track(s, 'cash', 200, yesterday);
      await agree(200);
      // Recorded on the earlier day: it carries into today's opening on both.
      expect((await s.owner.post('maintenance', { clientUuid: randomUUID(), description: 'Yesterday', repairCost: 0, customerPaid: 30, paidMethod: 'cash', businessDate: yesterday })).status).toBe(201);
      await agree(230);
      await sell(s, [{ method: 'cash', amount: 1000 }]);
      await agree(1230);

      await s.owner.post('money/tracking', { location: 'cash', on: false });
      expect((await s.owner.get('closings/report')).body.money.channels.find((c: { channel: string }) => c.channel === 'cash').countable).toBe(false);
      expect(JSON.stringify((await s.owner.get('money/tracking')).body)).not.toContain('expected');

      // A new opening, today: everything earlier is gone from the figure.
      await track(s, 'cash', 75, day);
      await s.owner.post('maintenance', { clientUuid: randomUUID(), description: 'Today', repairCost: 0, customerPaid: 25, paidMethod: 'cash' });
      await agree(1100);
      const closed = await s.owner.post('closings', { countedCash: 1100 });
      if (closed.status >= 300) throw new Error(JSON.stringify(closed.body));
    });

    it('is the Owner’s, not an Employee’s', async () => {
      const s = await shop();
      expect((await s.staff.post('money/tracking', { location: 'cash', on: true, openingAmount: 1, effectiveDate: '2026-01-01' })).status).toBe(403);
      expect((await s.staff.get('money/tracking')).status).toBe(403);
    });
  });

  it('a rejected return gives its pieces back to what may be returned', async () => {
    const { s, coverLine } = await soldBasket();
    const all = await raise(s, coverLine.id, 5);
    expect((await raise(s, coverLine.id, 1)).status).toBe(409);
    const rejected = await s.owner.post(`returns/${all.body.id}/reject`, { expectedVersion: all.body.version, reason: 'not ours' });
    if (rejected.status < 300) expect((await raise(s, coverLine.id, 1)).status).toBe(201);
    else throw new Error(JSON.stringify(rejected.body));
  });

  it('a device line keeps its one return, and answers build 3 in the shape it reads', async () => {
    const { s, sale, coverLine } = await soldBasket();
    const device = sale.items.find((i) => i.unitId)!;
    const first = await s.owner.post('returns', { saleItemId: binToUuid(device.id), identifier: s.serial, requestReason: 'fault', custody: 'store_holds', clientUuid: randomUUID() });
    expect(first.status).toBe(201);
    expect((await s.owner.post('returns', { saleItemId: binToUuid(device.id), identifier: s.serial, requestReason: 'fault', custody: 'store_holds', clientUuid: randomUUID() })).status).toBe(409);

    // What build 3's return screens draw unconditionally (`app/returns/[id].tsx`, `index.tsx`, mobile 10a260e) is a string.
    const counted = await raise(s, coverLine.id, 2);
    expect(counted.body.phone).toMatchObject({ unitId: '', imei: null, serialNo: null, unitStatus: 'returned', returnedQuantity: 2 });
    expect(typeof counted.body.phone.product).toBe('string');
    expect(counted.body.phone.product.length).toBeGreaterThan(0);
    const list = await s.owner.get('returns');
    const row = list.body.rows.find((r: { id: string }) => r.id === counted.body.id);
    expect(typeof row.product).toBe('string');
    expect(row.identifier).toBeNull();
    expect(typeof row.provisionalGrossRefund).toBe('number');
    // Build 3 sends no disposition: it is told so, and nothing moves.
    const old = await approve(s, counted.body);
    expect(old.status).toBe(400);
    expect(old.body.code).toBe('disposition_required');
    expect(await root.returnReversal.count({ where: { saleItemId: coverLine.id } })).toBe(0);
  });
});
