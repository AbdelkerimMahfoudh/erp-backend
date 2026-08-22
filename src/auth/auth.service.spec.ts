import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * Login: tenant resolution (F1 Stage 3.2) + the device decision tree (Stage 3.1).
 *
 * Stage 3.2 rule: the client names its company by the PUBLIC Store Account ID,
 * the user is found only inside that company, and a bad Store ID / login /
 * password all fail identically (non-enumerating) after spending an Argon2
 * verify (timing-safe). The device credential is only ever looked at AFTER the
 * primary credentials are valid.
 *
 * Stage 3.1 rule (still pinned): a device credential CLAIM must be a valid,
 * complete, recognised pair or login fails CLOSED — no session, device or secret.
 */

const STORE_A = 'ABCDE12345'; // company A's canonical public store id
const STORE_B = 'FEDCBA9876'; // company B's
const COMPANY_A = newUuidV7Bin();
const COMPANY_B = newUuidV7Bin();

interface FakeUser {
  id: Buffer;
  companyId: Buffer;
  name: string;
  login: string;
  personalId: string;
  phone: string | null;
  passwordHash: string;
  isActive: boolean;
  deletedAt: Date | null;
}

/**
 * A valid personal ID for a test login.
 *
 * Built from the same restricted alphabet the product uses — `U-OWNERXXX`
 * looks plausible and is not a personal ID at all, because `O` is one of the
 * glyphs deliberately excluded.
 */
function personalIdFor(login: string): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  let body = '';
  for (let i = 0; i < 8; i++) {
    body += alphabet[(login.charCodeAt(i % login.length) + i * 7) % alphabet.length];
  }
  return `U-${body}`;
}

function user(companyId: Buffer, login: string, over: Partial<FakeUser> = {}): FakeUser {
  return {
    id: newUuidV7Bin(),
    companyId,
    name: login,
    login,
    // Only characters the real alphabet contains: no I, L, O, U, 0 or 1.
    personalId: personalIdFor(login),
    phone: null,
    passwordHash: '$argon2id$SECRET-HASH',
    isActive: true,
    deletedAt: null,
    ...over,
  };
}

function makeService(opts: {
  companies?: Record<string, { id: Buffer; isActive: boolean; publicStoreId: string }>;
  users?: FakeUser[];
  recognise?: unknown;
  verifyPassword?: boolean;
} = {}) {
  const sessionId = newUuidV7Bin();
  const companies = opts.companies ?? { [STORE_A]: { id: COMPANY_A, isActive: true, publicStoreId: STORE_A } };
  const users = opts.users ?? [user(COMPANY_A, 'owner')];

  const usersSvc = {
    findByLoginForAuth: jest.fn(async (companyId: Buffer, login: string) =>
      users.find((u) => u.companyId.equals(companyId) && u.login === login && !u.deletedAt) ?? null,
    ),
    /*
      CP3: one identifier, resolved across companies. A personal ID matches at
      most one user; a phone may match one per company, which is what makes
      the chooser necessary.
    */
    findCandidatesForAuth: jest.fn(async (kind: 'personal_id' | 'phone', value: string) =>
      users.filter(
        (u) =>
          !u.deletedAt &&
          u.isActive &&
          (kind === 'personal_id' ? u.personalId === value : u.phone === value),
      ),
    ),
    setLastLogin: jest.fn(async () => undefined),
    findById: jest.fn(async () => users[0]),
  };
  const hashing = {
    verify: jest.fn(async () => opts.verifyPassword ?? true),
    verifyDummy: jest.fn(async () => false),
  };
  const tokens = {
    generateRefreshSecret: jest.fn(() => 'refresh-secret'),
    signAccessToken: jest.fn(() => ({ token: 'access.jwt.token', expiresIn: 900 })),
    buildRefreshToken: jest.fn(() => 'sid.refresh-secret'),
    signContinuation: jest.fn(() => 'continuation.jwt.token'),
    verifyContinuation: jest.fn(() => null),
  };
  const sessions = { create: jest.fn(async () => sessionId) };
  const devices = {
    recognise: jest.fn(async () => (opts.recognise === undefined ? null : opts.recognise)),
    attach: jest.fn(async () => undefined),
    enroll: jest.fn(async () => ({ deviceId: 'new-device-id', deviceSecret: 'ISSUED-SECRET', trustMethod: 'password' })),
  };
  const prisma = {
    company: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.publicStoreId) return companies[where.publicStoreId] ?? null;
        // CP3 resolves the company FROM the user, so the lookup is by id.
        return Object.values(companies).find((c: any) => c.id.equals(where.id)) ?? null;
      }),
      // Only reached when one phone matches more than one shop.
      findMany: jest.fn(async ({ where }: any) =>
        Object.values(companies)
          .filter((c: any) => c.isActive && where.id.in.some((id: Buffer) => id.equals(c.id)))
          .map((c: any) => ({ id: c.id, name: `Shop ${c.publicStoreId}` })),
      ),
    },

  };

  const service = new AuthService(
    usersSvc as never,
    hashing as never,
    tokens as never,
    sessions as never,
    devices as never,
    prisma as never,
  );
  return { service, usersSvc, hashing, tokens, sessions, devices, prisma, sessionId };
}

const meta = { label: 'Test phone', platform: 'android' };
/**
 * Sign in with the ONE identifier the field now takes.
 *
 * The result is narrowed to a signed-in response: a test that expects tokens
 * and gets an account chooser has found a real bug, and should fail here
 * rather than silently read `undefined` off the wrong shape.
 */
const doLogin = async (service: AuthService, over: Record<string, unknown> = {}) => {
  const result = await service.login({ identifier: personalIdFor('owner'), password: 'pw', ...over } as never, {});
  if ('status' in result) throw new Error('expected a signed-in response, got an account chooser');
  return result;
};

// ─────────────────────────── Stage 3.2: tenant resolution ───────────────────

describe('tenant resolution from the credential (CP3)', () => {
  it('resolves the company FROM the credential, with no Store ID supplied', async () => {
    /*
      The heart of CP3. The caller names no company at all; the server works
      out who the identifier belongs to and which shop that is. Nothing about
      the tenant is trusted from an unauthenticated request, which is strictly
      stronger than a Store ID selecting the company before any credential was
      checked.
    */
    const { service, tokens, usersSvc, prisma } = makeService();

    const res = await doLogin(service);

    expect(usersSvc.findCandidatesForAuth).toHaveBeenCalledWith('personal_id', personalIdFor('owner'));
    // The company was looked up BY ID, derived from the user — not by a
    // public store code the client sent.
    expect(prisma.company.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: COMPANY_A } }),
    );
    expect(res.user.publicStoreId).toBe(STORE_A);
    expect(tokens.signAccessToken).toHaveBeenCalled();
  });

  it('signs in by phone number just as well as by personal ID', async () => {
    const owner = user(COMPANY_A, 'owner', { phone: '+22243210987' });
    const { service, usersSvc } = makeService({ users: [owner] });

    // Typed the way it is printed on a card, spaces and all.
    const res = await doLogin(service, { identifier: '4321 0987' });

    expect(usersSvc.findCandidatesForAuth).toHaveBeenCalledWith('phone', '+22243210987');
    expect(res.user.publicStoreId).toBe(STORE_A);
  });

  it('a Store ID is not an identifier and resolves to nobody', async () => {
    // The whole point: nobody types one to sign in, and sending one gets the
    // same generic failure as any other unrecognised string.
    const { service, usersSvc } = makeService();
    await expect(doLogin(service, { identifier: STORE_A })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersSvc.findCandidatesForAuth).not.toHaveBeenCalled();
  });

  it('one phone in two companies asks WHICH SHOP — after the password, never before', async () => {
    /*
      Ambiguity is resolved by asking, not by demanding a Store ID up front.
      The shop names are the thing that must not leak, so nothing is named
      until the credential has matched.
    */
    const shared = '+22243210987';
    const ownerA = user(COMPANY_A, 'owner', { phone: shared });
    const ownerB = user(COMPANY_B, 'manager', { phone: shared });
    const { service } = makeService({
      companies: {
        [STORE_A]: { id: COMPANY_A, isActive: true, publicStoreId: STORE_A },
        [STORE_B]: { id: COMPANY_B, isActive: true, publicStoreId: STORE_B },
      },
      users: [ownerA, ownerB],
    });

    const result = await service.login({ identifier: shared, password: 'pw' } as never, {});

    expect('status' in result && result.status).toBe('choose_account');
    if (!('status' in result)) throw new Error('expected a chooser');
    expect(result.accounts).toHaveLength(2);
    // Purpose-bound and short-lived: it names shops, so it must not linger.
    expect(result.continuationToken).toBeTruthy();
    expect(result.expiresIn).toBeLessThanOrEqual(300);
  });

  it('and names no shop at all when the password is wrong', async () => {
    const shared = '+22243210987';
    const { service } = makeService({
      verifyPassword: false,
      companies: {
        [STORE_A]: { id: COMPANY_A, isActive: true, publicStoreId: STORE_A },
        [STORE_B]: { id: COMPANY_B, isActive: true, publicStoreId: STORE_B },
      },
      users: [user(COMPANY_A, 'owner', { phone: shared }), user(COMPANY_B, 'manager', { phone: shared })],
    });

    await expect(
      service.login({ identifier: shared, password: 'wrong' } as never, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a deactivated user is never even a candidate', async () => {
    const { service } = makeService({
      users: [user(COMPANY_A, 'owner', { isActive: false })],
    });
    await expect(doLogin(service)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an inactive company cannot authenticate', async () => {
    const { service } = makeService({
      companies: { [STORE_A]: { id: COMPANY_A, isActive: false, publicStoreId: STORE_A } },
      users: [user(COMPANY_A, 'owner')],
    });
    // Refused with the same generic message: whether a business exists is not
    // something an unauthenticated caller may learn.
    await expect(doLogin(service)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('non-enumerating + timing-safe primary auth', () => {
  async function failure(over: Record<string, unknown>) {
    const ctx = makeService();
    let thrown: any;
    try {
      await doLogin(ctx.service, over);
    } catch (e) {
      thrown = e;
    }
    return { thrown, ctx };
  }

  it('an unknown identifier and a bad password throw the same generic error', async () => {
    const messages = new Set<string>();
    const codes = new Set<unknown>();

    // An unrecognised string and a well-formed identifier nobody holds.
    for (const over of [{ identifier: 'not-an-identifier' }, { identifier: 'U-ZZZZZZZZ' }]) {
      const { thrown } = await failure(over);
      expect(thrown).toBeInstanceOf(UnauthorizedException);
      messages.add((thrown.getResponse() as any).message ?? thrown.message);
      codes.add((thrown.getResponse() as any).code);
    }
    // Bad password (user found, verify returns false).
    const wrongPw = makeService({ verifyPassword: false });
    let pwThrown: any;
    try {
      await doLogin(wrongPw.service, { password: 'wrong' });
    } catch (e) {
      pwThrown = e;
    }
    expect(pwThrown).toBeInstanceOf(UnauthorizedException);
    messages.add((pwThrown.getResponse() as any).message ?? pwThrown.message);
    codes.add((pwThrown.getResponse() as any).code);

    expect(messages.size).toBe(1); // one indistinguishable message
    expect([...codes]).toEqual([undefined]); // no machine code exposes which field failed
  });

  it('spends an Argon2 verify even when nobody matched (timing)', async () => {
    /*
      Without this, "no such person" returns immediately while "wrong
      password" takes an Argon2 verify — and the difference is measurable
      enough to enumerate who exists.
    */
    const unrecognised = await failure({ identifier: 'not-an-identifier' });
    expect(unrecognised.ctx.hashing.verifyDummy).toHaveBeenCalled();

    const nobodyHoldsIt = await failure({ identifier: 'U-ZZZZZZZZ' });
    expect(nobodyHoldsIt.ctx.hashing.verifyDummy).toHaveBeenCalled();
  });

  it('never looks at the device credential when the password is wrong', async () => {
    const { service, devices, sessions } = makeService({ verifyPassword: false });
    await expect(
      doLogin(service, { deviceCredential: { ...meta, deviceId: 'known', deviceSecret: 'right' } }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(devices.recognise).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

// ─────────────────── Stage 3.1: the device decision tree (A–E) ───────────────

describe('device — case A: no credential', () => {
  it('enrolls (password-era) with metadata only, returning the secret once', async () => {
    const { service, devices, sessions } = makeService();
    const res = await doLogin(service, { deviceCredential: { ...meta } });
    expect(devices.recognise).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(devices.enroll).toHaveBeenCalledWith(expect.objectContaining({ trustMethod: 'password' }));
    expect(res.device).toMatchObject({ deviceSecret: 'ISSUED-SECRET' });
  });
});

describe('device — case B: valid pair', () => {
  it('recognises and attaches, enrolling nothing', async () => {
    const knownId = newUuidV7Bin();
    const { service, devices } = makeService({ recognise: { id: knownId, reverifyRequired: false } });
    const res = await doLogin(service, { deviceCredential: { ...meta, deviceId: 'known', deviceSecret: 'right' } });
    expect(devices.attach).toHaveBeenCalledWith(expect.any(Buffer), knownId);
    expect(devices.enroll).not.toHaveBeenCalled();
    expect(res.device).toBeUndefined();
  });
});

describe('device — cases C/D/E: a failed claim fails CLOSED', () => {
  async function failClosed(deviceCredential: Record<string, unknown>) {
    const { service, devices, sessions, usersSvc } = makeService({ recognise: null });
    let thrown: any;
    try {
      await doLogin(service, { deviceCredential });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect(devices.enroll).not.toHaveBeenCalled();
    expect(devices.attach).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(usersSvc.setLastLogin).not.toHaveBeenCalled();
    return thrown;
  }

  it('C — known id, wrong secret: controlled device error, nothing created', async () => {
    const err = await failClosed({ ...meta, deviceId: 'known', deviceSecret: 'WRONG' });
    const res = err.getResponse();
    expect(res.code).toBe('device_unrecognized');
    expect(JSON.stringify(res)).not.toContain('WRONG');
  });

  it('D — unknown id with a secret: fails closed', async () => {
    await failClosed({ ...meta, deviceId: 'unknown', deviceSecret: 'stale' });
  });

  it('E — revoked id with its credential: fails closed', async () => {
    await failClosed({ ...meta, deviceId: 'revoked', deviceSecret: 'oldbutright' });
  });

  it('a half-supplied pair fails closed without calling recognise', async () => {
    const { service, devices, sessions } = makeService({ recognise: null });
    await expect(doLogin(service, { deviceCredential: { deviceId: 'known' } })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(devices.recognise).not.toHaveBeenCalled();
    expect(devices.enroll).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

describe('repeated invalid device claims cannot grow the device table', () => {
  it('20 rejected claims create zero devices and zero sessions', async () => {
    const { service, devices, sessions } = makeService({ recognise: null });
    for (let i = 0; i < 20; i++) {
      await expect(
        doLogin(service, { deviceCredential: { deviceId: `id-${i}`, deviceSecret: `guess-${i}` } }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(devices.enroll).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });
});
