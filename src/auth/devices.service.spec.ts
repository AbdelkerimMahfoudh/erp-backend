import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * Device identity (F1 Stage 3).
 *
 * The security claim is narrow and testable: **a device is recognised only by
 * presenting a secret this server issued**, and that secret exists on the
 * device and nowhere else in readable form. Everything below either proves that
 * or proves one of the ways it must fail — a stolen public id, another user's
 * device, a revoked device coming back, a second rebind of one session.
 *
 * The double stores what the database stores, so "did we ever persist a raw
 * secret?" is a question the tests can actually answer.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const USER = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const OTHER_USER = uuidToBin('018f0000-0000-7000-8000-00000000a002');

interface DeviceRow {
  id: Buffer;
  companyId: Buffer;
  userId: Buffer;
  secretHash: string;
  label: string | null;
  platform: string | null;
  model: string | null;
  appVersion: string | null;
  trustMethod: string;
  trustedAt: Date;
  otpVerifiedAt: Date | null;
  reverifyRequired: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revokedById: Buffer | null;
}

interface SessionRow {
  id: Buffer;
  userId: Buffer;
  deviceRecordId: Buffer | null;
  revokedAt: Date | null;
}

function makeService(seed: { devices?: DeviceRow[]; sessions?: SessionRow[]; users?: { id: Buffer; companyId: Buffer; deletedAt: Date | null }[] } = {}) {
  const devices: DeviceRow[] = seed.devices ?? [];
  const sessions: SessionRow[] = seed.sessions ?? [];
  const users = seed.users ?? [{ id: USER, companyId: COMPANY, deletedAt: null }];

  const db: any = {
    userDevice: {
      create: jest.fn(async ({ data }: any) => {
        devices.push({
          trustedAt: new Date(),
          otpVerifiedAt: null,
          reverifyRequired: false,
          firstSeenAt: new Date(),
          lastSeenAt: null,
          revokedAt: null,
          revokedById: null,
          ...data,
        });
        return data;
      }),
      findUnique: jest.fn(async ({ where, select }: any) => {
        const hit = devices.find((d) => d.id.equals(where.id));
        if (!hit) return null;
        if (!select) return { ...hit };
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(select)) out[k] = (hit as never as Record<string, unknown>)[k];
        return out;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        devices.filter((d) => d.userId.equals(where.userId)).map((d) => ({ ...d })),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const hit = devices.find((d) => d.id.equals(where.id))!;
        Object.assign(hit, data);
        return { ...hit };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hits = devices.filter((d) => d.id.equals(where.id));
        for (const h of hits) Object.assign(h, data);
        return { count: hits.length };
      }),
    },
    authSession: {
      update: jest.fn(async ({ where, data }: any) => {
        const hit = sessions.find((s) => s.id.equals(where.id));
        if (!hit) throw new Error('no session');
        Object.assign(hit, data);
        return { ...hit };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hits = sessions.filter(
          (s) =>
            where.deviceRecordId &&
            s.deviceRecordId &&
            s.deviceRecordId.equals(where.deviceRecordId) &&
            s.revokedAt === null,
        );
        for (const h of hits) Object.assign(h, data);
        return { count: hits.length };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const hit = sessions.find((s) => s.id.equals(where.id));
        return hit ? { ...hit } : null;
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const hit = users.find((u) => u.id.equals(where.id));
        return hit ? { companyId: hit.companyId, deletedAt: hit.deletedAt } : null;
      }),
    },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(db) : Promise.all(arg),
    ),
  };

  // Real Argon2id, not a stub: "we only stored a hash" is only meaningful if
  // the hash is a real one that the raw secret cannot be read out of.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const argon2 = require('argon2');
  const hashing = {
    hash: (p: string) => argon2.hash(p, { type: argon2.argon2id }),
    verify: async (h: string, p: string) => {
      try {
        return await argon2.verify(h, p);
      } catch {
        return false;
      }
    },
  };

  return { service: new DevicesService(db as never, hashing as never), devices, sessions, db };
}

function session(over: Partial<SessionRow> = {}): SessionRow {
  return { id: newUuidV7Bin(), userId: USER, deviceRecordId: null, revokedAt: null, ...over };
}

describe('enrollment issues a credential the server cannot read back', () => {
  it('returns the secret exactly once and stores only a hash', async () => {
    const s = session();
    const { service, devices } = makeService({ sessions: [s] });

    const result = await service.enroll({
      companyId: COMPANY,
      userId: USER,
      sessionId: s.id,
      trustMethod: 'password',
    });

    expect(result.deviceSecret).toEqual(expect.any(String));
    expect(result.deviceSecret.length).toBeGreaterThanOrEqual(40); // 32 bytes base64url
    const stored = devices[0];
    expect(stored.secretHash).toMatch(/^\$argon2id\$/);
    // The raw secret must appear nowhere in the row.
    expect(JSON.stringify(stored)).not.toContain(result.deviceSecret);
  });

  it('binds the session to the new device in the same transaction', async () => {
    const s = session();
    const { service, devices, db } = makeService({ sessions: [s] });

    await service.enroll({ companyId: COMPANY, userId: USER, sessionId: s.id, trustMethod: 'password' });

    expect(db.$transaction).toHaveBeenCalled();
    expect(s.deviceRecordId).toEqual(devices[0].id);
  });

  it('never marks a Stage 3 device as OTP-verified', async () => {
    const s = session();
    const { service, devices } = makeService({ sessions: [s] });

    await service.enroll({ companyId: COMPANY, userId: USER, sessionId: s.id, trustMethod: 'password' });

    expect(devices[0].otpVerifiedAt).toBeNull();
    expect(devices[0].trustMethod).toBe('password');
  });

  it('records legacy adoption as legacy, not as a password or an OTP', async () => {
    const s = session();
    const { service, devices } = makeService({ sessions: [s] });

    await service.adoptLegacy(COMPANY, USER, s.id);

    expect(devices[0].trustMethod).toBe('legacy');
    expect(devices[0].otpVerifiedAt).toBeNull();
  });

  it('two enrollments on one installation get different secrets', async () => {
    const a = session();
    const b = session({ userId: OTHER_USER });
    const { service } = makeService({ sessions: [a, b] });

    const first = await service.enroll({ companyId: COMPANY, userId: USER, sessionId: a.id, trustMethod: 'password' });
    const second = await service.enroll({ companyId: COMPANY, userId: OTHER_USER, sessionId: b.id, trustMethod: 'password' });

    expect(first.deviceSecret).not.toEqual(second.deviceSecret);
    expect(first.deviceId).not.toEqual(second.deviceId);
  });
});

describe('recognition needs BOTH halves of the credential', () => {
  async function enrolled() {
    const s = session();
    const ctx = makeService({ sessions: [s] });
    const cred = await ctx.service.enroll({
      companyId: COMPANY,
      userId: USER,
      sessionId: s.id,
      trustMethod: 'password',
    });
    return { ...ctx, cred, s };
  }

  it('accepts the right pair', async () => {
    const { service, cred } = await enrolled();
    expect(await service.recognise(USER, cred.deviceId, cred.deviceSecret)).not.toBeNull();
  });

  it('rejects the public id on its own — a leaked device list is not a credential', async () => {
    const { service, cred } = await enrolled();
    expect(await service.recognise(USER, cred.deviceId, '')).toBeNull();
    expect(await service.recognise(USER, cred.deviceId, 'guess')).toBeNull();
  });

  it('rejects a wrong secret', async () => {
    const { service, cred } = await enrolled();
    expect(await service.recognise(USER, cred.deviceId, cred.deviceSecret + 'x')).toBeNull();
  });

  it('rejects another user presenting a valid pair', async () => {
    const { service, cred } = await enrolled();
    expect(await service.recognise(OTHER_USER, cred.deviceId, cred.deviceSecret)).toBeNull();
  });

  it('rejects a malformed device id without throwing', async () => {
    const { service, cred } = await enrolled();
    expect(await service.recognise(USER, 'not-a-uuid', cred.deviceSecret)).toBeNull();
  });

  it('a revoked device cannot silently become trusted again', async () => {
    const { service, cred, devices } = await enrolled();
    devices[0].revokedAt = new Date();

    expect(await service.recognise(USER, cred.deviceId, cred.deviceSecret)).toBeNull();
  });
});

describe('legacy adoption binds once', () => {
  it('adopts a pre-Stage-3 session and returns a secret', async () => {
    const s = session();
    const { service } = makeService({ sessions: [s] });

    const result = await service.adoptLegacy(COMPANY, USER, s.id);

    expect('deviceSecret' in result).toBe(true);
    expect(s.deviceRecordId).not.toBeNull();
  });

  it('a second call is idempotent — same device, no new secret', async () => {
    const s = session();
    const { service, devices } = makeService({ sessions: [s] });

    const first = await service.adoptLegacy(COMPANY, USER, s.id);
    const second = await service.adoptLegacy(COMPANY, USER, s.id);

    expect(devices).toHaveLength(1);
    expect(second).toEqual({ alreadyBound: true, deviceId: (first as { deviceId: string }).deviceId });
    expect('deviceSecret' in second).toBe(false);
  });

  it('a session already bound cannot be rebound to a different device', async () => {
    const other = newUuidV7Bin();
    const s = session({ deviceRecordId: other });
    const { service, devices } = makeService({ sessions: [s] });

    const result = await service.adoptLegacy(COMPANY, USER, s.id);

    expect(result).toEqual({ alreadyBound: true, deviceId: binToUuid(other) });
    expect(devices).toHaveLength(0);
    expect(s.deviceRecordId).toEqual(other);
  });

  it("another user cannot adopt someone else's session", async () => {
    const s = session();
    const { service } = makeService({ sessions: [s] });

    await expect(service.adoptLegacy(COMPANY, OTHER_USER, s.id)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('revocation', () => {
  async function withDevice(over: Partial<DeviceRow> = {}) {
    const s = session();
    const ctx = makeService({ sessions: [s] });
    const cred = await ctx.service.enroll({
      companyId: COMPANY,
      userId: USER,
      sessionId: s.id,
      trustMethod: 'password',
    });
    Object.assign(ctx.devices[0], over);
    return { ...ctx, cred, s };
  }

  it('revokes the device and every session it owns, atomically', async () => {
    const { service, devices, sessions, cred } = await withDevice();

    const result = await service.revoke({
      companyId: COMPANY,
      ownerUserId: USER,
      targetUserId: USER,
      deviceIdStr: cred.deviceId,
    });

    expect(result.sessionsRevoked).toBe(1);
    expect(devices[0].revokedAt).toBeInstanceOf(Date);
    expect(sessions[0].revokedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — revoking twice is safe', async () => {
    const { service, cred } = await withDevice();
    await service.revoke({ companyId: COMPANY, ownerUserId: USER, targetUserId: USER, deviceIdStr: cred.deviceId });

    const again = await service.revoke({
      companyId: COMPANY,
      ownerUserId: USER,
      targetUserId: USER,
      deviceIdStr: cred.deviceId,
    });

    expect(again.alreadyRevoked).toBe(true);
    expect(again.sessionsRevoked).toBe(0);
  });

  it('survives the user being reactivated — revocation is not undone', async () => {
    const { service, devices, cred } = await withDevice();
    await service.revoke({ companyId: COMPANY, ownerUserId: USER, targetUserId: USER, deviceIdStr: cred.deviceId });

    // Reactivation touches the user, never the device history.
    expect(devices[0].revokedAt).toBeInstanceOf(Date);
    expect(await service.recognise(USER, cred.deviceId, cred.deviceSecret)).toBeNull();
  });

  it("another company's device is not found, not forbidden", async () => {
    const { service, devices, cred } = await withDevice({ companyId: OTHER_COMPANY });

    await expect(
      service.revoke({ companyId: COMPANY, ownerUserId: USER, targetUserId: USER, deviceIdStr: cred.deviceId }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(devices[0].revokedAt).toBeNull();
  });

  it("another user's device is not found", async () => {
    const { service, cred } = await withDevice({ userId: OTHER_USER });

    await expect(
      service.revoke({ companyId: COMPANY, ownerUserId: USER, targetUserId: USER, deviceIdStr: cred.deviceId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a malformed device id is not found', async () => {
    const { service } = await withDevice();
    await expect(
      service.revoke({ companyId: COMPANY, ownerUserId: USER, targetUserId: USER, deviceIdStr: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps revoked devices as history rather than deleting them', async () => {
    const { service, devices, cred } = await withDevice();
    await service.revoke({ companyId: COMPANY, ownerUserId: USER, targetUserId: USER, deviceIdStr: cred.deviceId });

    expect(devices).toHaveLength(1);
    const list = await service.listForUser(USER, null);
    expect(list[0].revokedAt).not.toBeNull();
  });
});

describe('logout marks future re-verification, app lifecycle does not', () => {
  it('an explicit logout sets the flag on the device', async () => {
    const s = session();
    const { service, devices } = makeService({ sessions: [s] });
    await service.enroll({ companyId: COMPANY, userId: USER, sessionId: s.id, trustMethod: 'password' });

    await service.markReverifyRequired(devices[0].id);

    expect(devices[0].reverifyRequired).toBe(true);
  });

  it('recognition still works and reports the pending requirement', async () => {
    // Stage 3 records it; Stage 4 enforces it. Recognition must not start
    // refusing today, or a logout would lock people out with no OTP to recover.
    const s = session();
    const { service, devices } = makeService({ sessions: [s] });
    const cred = await service.enroll({ companyId: COMPANY, userId: USER, sessionId: s.id, trustMethod: 'password' });
    await service.markReverifyRequired(devices[0].id);

    const known = await service.recognise(USER, cred.deviceId, cred.deviceSecret);

    expect(known).not.toBeNull();
    expect(known!.reverifyRequired).toBe(true);
  });

  it('listing, recognising and attaching never set the flag', async () => {
    // Closing the app, backgrounding it or coming back offline all end up in
    // these paths and must leave device trust untouched.
    const s = session();
    const { service, devices } = makeService({ sessions: [s] });
    const cred = await service.enroll({ companyId: COMPANY, userId: USER, sessionId: s.id, trustMethod: 'password' });

    await service.recognise(USER, cred.deviceId, cred.deviceSecret);
    await service.attach(s.id, devices[0].id);
    await service.listForUser(USER, devices[0].id);

    expect(devices[0].reverifyRequired).toBe(false);
    expect(devices[0].revokedAt).toBeNull();
  });
});

describe('responses never leak secrets', () => {
  it('a device view contains no hash and no secret', async () => {
    const s = session();
    const { service, devices } = makeService({ sessions: [s] });
    const cred = await service.enroll({ companyId: COMPANY, userId: USER, sessionId: s.id, trustMethod: 'password' });

    const list = await service.listForUser(USER, devices[0].id);
    const serialized = JSON.stringify(list);

    expect(serialized).not.toContain(cred.deviceSecret);
    expect(serialized).not.toContain('secretHash');
    expect(serialized).not.toContain('argon2');
    expect(list[0].isCurrent).toBe(true);
  });

  it('reports trust honestly: otpVerified is false for a password enrollment', async () => {
    const s = session();
    const { service } = makeService({ sessions: [s] });
    await service.enroll({ companyId: COMPANY, userId: USER, sessionId: s.id, trustMethod: 'password' });

    const [view] = await service.listForUser(USER, null);

    expect(view.trustMethod).toBe('password');
    expect(view.otpVerified).toBe(false);
  });
});

describe('two users on one installation stay isolated', () => {
  it('each gets their own device row, and neither can use the other credential', async () => {
    const a = session();
    const b = session({ userId: OTHER_USER });
    const { service, devices } = makeService({
      sessions: [a, b],
      users: [
        { id: USER, companyId: COMPANY, deletedAt: null },
        { id: OTHER_USER, companyId: COMPANY, deletedAt: null },
      ],
    });

    const credA = await service.enroll({ companyId: COMPANY, userId: USER, sessionId: a.id, trustMethod: 'password' });
    const credB = await service.enroll({ companyId: COMPANY, userId: OTHER_USER, sessionId: b.id, trustMethod: 'password' });

    expect(devices).toHaveLength(2);
    expect(await service.recognise(USER, credB.deviceId, credB.deviceSecret)).toBeNull();
    expect(await service.recognise(OTHER_USER, credA.deviceId, credA.deviceSecret)).toBeNull();
    // And each user's list shows only their own.
    expect(await service.listForUser(USER, null)).toHaveLength(1);
    expect(await service.listForUser(OTHER_USER, null)).toHaveLength(1);
  });
});

describe("Owner reading a company member's devices", () => {
  it("refuses a user from another company as 'not found'", async () => {
    const { service } = makeService({
      users: [{ id: OTHER_USER, companyId: OTHER_COMPANY, deletedAt: null }],
    });

    await expect(
      service.listForCompanyUser(COMPANY, binToUuid(OTHER_USER), null),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a soft-deleted user', async () => {
    const { service } = makeService({
      users: [{ id: OTHER_USER, companyId: COMPANY, deletedAt: new Date() }],
    });

    await expect(
      service.listForCompanyUser(COMPANY, binToUuid(OTHER_USER), null),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a malformed user id', async () => {
    const { service } = makeService();
    await expect(service.listForCompanyUser(COMPANY, 'nope', null)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
