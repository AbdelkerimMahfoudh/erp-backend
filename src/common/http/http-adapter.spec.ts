import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Controller, Get, type INestApplication, ValidationPipe, VERSION_NEUTRAL, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TenantContext } from '../tenant/tenant-context.service';
import { AppRegistrationController } from '../../platform/app-registration.controller';
import { RegistrationFlowService } from '../../platform/registration-flow.service';
import { TrialController } from '../../platform/trial/trial.controller';
import { TrialService } from '../../platform/trial/trial.service';
import { TrialSetupController } from '../../platform/trial/trial-setup.controller';
import { TrialSetupService } from '../../platform/trial/trial-setup.service';
import { TRIAL_TERMS_VERSION } from '../../platform/trial/trial-rules';
import { apiHttpAdapter } from './http-adapter';

/**
 * Only the canonical, lower-case path reaches a handler (C13; review finding R5-2).
 *
 * The free trial's real controllers — the claim, the link check, the resend, the app's display-only status, the
 * app's registration — behind the adapter `main.ts` serves the API with, the global prefix and URI versioning: the
 * path as written reaches its handler; the same path in capitals, or in any mixed case, answers 404 and reaches
 * nothing. The version-neutral routes and the versioned ones both keep working.
 */

/** A version-neutral route, as `/api/health` is. */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
class NeutralController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}

describe('routes match their letter case exactly (C13)', () => {
  const reached: string[] = [];
  const record = (name: string) => async () => {
    reached.push(name);
    return { reached: name, replayed: false };
  };

  async function boot(adapter = apiHttpAdapter()): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [TrialController, TrialSetupController, AppRegistrationController, NeutralController],
      providers: [
        { provide: TrialService, useValue: { status: record('status'), claim: record('claim') } },
        { provide: TrialSetupService, useValue: { resend: record('resend'), appStatus: record('app-status') } },
        { provide: RegistrationFlowService, useValue: { register: record('register') } },
        { provide: TenantContext, useValue: { companyId: () => Buffer.alloc(16, 1), requireUserId: () => Buffer.alloc(16, 2) } },
      ],
    }).compile();
    const app = moduleRef.createNestApplication(adapter, { logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    return app;
  }

  let app: INestApplication;
  beforeAll(async () => {
    app = await boot();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    reached.length = 0;
  });

  const claim = { idempotencyKey: 'b5a4f0e2-7c1d-4a8e-9f3b-2d6c8e1a0b4f', termsVersion: TRIAL_TERMS_VERSION };
  const registration = {
    idempotencyKey: '0d9c1f6e-3b2a-4c5d-8e7f-a1b2c3d4e5f6',
    ownerName: 'Aicha',
    businessName: 'Boutique Aicha',
    branchName: 'Main',
    email: 'aicha@example.test',
    phone: '+22236000001',
    password: 'password-1',
    language: 'en',
  };

  it.each([
    ['the claim', 'post', '/api/v1/platform/my-subscription/trial/claim', claim, 'claim'],
    ['the resend', 'post', '/api/v1/platform/my-subscription/trial/setup/resend', {}, 'resend'],
    ['the website’s trial card', 'get', '/api/v1/platform/my-subscription/trial', undefined, 'status'],
    ['the app’s status', 'get', '/api/v1/account/trial-setup', undefined, 'app-status'],
    ['the app’s registration', 'post', '/api/v1/auth/register', registration, 'register'],
  ] as const)('%s: the canonical path reaches it; capitals and mixed case answer 404 and reach nothing', async (_name, method, path, body, handler) => {
    const send = (url: string) => {
      // The portal's session, which the claim and the resend require (D211); the other routes ignore it.
      const req = (method === 'post' ? request(app.getHttpServer()).post(url) : request(app.getHttpServer()).get(url)).set('Cookie', 'erp_portal_session=x.y.z');
      return body === undefined ? req : req.send(body);
    };
    const canonical = await send(path);
    expect(canonical.status).toBeLessThan(300);
    expect(reached).toEqual([handler]);

    const mixed = path.replace(/(^|[/-])([a-z])/g, (_m, sep: string, letter: string) => `${sep}${letter.toUpperCase()}`);
    for (const variant of [path.toUpperCase(), mixed, path.replace('/api/v1/', '/API/v1/'), path.replace('/api/v1/', '/api/V1/')]) {
      expect(variant).not.toBe(path);
      const answer = await send(variant);
      expect({ variant, status: answer.status }).toEqual({ variant, status: 404 });
    }
    expect(reached).toEqual([handler]);
  });

  it('the version-neutral routes keep working, in their own case only', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
    await request(app.getHttpServer()).get('/api/HEALTH').expect(404);
    await request(app.getHttpServer()).get('/API/health').expect(404);
  });

  it('main.ts serves the API through this adapter — read from source, as booting the app to inspect it would need a database', () => {
    expect(readFileSync('src/main.ts', 'utf8')).toMatch(/NestFactory\.create<NestExpressApplication>\(AppModule, apiHttpAdapter\(\),/);
  });

  it('without the setting, Express would have matched any case — the adapter is what closes it', async () => {
    const { ExpressAdapter } = await import('@nestjs/platform-express');
    const plain = await boot(new ExpressAdapter());
    try {
      await request(plain.getHttpServer()).post('/API/V1/PLATFORM/MY-SUBSCRIPTION/TRIAL/CLAIM').set('Cookie', 'erp_portal_session=x.y.z').send(claim).expect(201);
      expect(reached).toEqual(['claim']);
    } finally {
      await plain.close();
    }
  });
});
