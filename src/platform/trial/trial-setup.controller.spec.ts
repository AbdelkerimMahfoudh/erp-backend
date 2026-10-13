import 'reflect-metadata';
import { RequestMethod, ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { TenantContext } from '../../common/tenant/tenant-context.service';
import { PlatformAdminGuard } from '../platform-admin.guard';
import { codeOf, routeTable } from '../__testing__/route-table';
import { NOW, TestEmailChannel, makeTrialWorld, type Business, type TrialWorld } from '../__testing__/trial-world';
import type { TrialPrincipal } from './trial-facts';
import { TrialController } from './trial.controller';
import { TrialService } from './trial.service';
import { TrialSetupController } from './trial-setup.controller';
import { TrialSetupService } from './trial-setup.service';

/**
 * The free trial in the app: display only (0095; docs/76; the owner's correction of 2026-10-13).
 *
 * The app may show that the business is eligible, that its trial has not started, how long it lasts, whether the
 * setup instructions reached the Owner's verified contacts and when none can be reached — and nothing it could act
 * on. These specs pin that from the outside: the app's one trial route is a read, no route under `account/` or
 * `auth/` sends, claims or checks a link, the answer carries no action data, and the resend is the website's — it
 * reads nothing from the request, so no body can name where the instructions go.
 */

const proto = TrialSetupController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const handlers = Object.getOwnPropertyNames(proto).filter(
  (name) => name !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[name]),
);

describe('the app’s one trial route', () => {
  it('is a single read, GET account/trial-setup: a tenant route with no administrator guard, reading nothing from the request', () => {
    expect(
      handlers.map((name) => {
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[name]) as RequestMethod];
        return `${method} ${Reflect.getMetadata(PATH_METADATA, TrialSetupController)}/${Reflect.getMetadata(PATH_METADATA, proto[name])}`;
      }),
    ).toEqual(['GET account/trial-setup']);
    for (const name of handlers) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto[name])).toBeUndefined();
      expect((Reflect.getMetadata(GUARDS_METADATA, proto[name]) ?? []) as unknown[]).not.toContain(PlatformAdminGuard);
      // No body, no query, no header, no request: the session is all it reads.
      expect(Reflect.getMetadata(ROUTE_ARGS_METADATA, TrialSetupController, name)).toBeUndefined();
    }
    expect(codeOf('src/platform/trial/trial-setup.controller.ts')).not.toMatch(/@(Post|Put|Patch|Delete|Body|Query|Param|Req|Headers)\b/);
  });

  it('under account/ and auth/ nothing sends, claims or checks a link: the one trial route there is this read', () => {
    const routes = routeTable();
    // It finds the routes it is about, so it cannot pass by reading nothing.
    expect(routes).toEqual(expect.arrayContaining(['GET account', 'POST auth/login', 'GET account/trial-setup']));
    const appSide = routes.filter((r) => / (account|auth)(\/|$)/.test(r));
    expect(appSide.filter((r) => /trial|setup|claim|link|token/i.test(r))).toEqual(['GET account/trial-setup']);
    // The one resend there is the deletion code's (docs/64) — nothing of the trial.
    expect(appSide.filter((r) => /resend/i.test(r))).toEqual(['POST account/deletion/resend']);
  });

  it('every trial action lives under platform/my-subscription — the website’s, which the app never calls', () => {
    const actions = routeTable().filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r) && /trial/i.test(r));
    expect(actions.sort()).toEqual([
      'POST platform/my-subscription/trial/claim',
      'POST platform/my-subscription/trial/link',
      'POST platform/my-subscription/trial/setup/resend',
    ]);
  });
});

describe('through the real Nest pipeline', () => {
  let w: TrialWorld;
  let app: INestApplication;
  let caller: TrialPrincipal;
  let shop: Business;

  beforeEach(async () => {
    w = makeTrialWorld();
    const moduleRef = await Test.createTestingModule({
      controllers: [TrialController, TrialSetupController],
      providers: [
        { provide: TrialService, useValue: w.service },
        { provide: TrialSetupService, useValue: w.setup },
        // The session's company and person, as the JWT guard leaves them — the only identity a route ever reads.
        { provide: TenantContext, useValue: { companyId: () => caller.companyId, requireUserId: () => caller.userId } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }),
    );
    await app.init();
    shop = w.business();
    await w.setup.onContactsVerified(shop.companyId, shop.ownerId);
  });
  afterEach(async () => {
    await app.close();
  });

  it('the Owner reads display data; a Manager is refused owner_only', async () => {
    caller = shop.owner;
    const res = await request(app.getHttpServer()).get('/api/v1/account/trial-setup');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'trial_available', eligible: true, durationDays: 7, delivery: 'sent', sentTo: ['email'] });
    expect(Object.keys(res.body).sort()).toEqual(
      ['delivery', 'destinations', 'durationDays', 'durationHours', 'eligible', 'lastAttemptAt', 'missingContacts', 'requiredContacts', 'sentTo', 'state', 'timeZone'].sort(),
    );

    caller = w.staff(shop, 'store_manager');
    const refused = await request(app.getHttpServer()).get('/api/v1/account/trial-setup');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'owner_only' });
  });

  it('nothing under account/trial-setup can be posted to, and its read sends nothing whatever the URL says', async () => {
    caller = shop.owner;
    for (const path of ['/api/v1/account/trial-setup', '/api/v1/account/trial-setup/resend', '/api/v1/account/trial-setup/send']) {
      expect((await request(app.getHttpServer()).post(path).send({})).status).toBe(404);
    }
    const token = (w.email as TestEmailChannel).sent[0].variables.link.split('#t=')[1];
    const read = await request(app.getHttpServer()).get(`/api/v1/account/trial-setup?resend=1&t=${token}`);
    expect(read.status).toBe(200);
    expect((w.email as TestEmailChannel).sent).toHaveLength(1);
    expect(w.messages(shop)).toHaveLength(1);
    expect(w.link(token).consumedAt).toBeNull();
  });

  it('the website’s resend reads nothing from the request: a body naming a destination is ignored, a forged Origin too', async () => {
    caller = shop.owner;
    w.clock.set(new Date(NOW.getTime() + 60_000));
    const res = await request(app.getHttpServer())
      .post('/api/v1/platform/my-subscription/trial/setup/resend')
      .set({ Origin: 'https://forged.example', Referer: 'https://forged.example/' })
      .send({ to: 'attacker@example.com', channel: 'email', phone: '+22299999999' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ delivery: 'sent', canResendNow: false, history: [expect.objectContaining({ trigger: 'resend' }), expect.anything()] });
    const sent = (w.email as TestEmailChannel).sent;
    expect(sent.map((m) => m.to)).toEqual([shop.email, shop.email]);
    expect(JSON.stringify(sent)).not.toContain('attacker');
  });

  it('too soon is 429 with when; a Manager is 403 — whatever the headers say', async () => {
    caller = shop.owner;
    const soon = await request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/setup/resend').set({ Origin: 'https://dukan.tsx-mr.com' });
    expect(soon.status).toBe(429);
    expect(soon.body).toMatchObject({ code: 'too_many_requests', resendAvailableAt: new Date(NOW.getTime() + 60_000).toISOString() });

    caller = w.staff(shop, 'store_manager');
    const manager = await request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/setup/resend').set({ Origin: 'https://dukan.tsx-mr.com' });
    expect(manager.status).toBe(403);
    expect(manager.body).toMatchObject({ code: 'owner_only' });
  });
});
