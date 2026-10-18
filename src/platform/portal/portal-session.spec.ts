import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException, ValidationPipe, VersioningType, type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import { portalCsrfToken } from '../../common/http/portal-csrf';
import { PortalSessionController } from './portal-session.controller';
import { PortalSessionService } from './portal-session.service';

/**
 * The Dukan ERP portal's own sign-in (0099; docs/101 §4), through the real Nest pipeline: the app's identity, Owners
 * only, the tokens in HttpOnly SameSite=Strict cookies and nowhere else, the session's CSRF token in the body, refresh
 * and sign-out that clear what they must.
 */

const SECRET = 'portal-spec-access-secret-at-least-32-chars';
const OWNER = newUuidV7Bin();
const MANAGER = newUuidV7Bin();
const COMPANY = newUuidV7Bin();
const SID = binToUuid(newUuidV7Bin());

function tokens(userId: Buffer, sid = SID) {
  return {
    tokenType: 'Bearer' as const,
    accessToken: `access.${binToUuid(userId)}`,
    expiresIn: 900,
    refreshToken: `${sid}.refresh-secret`,
    user: { id: binToUuid(userId), name: 'X', login: 'x', personalId: 'U-1', companyId: binToUuid(COMPANY), publicStoreId: 'P' },
  };
}

function world() {
  const revoked: string[] = [];
  const auth = {
    login: jest.fn(async (dto: { identifier: string; password: string }) => {
      if (dto.password !== 'right') throw new UnauthorizedException('Invalid credentials');
      if (dto.identifier === 'both-shops') {
        return { status: 'choose_account', continuationToken: 'cont', expiresIn: 120, accounts: [{ accountRef: '0', companyName: 'A', userName: 'O' }] };
      }
      return tokens(dto.identifier === 'manager' ? MANAGER : OWNER);
    }),
    chooseAccount: jest.fn(async () => tokens(OWNER)),
    refresh: jest.fn(async (refreshToken: string) => {
      if (refreshToken !== `${SID}.refresh-secret`) throw new UnauthorizedException('Invalid or expired session');
      return tokens(OWNER);
    }),
  };
  const sessions = {
    revoke: jest.fn(async (userId: Buffer, sessionId: Buffer) => void revoked.push(`${binToUuid(userId)}:${binToUuid(sessionId)}`)),
    rotate: jest.fn(async (sessionId: Buffer, secret: string) => (binToUuid(sessionId) === SID && secret === 'refresh-secret' ? { userId: OWNER, companyId: COMPANY } : null)),
  };
  const tokenService = {
    parseRefreshToken: (t: string) => {
      const i = t.indexOf('.');
      return i > 0 ? { sessionId: t.slice(0, i), secret: t.slice(i + 1) } : null;
    },
    generateRefreshSecret: () => 'fresh',
  };
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }: { where: { id: Buffer; userBranches: unknown } }) =>
        where.id.equals(OWNER) ? { name: 'Aicha', company: { name: 'Boutique Aicha' } } : null,
      ),
    },
  };
  const service = new PortalSessionService(prisma as never, auth as never, sessions as never, tokenService as never, { jwtAccessSecret: SECRET } as never);
  return { service, auth, sessions, revoked };
}

/** The guard the real app runs, standing in: the session route sees the signed-in Owner on the request. */
class AsOwner implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = { userId: binToUuid(OWNER), companyId: binToUuid(COMPANY), sessionId: SID };
    return true;
  }
}

describe('the portal session, through the real pipeline', () => {
  let app: INestApplication;
  let w: ReturnType<typeof world>;

  beforeEach(async () => {
    w = world();
    const moduleRef = await Test.createTestingModule({
      controllers: [PortalSessionController],
      providers: [{ provide: PortalSessionService, useValue: w.service }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalGuards(new AsOwner());
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  const cookiesOf = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);

  it('signs the Owner in: both tokens in HttpOnly SameSite=Strict cookies, the refresh one for the session routes only — none in the body', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/platform/portal/sign-in').send({ identifier: '+22236000001', password: 'right' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      status: 'signed_in',
      session: { owner: { name: 'Aicha' }, business: { name: 'Boutique Aicha' }, csrfToken: portalCsrfToken(SECRET, SID) },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/access\.|refresh-secret/);
    const [access, refresh] = cookiesOf(res);
    expect(access).toMatch(/^erp_portal_session=access\./);
    expect(access).toMatch(/HttpOnly/);
    expect(access).toMatch(/SameSite=Strict/);
    expect(access).toMatch(/Path=\//);
    expect(refresh).toMatch(/^erp_portal_refresh=/);
    expect(refresh).toMatch(/Path=\/api\/v1\/platform\/portal;/);
    expect(refresh).toMatch(/HttpOnly/);
    expect(refresh).toMatch(/SameSite=Strict/);
  });

  it('a wrong password is the generic refusal, with no cookie; an unknown field is refused before anything is checked', async () => {
    const wrong = await request(app.getHttpServer()).post('/api/v1/platform/portal/sign-in').send({ identifier: 'x', password: 'wrong' });
    expect(wrong.status).toBe(401);
    expect(cookiesOf(wrong)).toEqual([]);
    const extra = await request(app.getHttpServer()).post('/api/v1/platform/portal/sign-in').send({ identifier: 'x', password: 'right', companyId: 'c' });
    expect(extra.status).toBe(400);
    expect(w.auth.login).toHaveBeenCalledTimes(1);
  });

  it('a Manager whose password is right is refused owner_only after it — and the session the check made is revoked', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/platform/portal/sign-in').send({ identifier: 'manager', password: 'right' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'owner_only' });
    expect(cookiesOf(res)).toEqual([]);
    expect(w.revoked).toEqual([`${binToUuid(MANAGER)}:${SID}`]);
  });

  it('one contact at two businesses: the chooser first, no cookie; the choice opens the session', async () => {
    const first = await request(app.getHttpServer()).post('/api/v1/platform/portal/sign-in').send({ identifier: 'both-shops', password: 'right' });
    expect(first.body).toMatchObject({ status: 'choose_account', accounts: [{ accountRef: '0' }] });
    expect(cookiesOf(first)).toEqual([]);
    const chosen = await request(app.getHttpServer()).post('/api/v1/platform/portal/choose-account').send({ continuationToken: 'cont', accountRef: '0' });
    expect(chosen.status).toBe(200);
    expect(cookiesOf(chosen)).toHaveLength(2);
  });

  it('refresh rotates from the refresh cookie alone and hands the CSRF token back; a stale one clears both cookies', async () => {
    const ok = await request(app.getHttpServer()).post('/api/v1/platform/portal/refresh').set('Cookie', `erp_portal_refresh=${SID}.refresh-secret`);
    expect(ok.status).toBe(200);
    expect(ok.body.session.csrfToken).toBe(portalCsrfToken(SECRET, SID));
    expect(cookiesOf(ok)).toHaveLength(2);
    const stale = await request(app.getHttpServer()).post('/api/v1/platform/portal/refresh').set('Cookie', 'erp_portal_refresh=old.secret');
    expect(stale.status).toBe(401);
    expect(cookiesOf(stale).every((c) => /Expires=Thu, 01 Jan 1970/.test(c))).toBe(true);
    const none = await request(app.getHttpServer()).post('/api/v1/platform/portal/refresh');
    expect(none.status).toBe(401);
  });

  it('the session route names who is signed in, with the token — the Owner checked again', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/platform/portal/session');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ owner: { name: 'Aicha' }, business: { name: 'Boutique Aicha' }, csrfToken: portalCsrfToken(SECRET, SID) });
  });

  it('sign-out revokes the session the refresh cookie proves and clears both cookies — and clears them whatever it proves', async () => {
    const out = await request(app.getHttpServer()).post('/api/v1/platform/portal/sign-out').set('Cookie', `erp_portal_refresh=${SID}.refresh-secret`);
    expect(out.status).toBe(204);
    expect(w.revoked).toEqual([`${binToUuid(OWNER)}:${SID}`]);
    expect(cookiesOf(out)).toHaveLength(2);
    const forged = await request(app.getHttpServer()).post('/api/v1/platform/portal/sign-out').set('Cookie', 'erp_portal_refresh=forged.x');
    expect(forged.status).toBe(204);
    expect(w.revoked).toHaveLength(1);
    expect(cookiesOf(forged)).toHaveLength(2);
  });
});

describe('the session service on its own', () => {
  it('refuses a session for a person who lost the Owner role at the next refresh', async () => {
    const w = world();
    w.auth.refresh.mockImplementationOnce(async () => tokens(MANAGER));
    await expect(w.service.refresh(`${SID}.refresh-secret`)).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.revoked).toEqual([`${binToUuid(MANAGER)}:${SID}`]);
  });

  it('never reads a request header, an origin or a referer — and never puts a token in what the page receives', () => {
    for (const file of ['src/platform/portal/portal-session.service.ts', 'src/platform/portal/portal-session.controller.ts']) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect({ file, reads: code.match(/origin|referer|referrer/gi) }).toEqual({ file, reads: null });
    }
    const controller = readFileSync('src/platform/portal/portal-session.controller.ts', 'utf8');
    // Every answer that opens a session returns the view alone: the tokens went into the cookies.
    expect(controller.match(/return \{ status: 'signed_in', session: (answer|opened)\.session \}/g)).toHaveLength(3);
  });
});
