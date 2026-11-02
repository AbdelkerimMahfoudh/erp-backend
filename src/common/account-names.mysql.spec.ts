import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { binToUuid, newUuidV7Bin, uuidToBin } from './utils/uuid.util';

/**
 * An account with no company name, on REAL MySQL through the real API (D227, 0118). Env-gated like the sale specs:
 * SALE_ROOT_URL (fixtures, reads) and SALE_APP_URL (phonestore_app, the API) on a DISPOSABLE database.
 */
const ROOT_URL = process.env.SALE_ROOT_URL ?? '';
const APP_URL = process.env.SALE_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(240_000);

const PASSWORD = 'correct horse battery';

run('an account with no company name', () => {
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

  /** A test account, so one number may hold two: registered with no company name at all. */
  async function account(phone: string, firstStore: string) {
    const { RegistrationService } = await import('../platform/registration.service');
    const t = randomUUID().replace(/-/g, '').slice(0, 10);
    const reg = await app.get(RegistrationService).register({
      idempotencyKey: `names-${t}`,
      ownerName: 'Aicha',
      branchName: `${firstStore} ${t}`,
      phone,
      password: PASSWORD,
      language: 'fr',
      isTest: true,
      testMarkedBy: 'spec',
    });
    return { reg, t, companyId: uuidToBin(reg.companyId), userId: uuidToBin(reg.ownerUserId) };
  }

  /** A further store, as the account's Owner holds every one. */
  async function secondStore(a: Awaited<ReturnType<typeof account>>, name: string) {
    const role = await root.role.findFirstOrThrow({ where: { companyId: a.companyId, key: 'owner' } });
    const branchId = newUuidV7Bin();
    await root.branch.create({ data: { id: branchId, companyId: a.companyId, name: `${name} ${a.t}`, type: 'store', activity: 'electronics' } });
    await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId: a.companyId, userId: a.userId, branchId, roleId: role.id } });
    return branchId;
  }

  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const number = () => `+2224${String(parseInt(randomUUID().replace(/-/g, '').slice(0, 7), 16)).padStart(7, '0').slice(-7)}`;

  it('is stored with no name and nothing invented', async () => {
    const a = await account(number(), 'Centre');
    const company = await root.company.findUniqueOrThrow({ where: { id: a.companyId } });
    expect(company.name).toBeNull();
    expect(company.nameAr).toBeNull();
    const attempt = await root.registrationAttempt.findFirstOrThrow({ where: { companyId: a.companyId } });
    expect(attempt.businessName).toBeNull();
  });

  it('sign-in lists each person’s own stores, and invents no parent from one of them', async () => {
    const phone = number();
    const one = await account(phone, 'Centre');
    await secondStore(one, 'Port');
    const two = await account(phone, 'Marche');

    const answer = (await (await post('auth/login', { identifier: phone, password: PASSWORD })).json()) as {
      status: string;
      accounts: { companyName: string; stores: { name: string }[] }[];
    };
    expect(answer.status).toBe('choose_account');
    const listed = answer.accounts.map((a) => a.stores.map((s) => s.name));
    expect(listed).toEqual(expect.arrayContaining([[`Centre ${one.t}`, `Port ${one.t}`], [`Marche ${two.t}`]]));
    // Build 3 reads one string: every store written out, never one of them standing for the account.
    expect(answer.accounts.map((a) => a.companyName)).toEqual(expect.arrayContaining([`Centre ${one.t}, Port ${one.t}`, `Marche ${two.t}`]));
  });

  it('a store archived since is no longer offered', async () => {
    const phone = number();
    const one = await account(phone, 'Centre');
    const port = await secondStore(one, 'Port');
    await account(phone, 'Marche');
    await root.branch.update({ where: { id: port }, data: { isActive: false } });
    const answer = (await (await post('auth/login', { identifier: phone, password: PASSWORD })).json()) as { accounts: { stores: { name: string }[] }[] };
    expect(answer.accounts.flatMap((a) => a.stores.map((s) => s.name))).not.toContain(`Port ${one.t}`);
  });

  it('a build-3 style name is kept exactly, and a blank one is none', async () => {
    const { RegistrationService } = await import('../platform/registration.service');
    const t = randomUUID().replace(/-/g, '').slice(0, 10);
    const named = await app.get(RegistrationService).register({ idempotencyKey: `n-${t}`, ownerName: 'A', businessName: 'متجر الأمل', branchName: 'Centre', phone: number(), password: PASSWORD, language: 'ar' });
    expect((await root.company.findUniqueOrThrow({ where: { id: uuidToBin(named.companyId) } })).name).toBe('متجر الأمل');
    const blank = await app.get(RegistrationService).register({ idempotencyKey: `b-${t}`, ownerName: 'A', businessName: '   ', branchName: 'Centre', phone: number(), password: PASSWORD, language: 'fr' });
    expect((await root.company.findUniqueOrThrow({ where: { id: uuidToBin(blank.companyId) } })).name).toBeNull();
    expect(binToUuid(uuidToBin(blank.companyId))).toBe(blank.companyId);
  });
});
