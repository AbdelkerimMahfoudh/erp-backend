import 'reflect-metadata';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, HttpStatus, type INestApplication, RequestMethod, ValidationPipe, VersioningType } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { PUBLIC_THROTTLE } from '../platform/platform.controller';
import { RegistrationFlowService } from '../platform/registration-flow.service';
import { WHATSAPP_CONSENT_VERSION } from '../messaging/whatsapp-consent';
import {
  ACQUISITION_LOOKUP_THROTTLE,
  AppAcquisitionController,
  PromotersController,
  ReferralInvitationsController,
  WebsiteAcquisitionController,
} from './acquisition.controllers';
import { AcquisitionService, AcquisitionUnavailableException, invitationUsable, promoterCodeUsable } from './acquisition.service';
import { GLOBAL_FAILURES, LookupLimiter, PER_ADDRESS_FAILURES, TooManyLookupsException, WINDOW_MS } from './lookup-limiter';
import { asciiDigits, newPromoCode, normalisePromoCode } from './promo-code';
import { REFERRAL_TOKEN_LENGTH, referralLink, signReferralToken, verifyReferralToken } from './referral-token';

/**
 * Promoter attribution and user invitations (0103, D221), without a database: the signed link, the six-digit code, the
 * wrong-guess limiter, the one unusable answer, the registration's claim and the routes' guards. The database half —
 * locks, uniqueness, triggers, the attribution's atomicity — is `acquisition.mysql.spec.ts`.
 */

const KEY = 'acquisition-spec-referral-key-of-32-chars-plus';
const REF = Buffer.alloc(16, 7);
const arabicIndic = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const easternArabicIndic = (s: string) => s.replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)));

class FakeClock {
  t = Date.UTC(2026, 9, 25, 10);
  now() {
    return new Date(this.t);
  }
}

describe('the registration link token', () => {
  it('round-trips a promoter QR and an invitation, at the exact documented length', () => {
    const qr = signReferralToken(KEY, { kind: 'promoter', ref: REF, version: 3 });
    const invite = signReferralToken(KEY, { kind: 'user_invite', ref: REF, version: 0 });
    expect(qr).toHaveLength(REFERRAL_TOKEN_LENGTH);
    expect(invite).toHaveLength(REFERRAL_TOKEN_LENGTH);
    expect(qr).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyReferralToken(KEY, qr)).toEqual({ kind: 'promoter', ref: REF, version: 3 });
    expect(verifyReferralToken(KEY, invite)).toEqual({ kind: 'user_invite', ref: REF, version: 0 });
  });

  it('is deterministic — the console can show the same QR again without storing it — and changes with the version', () => {
    const a = signReferralToken(KEY, { kind: 'promoter', ref: REF, version: 1 });
    expect(signReferralToken(KEY, { kind: 'promoter', ref: REF, version: 1 })).toBe(a);
    expect(signReferralToken(KEY, { kind: 'promoter', ref: REF, version: 2 })).not.toBe(a);
  });

  it('is tamper-evident: changing any single character makes it unknown', () => {
    const token = signReferralToken(KEY, { kind: 'promoter', ref: REF, version: 1 });
    for (let i = 0; i < token.length; i++) {
      const replacement = token[i] === 'A' ? 'B' : 'A';
      const changed = token.slice(0, i) + replacement + token.slice(i + 1);
      if (changed !== token) expect(verifyReferralToken(KEY, changed)).toBeNull();
    }
  });

  it('opens only under its own key and its own purpose domain', () => {
    const token = signReferralToken(KEY, { kind: 'promoter', ref: REF, version: 1 });
    expect(verifyReferralToken(`${KEY}-other`, token)).toBeNull();
    // The same bytes relabelled as the other kind fail: each kind is MACed in its own domain.
    const raw = Buffer.from(token, 'base64url');
    raw[0] = 2;
    expect(verifyReferralToken(KEY, raw.toString('base64url'))).toBeNull();
  });

  it('refuses anything that is not exactly a token, before decoding', () => {
    for (const bad of [undefined, null, 42, '', 'short', `${'A'.repeat(REFERRAL_TOKEN_LENGTH)}=`, 'A'.repeat(REFERRAL_TOKEN_LENGTH + 1), '/'.repeat(REFERRAL_TOKEN_LENGTH)]) {
      expect(verifyReferralToken(KEY, bad)).toBeNull();
    }
  });

  it('carries the random public reference and a version — no row id, no name, no number, no code', () => {
    const raw = Buffer.from(signReferralToken(KEY, { kind: 'promoter', ref: REF, version: 9 }), 'base64url');
    expect(raw).toHaveLength(37);
    expect(raw.subarray(1, 17).equals(REF)).toBe(true);
    expect(raw.readUInt32BE(17)).toBe(9);
  });

  it('makes the one canonical address', () => {
    expect(referralLink('https://dukan.tsxmr.com', 'T0K')).toBe('https://dukan.tsxmr.com/join?r=T0K');
  });
});

describe('the six-digit code', () => {
  it('is six digits from a CSPRNG, keeps leading zeroes, and is not sequential', () => {
    const draws = Array.from({ length: 20_000 }, newPromoCode);
    for (const d of draws) expect(d).toMatch(/^[0-9]{6}$/);
    // ~10% of uniform draws start with 0: the padding is kept.
    expect(draws.filter((d) => d.startsWith('0')).length).toBeGreaterThan(1_000);
    // Consecutive draws are not consecutive numbers.
    const steps = draws.slice(1).filter((d, i) => Number(d) === Number(draws[i]) + 1).length;
    expect(steps).toBeLessThan(5);
    expect(new Set(draws).size).toBeGreaterThan(19_000);
  });

  it('reads ASCII, Arabic-Indic and Eastern Arabic-Indic digits as the same code', () => {
    expect(normalisePromoCode('012345')).toBe('012345');
    expect(normalisePromoCode(arabicIndic('012345'))).toBe('012345');
    expect(normalisePromoCode(easternArabicIndic('012345'))).toBe('012345');
    expect(asciiDigits(arabicIndic('9876') + easternArabicIndic('54'))).toBe('987654');
  });

  it('forgives a pasted space, hyphen or direction mark between digits', () => {
    expect(normalisePromoCode('012 345')).toBe('012345');
    expect(normalisePromoCode('012-345')).toBe('012345');
    expect(normalisePromoCode(`${String.fromCharCode(0x200f)}012345${String.fromCharCode(0x200e)}`)).toBe('012345');
  });

  it('refuses anything that is not exactly six digits, before any lookup', () => {
    for (const bad of [undefined, null, 123456, '', '12345', '1234567', '12a456', arabicIndic('12345'), 'x'.repeat(30), '123456;--']) {
      expect(normalisePromoCode(bad)).toBeNull();
    }
  });
});

describe('the wrong-guess limiter', () => {
  it(`stops an address after ${PER_ADDRESS_FAILURES} unusable lookups in the window, and lets it go after`, () => {
    const clock = new FakeClock();
    const limiter = new LookupLimiter(clock);
    for (let i = 0; i < PER_ADDRESS_FAILURES; i++) {
      limiter.assertAllowed('203.0.113.9');
      limiter.recordFailure('203.0.113.9');
    }
    expect(() => limiter.assertAllowed('203.0.113.9')).toThrow(TooManyLookupsException);
    // Another address is not affected.
    expect(() => limiter.assertAllowed('203.0.113.10')).not.toThrow();
    clock.t += WINDOW_MS;
    expect(() => limiter.assertAllowed('203.0.113.9')).not.toThrow();
  });

  it(`stops everybody after ${GLOBAL_FAILURES} unusable lookups across addresses`, () => {
    const limiter = new LookupLimiter(new FakeClock());
    for (let i = 0; i < GLOBAL_FAILURES; i++) limiter.recordFailure(`198.51.100.${i % 250}-${i}`);
    expect(() => limiter.assertAllowed('192.0.2.1')).toThrow(TooManyLookupsException);
  });

  it('answers 429 with a stable code and no state', () => {
    const e = new TooManyLookupsException();
    expect(e.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(e.getResponse()).toEqual({ code: 'acquisition_lookup_limited', message: expect.any(String) });
  });

  it('bounds what an enumerator can learn: one address finds a usable code with probability under 0.1% a day at 100 live codes', () => {
    const perDay = PER_ADDRESS_FAILURES * ((24 * 60 * 60 * 1000) / WINDOW_MS);
    const live = 100;
    expect(perDay * (live / 1_000_000)).toBeLessThan(0.05);
    // And every address together is held to the global ceiling.
    const everyone = GLOBAL_FAILURES * ((24 * 60 * 60 * 1000) / WINDOW_MS);
    expect(everyone * (live / 1_000_000)).toBeLessThan(2);
  });
});

describe('usability', () => {
  const id = Buffer.alloc(16, 1);
  const code = (o: Partial<{ retiredAt: Date | null; isActive: boolean; currentCodeId: Buffer | null }> = {}) => ({
    id,
    retiredAt: o.retiredAt ?? null,
    promoter: { isActive: o.isActive ?? true, currentCodeId: o.currentCodeId === undefined ? id : o.currentCodeId },
  });

  it('a code is usable only while current, unretired and its promoter active', () => {
    expect(promoterCodeUsable(code())).toBe(true);
    expect(promoterCodeUsable(code({ retiredAt: new Date() }))).toBe(false);
    expect(promoterCodeUsable(code({ isActive: false }))).toBe(false);
    expect(promoterCodeUsable(code({ currentCodeId: Buffer.alloc(16, 2) }))).toBe(false);
    expect(promoterCodeUsable(code({ currentCodeId: null }))).toBe(false);
  });

  it('an invitation is usable while unrevoked, its business open and its maker still there', () => {
    const ok = { revokedAt: null, company: { isActive: true, closedAt: null }, createdBy: { isActive: true, deletedAt: null } };
    expect(invitationUsable(ok)).toBe(true);
    expect(invitationUsable({ ...ok, revokedAt: new Date() })).toBe(false);
    expect(invitationUsable({ ...ok, company: { isActive: true, closedAt: new Date() } })).toBe(false);
    expect(invitationUsable({ ...ok, company: { isActive: false, closedAt: null } })).toBe(false);
    expect(invitationUsable({ ...ok, createdBy: { isActive: false, deletedAt: null } })).toBe(false);
    expect(invitationUsable({ ...ok, createdBy: { isActive: true, deletedAt: new Date() } })).toBe(false);
  });
});

/** The service over a tiny in-memory world: what each lookup reads, nothing more. */
function world() {
  const promoterId = Buffer.alloc(16, 3);
  const codeId = Buffer.alloc(16, 4);
  const promoterRef = Buffer.alloc(16, 5);
  const inviteRef = Buffer.alloc(16, 6);
  const state = {
    promoter: { id: promoterId, displayName: 'Sidi Mohamed', isActive: true, currentCodeId: codeId as Buffer | null },
    code: { id: codeId, promoterId, code: '004217', version: 2, retiredAt: null as Date | null },
    invitation: {
      id: Buffer.alloc(16, 8),
      companyId: Buffer.alloc(16, 9),
      createdByUserId: Buffer.alloc(16, 10),
      revokedAt: null as Date | null,
      company: { isActive: true, closedAt: null },
      createdBy: { isActive: true, deletedAt: null },
    },
  };
  const prisma = {
    promoterCode: {
      findUnique: async ({ where }: { where: { code: string } }) =>
        where.code === state.code.code ? { ...state.code, promoter: { ...state.promoter } } : null,
    },
    promoter: {
      findUnique: async ({ where }: { where: { publicRef: Buffer } }) =>
        where.publicRef.equals(promoterRef) ? { currentCode: state.promoter.currentCodeId ? { code: state.code.code, version: state.code.version } : null } : null,
    },
    referralInvitation: {
      findUnique: async ({ where }: { where: { publicRef: Buffer } }) => (where.publicRef.equals(inviteRef) ? { ...state.invitation } : null),
    },
  };
  const limiter = new LookupLimiter(new FakeClock());
  const service = new AcquisitionService(prisma as never, { referralKey: KEY, portalOrigin: 'https://dukan.tsxmr.com' } as never, limiter);
  const qr = (version = 2) => signReferralToken(KEY, { kind: 'promoter', ref: promoterRef, version });
  const invite = () => signReferralToken(KEY, { kind: 'user_invite', ref: inviteRef, version: 0 });
  return { state, service, limiter, qr, invite };
}

describe('the public lookups', () => {
  it('a usable code answers its promoter’s display name — and nothing about the promoter’s contact or record', async () => {
    const { service } = world();
    const answer = await service.lookupCode(arabicIndic('004217'), '192.0.2.1');
    expect(answer).toEqual({ usable: true, source: 'promoter', promoterName: 'Sidi Mohamed', code: '004217' });
  });

  it('unknown, malformed, retired, deactivated and replaced codes all get the one identical answer', async () => {
    const answers: unknown[] = [];
    const ask = async (mutate: (w: ReturnType<typeof world>) => void, typed = '004217') => {
      const w = world();
      mutate(w);
      answers.push(await w.service.lookupCode(typed, '192.0.2.1'));
    };
    await ask(() => undefined, '999999');
    await ask(() => undefined, '12');
    await ask((w) => (w.state.code.retiredAt = new Date()));
    await ask((w) => (w.state.promoter.isActive = false));
    await ask((w) => (w.state.promoter.currentCodeId = Buffer.alloc(16, 99)));
    for (const a of answers) expect(a).toStrictEqual({ usable: false });
  });

  it('a QR link prefills its code and name while its version is current, and is unusable once regenerated', async () => {
    const w = world();
    expect(await w.service.lookupLink(w.qr(2), null)).toEqual({ usable: true, source: 'promoter', promoterName: 'Sidi Mohamed', code: '004217' });
    expect(await w.service.lookupLink(w.qr(1), null)).toStrictEqual({ usable: false });
  });

  it('an invitation link says only that it is an invitation — no business, no person', async () => {
    const w = world();
    expect(await w.service.lookupLink(w.invite(), null)).toStrictEqual({ usable: true, source: 'user_invite' });
    w.state.invitation.revokedAt = new Date();
    expect(await w.service.lookupLink(w.invite(), null)).toStrictEqual({ usable: false });
  });

  it('a tampered or foreign link is unusable, and every unusable answer spends a guess until the address is stopped', async () => {
    const w = world();
    const tampered = `${w.qr(2).slice(0, -2)}AA`;
    for (let i = 0; i < PER_ADDRESS_FAILURES; i++) expect(await w.service.lookupLink(tampered, '192.0.2.7')).toStrictEqual({ usable: false });
    // Stopped: a usable code from that address is refused too, so a guesser cannot tell a hit.
    await expect(w.service.lookupCode('004217', '192.0.2.7')).rejects.toBeInstanceOf(TooManyLookupsException);
  });

  it('a server without its signing key opens no link at all', async () => {
    const w = world();
    const keyless = new AcquisitionService({} as never, { referralKey: null } as never, w.limiter);
    expect(await keyless.lookupLink(w.qr(2), null)).toStrictEqual({ usable: false });
  });
});

describe('the registration’s claim', () => {
  const { service } = world();

  it('carries at most one source; both is the registrant’s choice, refused with acquisition_conflict', () => {
    expect(service.claimOf(undefined)).toBeNull();
    expect(service.claimOf({ promoCode: ' ', referralToken: '' })).toBeNull();
    expect(service.claimOf({ promoCode: '004217' })).toEqual({ promoCode: '004217' });
    expect(service.claimOf({ referralToken: 'T' })).toEqual({ referralToken: 'T' });
    try {
      service.claimOf({ promoCode: '004217', referralToken: 'T' });
      throw new Error('accepted both');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'acquisition_conflict' });
    }
  });

  it('an unavailable source is a specific, safe refusal that says nothing was saved', () => {
    for (const source of ['promoter', 'user_invite'] as const) {
      const body = new AcquisitionUnavailableException(source).getResponse() as Record<string, string>;
      expect(body.code).toBe('acquisition_unavailable');
      expect(body.source).toBe(source);
      expect(body.message).toMatch(/Nothing was saved/);
    }
  });

  it('the registration flow refuses a source it cannot check rather than dropping it silently', async () => {
    const flow = new RegistrationFlowService({} as never, {} as never, { canDeliver: () => true } as never, {} as never);
    await expect(
      flow.register(
        { idempotencyKey: 'k', ownerName: 'a', businessName: 'b', branchName: 'c', phone: '22222222', password: 'password-1', language: 'en', whatsappConsentVersion: WHATSAPP_CONSENT_VERSION, promoCode: '004217' } as never,
        { source: 'mobile_registration' },
      ),
    ).rejects.toBeInstanceOf(AcquisitionUnavailableException);
  });
});

describe('the routes', () => {
  const guards = (proto: object, name: string) => Reflect.getMetadata(GUARDS_METADATA, (proto as Record<string, object>)[name]) ?? [];
  const method = (proto: object, name: string) => Reflect.getMetadata(METHOD_METADATA, (proto as Record<string, object>)[name]);
  const isPublic = (proto: object, name: string) => Reflect.getMetadata(IS_PUBLIC_KEY, (proto as Record<string, object>)[name]) === true;
  const handlers = (cls: { prototype: object }) => Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== 'constructor');

  it('every console route is the platform administrator’s, behind the MFA guard', () => {
    for (const name of handlers(PromotersController)) {
      expect(guards(PromotersController.prototype, name)).toContain(PlatformAdminGuard);
      expect(isPublic(PromotersController.prototype, name)).toBe(true);
    }
  });

  it('every console change asks for the password and step-up first', () => {
    const source = readFileSync(join(__dirname, 'acquisition.controllers.ts'), 'utf8');
    const console = source.slice(source.indexOf('export class PromotersController'), source.indexOf('export class ReferralInvitationsController'));
    const mutations = [...console.matchAll(/@(Post|Patch)\('[^']+'\)[\s\S]*?\n  }\n/g)].map((m) => m[0]);
    expect(mutations).toHaveLength(5);
    for (const m of mutations) expect(m).toMatch(/await this\.admins\.confirmPassword\(admin\.id, dto\.confirmPassword\)/);
  });

  it('the public lookups are POST on both doors — a code or token never sits in a URL — and there is no list', () => {
    for (const cls of [WebsiteAcquisitionController, AppAcquisitionController]) {
      expect(handlers(cls).sort()).toEqual(['code', 'link']);
      for (const name of handlers(cls)) {
        expect(method(cls.prototype, name)).toBe(RequestMethod.POST);
        expect(isPublic(cls.prototype, name)).toBe(true);
      }
    }
  });

  it('a user’s invitation routes need a signed-in user: none is public', () => {
    for (const name of handlers(ReferralInvitationsController)) expect(isPublic(ReferralInvitationsController.prototype, name)).toBe(false);
  });
});

describe('both lookup doors share one budget per address', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const acquisition = { lookupCode: async () => ({ usable: false }), lookupLink: async () => ({ usable: false }) };
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [WebsiteAcquisitionController, AppAcquisitionController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    })
      .useMocker((token) => (token === AcquisitionService ? acquisition : {}))
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(() => app.close());

  it(`${PUBLIC_THROTTLE.default.limit} lookups a minute in total, whichever door and route, then 429`, async () => {
    const paths = ['/api/v1/platform/acquisition/code', '/api/v1/auth/acquisition/code', '/api/v1/platform/acquisition/link', '/api/v1/auth/acquisition/link'];
    const limit = ACQUISITION_LOOKUP_THROTTLE.default.limit;
    for (let i = 0; i < limit; i++) {
      const path = paths[i % paths.length];
      const body = path.endsWith('code') ? { code: '123456' } : { token: 'x'.repeat(50) };
      await request(app.getHttpServer()).post(path).send(body).expect(200);
    }
    for (const path of paths) {
      const body = path.endsWith('code') ? { code: '123456' } : { token: 'x'.repeat(50) };
      await request(app.getHttpServer()).post(path).send(body).expect(429);
    }
  });

  it('refuses a body with anything else in it', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/acquisition/code').send({ code: '123456', promoterId: 'x' }).expect(400);
  });
});

describe('what this feature never contains', () => {
  /*
   * Attribution and factual counts only (D221). The excluded concepts appear nowhere in this feature's code or schema —
   * not even negated — so a search for them finds nothing to explain. (`trialEligible` is the free trial's own flag
   * (0095), which a registration in the real-MySQL spec passes as every self-registration does.)
   */
  const EXCLUDED = /reward|commission|payout|balance|(?<!trial)eligib|free.?month|lifetime|referral.?point|compensat|bonus|credit|milestone|amount/i;

  it('in the acquisition code and its migration', () => {
    const files = readdirSync(__dirname)
      .filter((f) => f.endsWith('.ts') && f !== 'acquisition.spec.ts')
      .map((f) => join(__dirname, f));
    files.push(join(__dirname, '..', '..', 'prisma', 'migrations', '0103_promoter_attribution', 'migration.sql'));
    for (const file of files) expect({ file, hit: readFileSync(file, 'utf8').match(EXCLUDED)?.[0] ?? null }).toEqual({ file, hit: null });
  });

  it('in the public answers: a promoter’s number and note never leave the console', () => {
    const service = readFileSync(join(__dirname, 'acquisition.service.ts'), 'utf8');
    const answer = service.slice(service.indexOf('private answer('), service.indexOf('// ── Reporting'));
    expect(answer).not.toMatch(/whatsapp|note|phone/i);
    const facts = service.slice(service.indexOf('const CODE_FACTS'), service.indexOf('type Db ='));
    expect(facts).not.toMatch(/whatsapp|note|phone/i);
  });
});
