import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { RequestMethod, ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { TenantContext } from '../../common/tenant/tenant-context.service';
import { PlatformAdminGuard } from '../platform-admin.guard';
import { makeTrialWorld, type TrialWorld } from '../__testing__/trial-world';
import { codeOf as CODE, routeTable } from '../__testing__/route-table';
import { TrialController } from './trial.controller';
import type { TrialPrincipal } from './trial-facts';
import { TrialService } from './trial.service';
import { TrialSetupService } from './trial-setup.service';
import { TRIAL_TERMS_VERSION } from './trial-rules';

/**
 * The free trial's routes (0095; docs/76), from the outside.
 *
 * "Website-only" is a product boundary — only the website shows the workflow — and never a request check: an
 * `Origin`, a `Referer` or a "came from the website" header is whatever a client says (the owner's correction of
 * 2026-10-13). So the proof here is that nothing about where a request claims to come from reaches a decision: the
 * handlers receive the body and nothing else, no line of the trial code reads a header, and the same requests through
 * the real Nest pipeline answer identically with a forged, a genuine or no `Origin` at all.
 */

const SOURCE = readFileSync('src/platform/trial/trial.controller.ts', 'utf8');

const proto = TrialController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const handlers = Object.getOwnPropertyNames(proto).filter(
  (name) => name !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[name]),
);

describe('the trial routes, as Nest sees them', () => {
  it('are exactly the card, the link check, the claim and the resend — under platform/my-subscription, never account/ or auth/', () => {
    const routes = handlers
      .map((name) => {
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[name]) as RequestMethod];
        return `${method} ${Reflect.getMetadata(PATH_METADATA, TrialController)}/${Reflect.getMetadata(PATH_METADATA, proto[name])}`;
      })
      .sort();
    expect(routes).toEqual([
      'GET platform/my-subscription/trial',
      'POST platform/my-subscription/trial/claim',
      'POST platform/my-subscription/trial/link',
      'POST platform/my-subscription/trial/setup/resend',
    ]);
  });

  it('are tenant routes: no @Public (a session is required — 401 without one), and no administrator guard', () => {
    for (const name of handlers) {
      expect({ name, isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, proto[name]) === true }).toEqual({ name, isPublic: false });
      const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, proto[name]) ?? [];
      expect({ name, adminGuard: guards.includes(PlatformAdminGuard) }).toEqual({ name, adminGuard: false });
    }
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, TrialController)).toBeUndefined();
  });

  it('the claim, the link check and the resend are throttled like the account’s sensitive routes', () => {
    for (const name of ['claim', 'checkLink', 'resendSetup']) {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto[name])).toBe(Number(process.env.ACCOUNT_THROTTLE_LIMIT) || 5);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto[name])).toBe(60_000);
    }
  });

  it('every handler receives the body and nothing else — no header, no request, no IP, no query string', () => {
    const allowed = new Set([RouteParamtypes.BODY, RouteParamtypes.RESPONSE]);
    for (const name of handlers) {
      const args: Record<string, { index: number }> = Reflect.getMetadata(ROUTE_ARGS_METADATA, TrialController, name) ?? {};
      const kinds = Object.keys(args).map((key) => Number(key.split(':')[0]) as RouteParamtypes);
      expect({ name, others: kinds.filter((k) => !allowed.has(k)).map((k) => RouteParamtypes[k]) }).toEqual({ name, others: [] });
    }
  });

  it('no line of the trial’s code reads a header, an origin, a referer or a query string', () => {
    for (const file of ['src/platform/trial/trial.controller.ts', 'src/platform/trial/trial.service.ts']) {
      expect({ file, reads: CODE(file).match(/origin|referer|referrer|headers|@Req|@Headers|@Ip|@Query|req\./gi) }).toEqual({ file, reads: null });
    }
    // Every route answers about the caller's own company, from the session.
    expect(SOURCE).toMatch(/companyId: this\.tenant\.companyId\(\), userId: this\.tenant\.requireUserId\(\)/);
  });
});

describe('no trial action under account/ or auth/, and no route that takes a token from a URL', () => {
  it('finds the routes it is about — so it cannot pass by reading nothing', () => {
    const routes = routeTable();
    expect(routes).toEqual(expect.arrayContaining(['POST auth/login', 'GET account', 'POST platform/my-subscription/trial/claim']));
  });

  it('the trial is acted on only under platform/my-subscription, on the website; account/ may only ever show a status', () => {
    const trial = routeTable().filter((r) => /trial/i.test(r));
    // The read-only app status (`GET account/trial-setup`) and the website resend are the setup instructions' (docs/76 §5).
    const allowed = [
      'GET platform/my-subscription/trial',
      'POST platform/my-subscription/trial/link',
      'POST platform/my-subscription/trial/claim',
      'POST platform/my-subscription/trial/setup/resend',
      'GET account/trial-setup',
    ];
    for (const route of trial) expect({ route, allowed: allowed.includes(route) }).toEqual({ route, allowed: true });
    for (const route of trial) {
      expect({ route, writesUnderAppPath: /^(POST|PUT|PATCH|DELETE) (account|auth)(\/|$)/.test(route) }).toEqual({
        route,
        writesUnderAppPath: false,
      });
    }
  });

  it('the one GET of the trial reads no query string: a link preview opening it with ?t= changes nothing', () => {
    expect(CODE('src/platform/trial/trial.controller.ts')).not.toMatch(/@Query|@Param/);
  });
});

describe('Origin and Referer change nothing — through the real Nest pipeline', () => {
  let w: TrialWorld;
  let app: INestApplication;
  let caller: TrialPrincipal;

  async function appOn(world: TrialWorld): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [TrialController],
      providers: [
        { provide: TrialService, useValue: world.service },
        { provide: TrialSetupService, useValue: world.setup },
        // The session's company and person, as the JWT guard leaves them — the only identity a route ever reads.
        { provide: TenantContext, useValue: { companyId: () => caller.companyId, requireUserId: () => caller.userId } },
      ],
    }).compile();
    const nest = moduleRef.createNestApplication({ logger: false });
    nest.setGlobalPrefix('api');
    nest.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    // The production pipe (main.ts): unknown fields refused, so "came from the website" cannot ride in the body either.
    nest.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }),
    );
    await nest.init();
    return nest;
  }

  const FORGED = { Origin: 'https://forged.example', Referer: 'https://forged.example/account/trial' };
  const WEBSITE = { Origin: 'https://dukan.tsx-mr.com', Referer: 'https://dukan.tsx-mr.com/account' };
  const claimBody = (key: string) => ({ idempotencyKey: key, termsVersion: TRIAL_TERMS_VERSION });

  beforeEach(async () => {
    w = makeTrialWorld();
    app = await appOn(w);
  });
  afterEach(async () => {
    await app.close();
  });

  it('an Owner’s claim with a forged Origin succeeds exactly as with none — and its retry replays it', async () => {
    const shop = w.business();
    caller = shop.owner;
    const forged = await request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/claim').set(FORGED).send(claimBody('k-1'));
    expect(forged.status).toBe(201);
    expect(forged.body).toMatchObject({ claimed: true, replayed: false, state: 'trial_active' });

    const bare = await request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/claim').send(claimBody('k-1'));
    expect(bare.status).toBe(200);
    expect(bare.body).toEqual({ ...forged.body, replayed: true });
    expect(w.claims(shop)).toHaveLength(1);
  });

  it('a genuine website Origin earns nothing a missing one does not: the same answers, the same rows', async () => {
    const a = w.business();
    const b = w.business();
    caller = a.owner;
    const withWebsite = await request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/claim').set(WEBSITE).send(claimBody('k-1'));
    caller = b.owner;
    const without = await request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/claim').send(claimBody('k-1'));
    expect([withWebsite.status, without.status]).toEqual([201, 201]);
    expect(withWebsite.body).toEqual(without.body);
    const shape = (rows: Record<string, unknown>[]) => rows.map(({ id, companyId, eligibilityId, claimantUserId, ...rest }) => rest);
    expect(shape(w.claims(a))).toEqual(shape(w.claims(b)));
  });

  it('a Manager is refused owner_only whatever the headers say — the website’s own Origin included', async () => {
    const shop = w.business();
    caller = w.staff(shop, 'store_manager');
    for (const headers of [WEBSITE, FORGED, {}]) {
      const res = await request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/claim').set(headers).send(claimBody('k-1'));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'owner_only' });
    }
    expect(w.claims(shop)).toHaveLength(0);
  });

  it('the card and the link check answer the same with or without an Origin', async () => {
    const shop = w.business();
    caller = shop.owner;
    const token = w.issueLink(shop);
    const cards = await Promise.all(
      [WEBSITE, FORGED, {}].map((h) => request(app.getHttpServer()).get('/api/v1/platform/my-subscription/trial').set(h)),
    );
    expect(cards.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(cards.map((r) => JSON.stringify(r.body))).size).toBe(1);
    const links = await Promise.all(
      [WEBSITE, FORGED, {}].map((h) => request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/link').set(h).send({ token })),
    );
    expect(links.map((r) => [r.status, r.body.link])).toEqual([[200, 'valid'], [200, 'valid'], [200, 'valid']]);
  });

  it('nothing rides in the body either: an unknown field is refused, and the claim takes only what the server decides', async () => {
    const shop = w.business();
    caller = shop.owner;
    const res = await request(app.getHttpServer())
      .post('/api/v1/platform/my-subscription/trial/claim')
      .send({ ...claimBody('k-1'), fromWebsite: true, startedAt: '2026-01-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
    expect(w.claims(shop)).toHaveLength(0);
  });

  it('a link preview opening the trial’s GET with the token in the URL consumes and starts nothing', async () => {
    const shop = w.business();
    caller = shop.owner;
    const token = w.issueLink(shop);
    const res = await request(app.getHttpServer()).get(`/api/v1/platform/my-subscription/trial?t=${token}`);
    expect(res.status).toBe(200);
    expect(w.link(token)).toMatchObject({ consumedAt: null, revokedAt: null });
    expect(w.claims(shop)).toHaveLength(0);
    // No GET route exists for the link or the claim at all.
    for (const path of ['link', 'claim']) {
      const get = await request(app.getHttpServer()).get(`/api/v1/platform/my-subscription/trial/${path}?t=${token}`);
      expect(get.status).toBe(404);
    }
  });
});
