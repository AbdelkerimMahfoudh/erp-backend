import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * One basket, one sale, through the real API, Prisma client and MySQL (D227). Env-gated: SALE_ROOT_URL (fixtures, reads)
 * and SALE_APP_URL (phonestore_app, the API) on a DISPOSABLE database. SALE_REPEAT runs the race that many times.
 */
const ROOT_URL = process.env.SALE_ROOT_URL ?? '';
const APP_URL = process.env.SALE_APP_URL ?? '';
const REPEAT = Number(process.env.SALE_REPEAT ?? 3);
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(420_000);

run('one basket, one sale', () => {
  let app: INestApplication;
  let root: PrismaClient;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_DATABASE_URL: APP_URL,
      JWT_ACCESS_SECRET: 'sale-http-spec-secret-sale-http-spec-secret',
      THROTTLE_LIMIT: '100000',
      AUTH_THROTTLE_LIMIT: '100000',
    });
    const { AppModule } = await import('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
  });
  afterAll(async () => {
    await root?.$disconnect();
    await app?.close();
  });

  /** A business with a phone, AirPods (both serialized) and 5 covers. */
  async function shop() {
    const { RegistrationService } = await import('../platform/registration.service');
    const { SessionsService } = await import('../auth/sessions.service');
    const { TokensService } = await import('../auth/tokens.service');
    const t = randomUUID().replace(/-/g, '').slice(0, 10);
    const reg = await app.get(RegistrationService).register({
      idempotencyKey: `basket-${t}`,
      ownerName: 'Owner',
      businessName: `Basket ${t}`,
      branchName: `Centre ${t}`,
      phone: `+2224${String(parseInt(t.slice(0, 7), 16)).padStart(7, '0').slice(-7)}`,
      password: 'correct horse battery',
      language: 'fr',
    });
    const companyId = uuidToBin(reg.companyId);
    const branchId = uuidToBin(reg.branchId);
    const userId = uuidToBin(reg.ownerUserId);
    await root.subscription.updateMany({ where: { companyId }, data: { status: 'activated', currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
    const secret = app.get(TokensService).generateRefreshSecret();
    const sessionId = await app.get(SessionsService).create({ companyId, userId, secret });
    const token = app.get(TokensService).signAccessToken(reg.ownerUserId, reg.companyId, binToUuid(sessionId)).token;
    const serialized = async (name: string, cost: number) => {
      const productId = newUuidV7Bin();
      await root.product.create({ data: { id: productId, companyId, brand: 'B', model: `${name}${t}`, trackingType: 'serial', defaultPrice: cost * 2 } });
      const serial = `${name}${t}`;
      const unitId = newUuidV7Bin();
      await root.unit.create({ data: { id: unitId, companyId, productId, branchId, serialNo: serial, cost, status: 'in_stock' } });
      return { serial, unitId };
    };
    const phone = await serialized('PH', 600);
    const pods = await serialized('AP', 100);
    const coverId = newUuidV7Bin();
    await root.product.create({ data: { id: coverId, companyId, brand: 'B', model: `CV${t}`, trackingType: 'quantity', defaultPrice: 50 } });
    await root.stockItem.create({ data: { id: newUuidV7Bin(), companyId, productId: coverId, branchId, quantity: 5, cost: 10, price: 50 } });
    const call = (path: string, body: unknown) =>
      fetch(`${base}/api/v1/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-branch-id': reg.branchId },
        body: JSON.stringify(body),
      });
    const opened = await call('closings/open', { openingMoney: { decision: 'set', cashAmount: 0 } });
    if (opened.status >= 300) throw new Error(await opened.text());
    const state = async () => ({
      sales: await root.sale.count({ where: { companyId } }),
      lines: await root.saleItem.count({ where: { companyId } }),
      payments: await root.payment.count({ where: { companyId } }),
      phone: (await root.unit.findUniqueOrThrow({ where: { id: phone.unitId } })).status,
      pods: (await root.unit.findUniqueOrThrow({ where: { id: pods.unitId } })).status,
      covers: (await root.stockItem.findFirstOrThrow({ where: { companyId, productId: coverId } })).quantity,
    });
    return { companyId, phone, pods, coverId: binToUuid(coverId), call, state };
  }
  type Shop = Awaited<ReturnType<typeof shop>>;
  const basket = (s: Shop) => [
    { identifier: s.phone.serial, price: 1000 },
    { productId: s.coverId, quantity: 2, price: 50 },
    { identifier: s.pods.serial, price: 300 },
  ];
  const UNTOUCHED = { sales: 0, lines: 0, payments: 0, phone: 'in_stock', pods: 'in_stock', covers: 5 };

  it('phone + two covers + AirPods: one sale, three lines, one total', async () => {
    const s = await shop();
    const paid = await s.call('sales', { clientUuid: randomUUID(), lines: basket(s), payments: [{ method: 'cash', amount: 1400 }] });
    const text = await paid.text();
    expect({ status: paid.status, text }).toMatchObject({ status: 201 });
    expect(await s.state()).toEqual({ sales: 1, lines: 3, payments: 1, phone: 'sold', pods: 'sold', covers: 3 });
    const sale = await root.sale.findFirstOrThrow({ where: { companyId: s.companyId } });
    expect(Number(sale.total)).toBe(1400);
  });

  it('all or nothing: one unavailable line writes nothing, and names that line alone', async () => {
    const s = await shop();
    await root.unit.update({ where: { id: s.pods.unitId }, data: { status: 'sold' } });
    const r = await s.call('sales', { clientUuid: randomUUID(), lines: basket(s), payments: [{ method: 'cash', amount: 1400 }] });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body).toMatchObject({ code: 'sale_line_conflict', lines: [{ line: 2, reason: 'unavailable' }] });
    expect(JSON.stringify(body)).not.toContain(s.pods.serial);
    expect(await s.state()).toEqual({ ...UNTOUCHED, pods: 'sold' });
  });

  it('reports every refused line at once: the same unit twice, and too many covers', async () => {
    const s = await shop();
    const r = await s.call('sales', {
      clientUuid: randomUUID(),
      lines: [{ identifier: s.phone.serial, price: 1000 }, { identifier: s.phone.serial, price: 1000 }, { productId: s.coverId, quantity: 3, price: 50 }, { productId: s.coverId, quantity: 3, price: 50 }],
      payments: [{ method: 'cash', amount: 2300 }],
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { lines: unknown }).lines).toEqual([{ line: 1, reason: 'duplicate' }, { line: 3, reason: 'insufficient_quantity', available: 2 }]);
    expect(await s.state()).toEqual(UNTOUCHED);
  });

  it(`the same basket confirmed at once, ${REPEAT} times over: always exactly one sale`, async () => {
    for (let i = 0; i < REPEAT; i++) {
      const s = await shop();
      const body = { clientUuid: randomUUID(), lines: basket(s), payments: [{ method: 'cash', amount: 1400 }] };
      const answers = await Promise.all([1, 2, 3].map(() => s.call('sales', body)));
      expect(answers.map((a) => a.status).filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
      expect(answers.every((a) => a.status < 500)).toBe(true);
      // The retry after a lost answer finds that sale.
      const ids = new Set((await Promise.all(answers.filter((a) => a.status === 201).map((a) => a.json()))).map((b) => (b as { id: string }).id));
      const retry = await s.call('sales', body);
      expect(retry.status).toBe(201);
      ids.add(((await retry.json()) as { id: string }).id);
      expect(ids.size).toBe(1);
      expect(await s.state()).toEqual({ sales: 1, lines: 3, payments: 1, phone: 'sold', pods: 'sold', covers: 3 });
    }
  });

  it(`two baskets racing for one phone, ${REPEAT} times over: one sells it, the other is told which line and writes nothing`, async () => {
    for (let i = 0; i < REPEAT; i++) {
      const s = await shop();
      const one = { clientUuid: randomUUID(), lines: basket(s), payments: [{ method: 'cash', amount: 1400 }] };
      const two = { clientUuid: randomUUID(), lines: [{ identifier: s.phone.serial, price: 1000 }], payments: [{ method: 'cash', amount: 1000 }] };
      const [a, b] = await Promise.all([s.call('sales', one), s.call('sales', two)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const state = await s.state();
      expect(state.sales).toBe(1);
      expect(state.phone).toBe('sold');
      expect(state.covers).toBe(a.status === 201 ? 3 : 5);
      expect(state.pods).toBe(a.status === 201 ? 'sold' : 'in_stock');
    }
  });
});
