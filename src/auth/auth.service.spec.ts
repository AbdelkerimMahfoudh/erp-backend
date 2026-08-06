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
  passwordHash: string;
  isActive: boolean;
  deletedAt: Date | null;
}

function user(companyId: Buffer, login: string, over: Partial<FakeUser> = {}): FakeUser {
  return {
    id: newUuidV7Bin(),
    companyId,
    name: login,
    login,
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
  };
  const sessions = { create: jest.fn(async () => sessionId) };
  const devices = {
    recognise: jest.fn(async () => (opts.recognise === undefined ? null : opts.recognise)),
    attach: jest.fn(async () => undefined),
    enroll: jest.fn(async () => ({ deviceId: 'new-device-id', deviceSecret: 'ISSUED-SECRET', trustMethod: 'password' })),
  };
  const prisma = {
    company: {
      findUnique: jest.fn(async ({ where }: any) => companies[where.publicStoreId] ?? null),
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
const doLogin = (service: AuthService, over: Record<string, unknown> = {}) =>
  service.login({ storeAccountId: STORE_A, login: 'owner', password: 'pw', ...over } as never, {});

// ─────────────────────────── Stage 3.2: tenant resolution ───────────────────

describe('tenant resolution by Store Account ID', () => {
  it('resolves the company from the public Store ID and authenticates its user', async () => {
    const { service, prisma, tokens, usersSvc } = makeService();

    const res = await doLogin(service);

    expect(prisma.company.findUnique).toHaveBeenCalledWith({
      where: { publicStoreId: STORE_A },
      select: { id: true, isActive: true, publicStoreId: true },
    });
    expect(res.user.publicStoreId).toBe(STORE_A);
    // The user was looked up WITHIN the resolved company.
    expect(usersSvc.findByLoginForAuth).toHaveBeenCalledWith(COMPANY_A, 'owner');
    expect(res.user.companyId).toBeDefined();
    // JWT identity comes from the resolved company, not from any client field.
    expect(tokens.signAccessToken).toHaveBeenCalled();
  });

  it('normalizes the Store ID (case, dashes, O/I/L) before resolving', async () => {
    const { service, prisma } = makeService();
    await doLogin(service, { storeAccountId: ' abcde-12345 ' });
    expect(prisma.company.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicStoreId: STORE_A } }),
    );
  });

  it('the SAME login in two companies is disambiguated by the Store ID', async () => {
    const ownerA = user(COMPANY_A, 'owner');
    const ownerB = user(COMPANY_B, 'owner');
    const setup = {
      companies: {
        [STORE_A]: { id: COMPANY_A, isActive: true, publicStoreId: STORE_A },
        [STORE_B]: { id: COMPANY_B, isActive: true, publicStoreId: STORE_B },
      },
      users: [ownerA, ownerB],
    };

    const a = makeService(setup);
    await a.service.login({ storeAccountId: STORE_A, login: 'owner', password: 'pw' } as never, {});
    expect(a.usersSvc.findByLoginForAuth).toHaveBeenCalledWith(COMPANY_A, 'owner');

    const b = makeService(setup);
    await b.service.login({ storeAccountId: STORE_B, login: 'owner', password: 'pw' } as never, {});
    expect(b.usersSvc.findByLoginForAuth).toHaveBeenCalledWith(COMPANY_B, 'owner');
  });

  it('Store ID of company A + a login that exists only in company B is rejected', async () => {
    const { service } = makeService({
      companies: { [STORE_A]: { id: COMPANY_A, isActive: true, publicStoreId: STORE_A } },
      users: [user(COMPANY_B, 'owner')], // owner exists, but in a DIFFERENT company
    });
    await expect(doLogin(service)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an inactive company cannot authenticate', async () => {
    const { service, usersSvc } = makeService({
      companies: { [STORE_A]: { id: COMPANY_A, isActive: false, publicStoreId: STORE_A } },
      users: [user(COMPANY_A, 'owner')],
    });
    await expect(doLogin(service)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersSvc.findByLoginForAuth).not.toHaveBeenCalled(); // never looked past a dead tenant
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

  it('a bad Store ID, a bad login and a bad password all throw the same generic error', async () => {
    const messages = new Set<string>();
    const codes = new Set<unknown>();

    // Bad Store ID and bad login (miss the user), gathered via the shared harness.
    for (const over of [{ storeAccountId: '99999AAAAA' }, { login: 'ghost' }]) {
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

  it('spends an Argon2 verify even when the company or user is missing (timing)', async () => {
    const noStore = await failure({ storeAccountId: '99999AAAAA' });
    expect(noStore.ctx.hashing.verifyDummy).toHaveBeenCalled();

    const noUser = await failure({ login: 'ghost' });
    expect(noUser.ctx.hashing.verifyDummy).toHaveBeenCalled();
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
