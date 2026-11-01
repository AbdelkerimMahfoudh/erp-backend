import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * A real sale through the real API, real guards and the real Prisma client, on REAL MySQL (2026-11-01).
 *
 * Every sale answered "Invalid query parameters" in production: the tenant client adds `companyId` to `companies`, which
 * has no such column, and only real Prisma refuses that. Every mock accepted it, so nothing here is mocked.
 *
 * The body is exactly what TestFlight 1.0.0 (3) sends (`app/(tabs)/sell.tsx`, mobile `10a260e`).
 *
 * Env-gated: SALE_ROOT_URL (root: fixtures and reads) and SALE_APP_URL (phonestore_app: the API) to a DISPOSABLE database.
 */
const ROOT_URL = process.env.SALE_ROOT_URL ?? '';
const APP_URL = process.env.SALE_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(240_000);

run('selling through the API', () => {
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
    // After the environment: the module reads it as it loads.
    const { AppModule } = await import('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    // As `main.ts`: an unknown field in a build's body is a refusal.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
  });

  afterAll(async () => {
    await root?.$disconnect();
    await app?.close();
  });

  /** A business with its Owner, an active subscription, an opened day, and one serialized unit in stock. */
  async function shop(name: string) {
    const { RegistrationService } = await import('../platform/registration.service');
    const { SessionsService } = await import('../auth/sessions.service');
    const { TokensService } = await import('../auth/tokens.service');
    const t = randomUUID().replace(/-/g, '').slice(0, 10);
    const registered = await app.get(RegistrationService).register({
      idempotencyKey: `sale-http-${t}`,
      ownerName: `Owner ${name}`,
      businessName: `${name} ${t}`,
      businessNameAr: `متجر ${t}`,
      branchName: `Centre ${t}`,
      phone: `+2224${String(parseInt(t.slice(0, 7), 16)).padStart(7, '0').slice(-7)}`,
      password: 'correct horse battery',
      language: 'fr',
    });
    const companyId = uuidToBin(registered.companyId);
    const branchId = uuidToBin(registered.branchId);
    const userId = uuidToBin(registered.ownerUserId);
    await root.subscription.updateMany({ where: { companyId }, data: { status: 'activated', currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
    const secret = app.get(TokensService).generateRefreshSecret();
    const sessionId = await app.get(SessionsService).create({ companyId, userId, secret });
    const token = app.get(TokensService).signAccessToken(registered.ownerUserId, registered.companyId, binToUuid(sessionId)).token;
    const productId = newUuidV7Bin();
    await root.product.create({ data: { id: productId, companyId, brand: 'Test', model: `M${t}`, trackingType: 'serial', defaultPrice: 1000 } });
    const serial = `SN${t}`;
    const unitId = newUuidV7Bin();
    await root.unit.create({ data: { id: unitId, companyId, productId, branchId, serialNo: serial, cost: 600, status: 'in_stock' } });
    const call = (path: string, body: unknown) =>
      fetch(`${base}/api/v1/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-branch-id': registered.branchId, 'user-agent': 'DukanERP/3' },
        body: JSON.stringify(body),
      });
    const opened = await call('closings/open', { openingMoney: { decision: 'set', cashAmount: 0 } });
    const said = await opened.text();
    expect({ status: opened.status, said }).toMatchObject({ status: expect.any(Number) });
    if (opened.status >= 300) throw new Error(said);
    return { companyId, branchId, userId, unitId, serial, call, name: `${name} ${t}` };
  }

  /** Build 3's body. */
  const body = (s: { serial: string }, clientUuid: string) => ({
    clientUuid,
    lines: [{ identifier: s.serial, price: 1000 }],
    payments: [{ method: 'cash', amount: 1000 }],
  });

  const counts = async (s: { companyId: Buffer; unitId: Buffer }) => ({
    sales: await root.sale.count({ where: { companyId: s.companyId } }),
    lines: await root.saleItem.count({ where: { companyId: s.companyId } }),
    payments: await root.payment.count({ where: { companyId: s.companyId } }),
    unit: (await root.unit.findUnique({ where: { id: s.unitId }, select: { status: true } }))?.status,
  });

  it('build 3 sells a serialized item for cash: one sale, one line, one payment, the unit sold, the receipt named', async () => {
    const s = await shop('Boutique');
    const response = await s.call('sales', body(s, randomUUID()));
    const answer = await response.text();
    expect({ status: response.status, answer }).toMatchObject({ status: 201 });
    expect(await counts(s)).toEqual({ sales: 1, lines: 1, payments: 1, unit: 'sold' });
    const sale = await root.sale.findFirstOrThrow({ where: { companyId: s.companyId } });
    expect(Number(sale.total)).toBe(1000);
    expect(sale.businessNameSnapshot).toBe(s.name);
    expect(sale.sellerNameSnapshot).toBe('Owner Boutique');
  });

  it('a receipt names only its own business, with another business selling beside it', async () => {
    const [a, b] = await Promise.all([shop('Alpha'), shop('Beta')]);
    const [ra, rb] = await Promise.all([a.call('sales', body(a, randomUUID())), b.call('sales', body(b, randomUUID()))]);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect((await root.sale.findFirstOrThrow({ where: { companyId: a.companyId } })).businessNameSnapshot).toBe(a.name);
    expect((await root.sale.findFirstOrThrow({ where: { companyId: b.companyId } })).businessNameSnapshot).toBe(b.name);
    // Another business's unit is not found from here, and sells nothing.
    const across = await a.call('sales', body(b, randomUUID()));
    expect(across.status).toBe(404);
    expect((await counts(a)).sales).toBe(1);
    expect((await counts(b)).sales).toBe(1);
  });

  it('a retry with the same key, in turn or at the same moment, is the same one sale', async () => {
    const s = await shop('Retry');
    const key = randomUUID();
    const first = await Promise.all([1, 2, 3].map(() => s.call('sales', body(s, key))));
    const statuses = first.map((r) => r.status);
    expect(statuses.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((c) => c < 500)).toBe(true);
    const again = await s.call('sales', body(s, key));
    expect(again.status).toBe(201);
    expect(await counts(s)).toEqual({ sales: 1, lines: 1, payments: 1, unit: 'sold' });
  });

  it('a second key cannot sell the same unit again', async () => {
    const s = await shop('Twice');
    expect((await s.call('sales', body(s, randomUUID()))).status).toBe(201);
    expect((await s.call('sales', body(s, randomUUID()))).status).toBeGreaterThanOrEqual(400);
    expect(await counts(s)).toEqual({ sales: 1, lines: 1, payments: 1, unit: 'sold' });
  });
});
