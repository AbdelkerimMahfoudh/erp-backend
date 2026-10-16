import 'reflect-metadata';
import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AppRegistrationController } from './app-registration.controller';
import { PlatformController, PUBLIC_THROTTLE } from './platform.controller';
import { RegistrationFlowService } from './registration-flow.service';

/**
 * One per-address budget per registration step, whichever door is used (C15; review finding R2-2).
 *
 * Both doors — the website's `platform/register*` and the app's `auth/register*` — through the real ThrottlerGuard,
 * the global prefix and URI versioning, from one address: PUBLIC_THROTTLE requests to a step in a minute in total,
 * shared by the two, and the next is a 429 on either door. Each step keeps its own budget, and the public routes
 * outside the registration keep theirs.
 */

const LIMIT = PUBLIC_THROTTLE.default.limit;

const PATHS = {
  register: ['/api/v1/platform/register', '/api/v1/auth/register'],
  start: ['/api/v1/platform/register/verify/start', '/api/v1/auth/register/verify/start'],
  confirm: ['/api/v1/platform/register/verify/confirm', '/api/v1/auth/register/verify/confirm'],
} as const;

const BODY = {
  register: (i: number) => ({
    idempotencyKey: `k-${i}`,
    ownerName: 'Aicha',
    businessName: 'Boutique Aicha',
    branchName: 'Main',
    email: `aicha${i}@example.test`,
    password: 'password-1',
    language: 'en',
  }),
  start: () => ({ continuation: 'c'.repeat(43), language: 'en' }),
  confirm: () => ({ continuation: 'c'.repeat(43), code: '123456' }),
};

describe('the two registration doors share one throttle budget per step (C15)', () => {
  let app: INestApplication;
  const handled: string[] = [];

  beforeEach(async () => {
    handled.length = 0;
    const flow = {
      register: async () => (handled.push('register'), { status: 'pending_activation', trialEligible: true }),
      startVerification: async () => (handled.push('start'), { delivery: 'sent' }),
      confirmVerification: async () => (handled.push('confirm'), { accessToken: 'a', refreshToken: 'r', expiresIn: 900 }),
    };
    const moduleRef = await Test.createTestingModule({
      // A generous global limit, so only the registration's own can answer 429.
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [PlatformController, AppRegistrationController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    })
      .useMocker((token) => (token === RegistrationFlowService ? flow : {}))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (path: string, body: object) => request(app.getHttpServer()).post(path).send(body);

  it.each([
    ['register', 'register'],
    ['verify/start', 'start'],
    ['verify/confirm', 'confirm'],
  ] as const)('%s: the website door spends the budget, and the app door then answers 429 — and the other way round', async (_name, step) => {
    const [website, appDoor] = PATHS[step];
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT; i += 1) statuses.push((await post(website, BODY[step](i))).status);
    statuses.push((await post(appDoor, BODY[step](100))).status);
    statuses.push((await post(website, BODY[step](101))).status);
    expect(statuses.slice(0, LIMIT).every((s) => s < 300)).toBe(true);
    expect(statuses.slice(LIMIT)).toEqual([429, 429]);
    expect(handled).toHaveLength(LIMIT);
  });

  it('interleaved, the two doors still count as one: half and half, then neither', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT; i += 1) statuses.push((await post(PATHS.register[i % 2], BODY.register(i))).status);
    expect(statuses.every((s) => s === 201)).toBe(true);
    expect((await post(PATHS.register[0], BODY.register(50))).status).toBe(429);
    expect((await post(PATHS.register[1], BODY.register(51))).status).toBe(429);
    expect(handled).toEqual(Array(LIMIT).fill('register'));
  });

  it('each step keeps its own budget: registering to the limit leaves sending and proving the code untouched', async () => {
    for (let i = 0; i < LIMIT; i += 1) await post(PATHS.register[1], BODY.register(i));
    expect((await post(PATHS.register[0], BODY.register(99))).status).toBe(429);
    expect((await post(PATHS.start[1], BODY.start())).status).toBe(200);
    expect((await post(PATHS.confirm[0], BODY.confirm())).status).toBe(200);
  });

  it('the public routes outside the registration keep their own budget', async () => {
    for (let i = 0; i < LIMIT; i += 1) await post(PATHS.start[0], BODY.start());
    expect((await post(PATHS.start[1], BODY.start())).status).toBe(429);
    // Accepting an Owner invitation is not a registration step: its limit is untouched (its handler is a stub here).
    expect((await post('/api/v1/platform/owner-invitation/accept', { token: 't'.repeat(43), password: 'password-1' })).status).not.toBe(429);
  });

  /*
   * BE1-01: the destination-wide `verify-contact/*` door is gone. Anybody could send a code to any contact through
   * it, and every code it issued killed that contact's live registration or staff code and spent its hourly budget.
   * Registration and staff activation prove a contact through their own bound challenges; nothing called this.
   */
  it('no public route sends or proves a code for an arbitrary contact', async () => {
    expect((await post('/api/v1/platform/verify-contact/start', { destination: 'aicha@example.test', language: 'en' })).status).toBe(404);
    expect((await post('/api/v1/platform/verify-contact/confirm', { destination: 'aicha@example.test', code: '123456' })).status).toBe(404);
  });
});
