import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * The login device-recognition decision tree (F1 Stage 3.1).
 *
 * The rule this pins: a device CREDENTIAL CLAIM must be a valid, complete,
 * recognised pair, or login fails CLOSED — no session, no device, no token, no
 * secret. Only the genuine ABSENCE of a credential enrolls. This is what stops a
 * wrong/unknown/revoked claim from minting a trusted device, and stops repeated
 * bad claims from growing the device table without bound.
 */

const USER_ID = newUuidV7Bin();
const COMPANY_ID = newUuidV7Bin();

function makeService(opts: { recognise?: unknown; verifyPassword?: boolean } = {}) {
  const sessionId = newUuidV7Bin();
  const user = {
    id: USER_ID,
    companyId: COMPANY_ID,
    name: 'Owner',
    login: 'owner',
    passwordHash: '$argon2id$SECRET-HASH',
    isActive: true,
  };

  const users = {
    findByLoginForAuth: jest.fn(async () => user),
    setLastLogin: jest.fn(async () => undefined),
    findById: jest.fn(async () => user),
  };
  const hashing = { verify: jest.fn(async () => opts.verifyPassword ?? true) };
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

  const service = new AuthService(
    users as never,
    hashing as never,
    tokens as never,
    sessions as never,
    devices as never,
  );
  return { service, users, hashing, tokens, sessions, devices, sessionId };
}

const meta = { label: 'Test phone', platform: 'android' };

describe('login — case A: no device credential', () => {
  it('enrolls (password-era) when only metadata is sent, and returns the secret once', async () => {
    const { service, devices, sessions } = makeService();

    const res = await service.login({ login: 'owner', password: 'pw', deviceCredential: { ...meta } } as never, {});

    expect(devices.recognise).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(devices.enroll).toHaveBeenCalledTimes(1);
    expect(devices.enroll).toHaveBeenCalledWith(expect.objectContaining({ trustMethod: 'password' }));
    expect(res.device).toMatchObject({ deviceSecret: 'ISSUED-SECRET' });
  });

  it('enrolls nothing for an old client that sends no deviceCredential at all', async () => {
    const { service, devices, sessions } = makeService();

    const res = await service.login({ login: 'owner', password: 'pw' } as never, {});

    expect(devices.enroll).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(res.device).toBeUndefined();
  });
});

describe('login — case B: valid pair', () => {
  it('recognises and attaches the existing device, enrolling nothing', async () => {
    const knownId = newUuidV7Bin();
    const { service, devices, sessions } = makeService({ recognise: { id: knownId, reverifyRequired: false } });

    const res = await service.login(
      { login: 'owner', password: 'pw', deviceCredential: { ...meta, deviceId: 'known', deviceSecret: 'right' } } as never,
      {},
    );

    expect(devices.attach).toHaveBeenCalledWith(expect.any(Buffer), knownId);
    expect(devices.enroll).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(res.device).toBeUndefined(); // no secret on a recognised login
  });
});

describe('login — cases C/D/E: a failed credential claim fails CLOSED', () => {
  async function expectFailClosed(deviceCredential: Record<string, unknown>) {
    const { service, devices, sessions, users } = makeService({ recognise: null });
    let thrown: unknown;
    try {
      await service.login({ login: 'owner', password: 'pw', deviceCredential } as never, {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    // Nothing was created: no device, no session, no lastLogin bump.
    expect(devices.enroll).not.toHaveBeenCalled();
    expect(devices.attach).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(users.setLastLogin).not.toHaveBeenCalled();
    return thrown as UnauthorizedException;
  }

  it('C — known id with a wrong secret: no new device, controlled error', async () => {
    const err = await expectFailClosed({ ...meta, deviceId: 'known', deviceSecret: 'WRONG' });
    const res = err.getResponse() as { code?: string };
    expect(res.code).toBe('device_unrecognized');
    // The error never echoes the submitted secret.
    expect(JSON.stringify(res)).not.toContain('WRONG');
  });

  it('D — unknown id with a supplied secret: treated as an invalid claim, not enrolled', async () => {
    await expectFailClosed({ ...meta, deviceId: 'unknown', deviceSecret: 'stale' });
  });

  it('E — revoked id with its credential: stays out, no new trusted device', async () => {
    // recognise() returns null for a revoked device; login must fail closed.
    await expectFailClosed({ ...meta, deviceId: 'revoked', deviceSecret: 'oldbutright' });
  });

  it('a half-supplied pair (id only) is a claim too, and fails closed without calling recognise', async () => {
    const { service, devices, sessions } = makeService({ recognise: null });
    await expect(
      service.login({ login: 'owner', password: 'pw', deviceCredential: { deviceId: 'known' } } as never, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(devices.recognise).not.toHaveBeenCalled(); // never had both halves
    expect(devices.enroll).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('a half-supplied pair (secret only) fails closed too', async () => {
    const { service, devices } = makeService({ recognise: null });
    await expect(
      service.login({ login: 'owner', password: 'pw', deviceCredential: { deviceSecret: 'orphan' } } as never, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(devices.enroll).not.toHaveBeenCalled();
  });
});

describe('repeated invalid claims cannot grow the device table', () => {
  it('20 rejected claims create zero devices and zero sessions', async () => {
    const { service, devices, sessions } = makeService({ recognise: null });

    for (let i = 0; i < 20; i++) {
      await expect(
        service.login(
          { login: 'owner', password: 'pw', deviceCredential: { deviceId: `id-${i}`, deviceSecret: `guess-${i}` } } as never,
          {},
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }

    expect(devices.enroll).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

describe('login — a wrong password still fails first, before any device work', () => {
  it('never reaches recognition or session creation', async () => {
    const { service, devices, sessions } = makeService({ verifyPassword: false });

    await expect(
      service.login(
        { login: 'owner', password: 'bad', deviceCredential: { deviceId: 'known', deviceSecret: 'right' } } as never,
        {},
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(devices.recognise).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });
});
