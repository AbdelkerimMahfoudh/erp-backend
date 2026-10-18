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
import { PortalSessionOnlyGuard } from '../portal/portal-session-only.guard';
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
 * Nothing about where a request claims to come from reaches a decision: an `Origin`, a `Referer` or a "came from the
 * portal" header is whatever a client says (the owner's correction of 2026-10-13). So the handlers receive the body and
 * nothing else, no line of the trial code reads a header, and the same requests through the real Nest pipeline answer
 * identically with a forged, a genuine or no `Origin` at all. What the claim and the resend do require is the portal's
 * own session (D211): the credential the server issued at the portal's sign-in — the portal cookie — never a bearer
 * token, which is the app's (`portal-session-only.guard.ts`).
 */

const SOURCE = readFileSync('src/platform/trial/trial.controller.ts', 'utf8');

const proto = TrialController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const handlers = Object.getOwnPropertyNames(proto).filter(
  (name) => name !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[name]),
);

describe('the trial routes, as Nest sees them', () => {
  it('are exactly the card, the claim and the resend — under platform/my-subscription, never account/ or auth/', () => {
    const routes = handlers
      .map((name) => {
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[name]) as RequestMethod];
        return `${method} ${Reflect.getMetadata(PATH_METADATA, TrialController)}/${Reflect.getMetadata(PATH_METADATA, proto[name])}`;
      })
      .sort();
    expect(routes).toEqual([
      'GET platform/my-subscription/trial',
      'POST platform/my-subscription/trial/claim',
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

  it('the claim and the resend require the portal’s own session; the card does not (D211)', () => {
    const guarded = handlers.filter((name) => ((Reflect.getMetadata(GUARDS_METADATA, proto[name]) ?? []) as unknown[]).includes(PortalSessionOnlyGuard));
    expect(guarded.sort()).toEqual(['claim', 'resendSetup']);
  });

  it('the claim and the resend are throttled like the account’s sensitive routes', () => {
    for (const name of ['claim', 'resendSetup']) {
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

  it('the trial is acted on only under platform/my-subscription, on the portal; account/ may only ever show a status', () => {
    const trial = routeTable().filter((r) => /trial/i.test(r));
    // The read-only app status (`GET account/trial-setup`) and the portal resend are the instructions' (docs/101 §5);
    // `GET platform/trial-claims` is the console's read of the claims, behind the platform guard (docs/101 §7).
    const allowed = [
      'GET platform/my-subscription/trial',
      'POST platform/my-subscription/trial/claim',
      'POST platform/my-subscription/trial/setup/resend',
      'GET account/trial-setup',
      'GET platform/trial-claims',
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
  /** The portal's session, as the JWT strategy has already authenticated it in production. */
  const PORTAL = { Cookie: 'erp_portal_session=x.y.z' };
  const claimPost = () => request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/claim').set(PORTAL);

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
    const forged = await claimPost().set(FORGED).send(claimBody('k-1'));
    expect(forged.status).toBe(201);
    expect(forged.body).toMatchObject({ claimed: true, replayed: false, state: 'trial_active' });

    const bare = await claimPost().send(claimBody('k-1'));
    expect(bare.status).toBe(200);
    expect(bare.body).toEqual({ ...forged.body, replayed: true });
    expect(w.claims(shop)).toHaveLength(1);
  });

  it('a genuine website Origin earns nothing a missing one does not: the same answers, the same rows', async () => {
    const a = w.business();
    const b = w.business();
    caller = a.owner;
    const withWebsite = await claimPost().set(WEBSITE).send(claimBody('k-1'));
    caller = b.owner;
    const without = await claimPost().send(claimBody('k-1'));
    expect([withWebsite.status, without.status]).toEqual([201, 201]);
    expect(withWebsite.body).toEqual(without.body);
    const shape = (rows: Record<string, unknown>[]) => rows.map(({ id, companyId, eligibilityId, claimantUserId, ...rest }) => rest);
    expect(shape(w.claims(a))).toEqual(shape(w.claims(b)));
  });

  it('a Manager is refused owner_only whatever the headers say — the website’s own Origin included', async () => {
    const shop = w.business();
    caller = w.staff(shop, 'store_manager');
    for (const headers of [WEBSITE, FORGED, {}]) {
      const res = await claimPost().set(headers).send(claimBody('k-1'));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'owner_only' });
    }
    expect(w.claims(shop)).toHaveLength(0);
  });

  it('the card answers the same with or without an Origin', async () => {
    const shop = w.business();
    caller = shop.owner;
    const cards = await Promise.all(
      [WEBSITE, FORGED, {}].map((h) => request(app.getHttpServer()).get('/api/v1/platform/my-subscription/trial').set(h)),
    );
    expect(cards.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(cards.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it('nothing rides in the body either: an unknown field is refused, and the claim takes only what the server decides', async () => {
    const shop = w.business();
    caller = shop.owner;
    const res = await request(app.getHttpServer())
      .post('/api/v1/platform/my-subscription/trial/claim')
      .set(PORTAL)
      .send({ ...claimBody('k-1'), fromWebsite: true, startedAt: '2026-01-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
    expect(w.claims(shop)).toHaveLength(0);
  });

  it('a key MySQL would cut is refused before the claim — so every key accepted replays its own retry (C11)', async () => {
    const shop = w.business();
    caller = shop.owner;
    // 80 characters to a length check, 160 to the column: stored cut, it could never match the retry that sends it.
    const res = await claimPost().send(claimBody('a\uFE0F'.repeat(80)));
    expect(res.status).toBe(400);
    expect(w.claims(shop)).toHaveLength(0);
    const key = 'b5a4f0e2-7c1d-4a8e-9f3b-2d6c8e1a0b4f';
    const first = await claimPost().send(claimBody(key));
    const retry = await claimPost().send(claimBody(key));
    expect([first.status, retry.status, retry.body.replayed]).toEqual([201, 200, true]);
  });

  it('a token in a body or a URL is no part of anything: refused as an unknown field, and no link route exists (0099)', async () => {
    const shop = w.business();
    caller = shop.owner;
    const withToken = await request(app.getHttpServer())
      .post('/api/v1/platform/my-subscription/trial/claim')
      .set(PORTAL)
      .send({ ...claimBody('k-1'), token: 'x'.repeat(43) });
    expect(withToken.status).toBe(400);
    const res = await request(app.getHttpServer()).get(`/api/v1/platform/my-subscription/trial?t=${'x'.repeat(43)}`);
    expect(res.status).toBe(200);
    expect(w.claims(shop)).toHaveLength(0);
    // No route exists for a link, and none answers a GET for the claim.
    expect((await request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/link').set(PORTAL).send({ token: 'x'.repeat(43) })).status).toBe(404);
    expect((await request(app.getHttpServer()).get('/api/v1/platform/my-subscription/trial/claim')).status).toBe(404);
  });

  it('an app session cannot claim: a bearer token is refused portal_session_required, with or without the portal cookie (D211)', async () => {
    const shop = w.business();
    caller = shop.owner;
    for (const headers of [{ Authorization: 'Bearer a.b.c' }, { Authorization: 'Bearer a.b.c', ...PORTAL }, {}, { ...WEBSITE }]) {
      const res = await request(app.getHttpServer()).post('/api/v1/platform/my-subscription/trial/claim').set(headers).send(claimBody('k-1'));
      expect({ headers, status: res.status, code: res.body.code }).toEqual({ headers, status: 403, code: 'portal_session_required' });
    }
    expect(w.claims(shop)).toHaveLength(0);
    // The portal's session claims, and the card still answers an app session.
    expect((await claimPost().send(claimBody('k-1'))).status).toBe(201);
    expect((await request(app.getHttpServer()).get('/api/v1/platform/my-subscription/trial').set({ Authorization: 'Bearer a.b.c' })).status).toBe(200);
    expect(w.claims(shop)).toHaveLength(1);
  });
});
