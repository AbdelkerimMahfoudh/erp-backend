import { Prisma } from '@prisma/client';
import { PushDevicesService } from './push-devices.service';

/** One push_devices table in memory: a token is unique across every business, as the 0113 index says. */
function table() {
  const rows: { id: Buffer; token: string; userId: Buffer; companyId: Buffer; locale: string; platform: string; revokedAt: Date | null }[] = [];
  const pushDevice = {
    findUnique: jest.fn(async ({ where }: { where: { token: string } }) => rows.find((r) => r.token === where.token) ?? null),
    create: jest.fn(async ({ data }: { data: (typeof rows)[number] }) => {
      if (rows.some((r) => r.token === data.token)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
      rows.push({ ...data });
      return data;
    }),
    update: jest.fn(async ({ where, data }: { where: { id?: Buffer; token?: string }; data: Partial<(typeof rows)[number]> }) => {
      const row = rows.find((r) => (where.id ? r.id.equals(where.id) : r.token === where.token))!;
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: { token: string; userId: Buffer }; data: { revokedAt: Date } }) => {
      const hit = rows.filter((r) => r.token === where.token && r.userId.equals(where.userId) && r.revokedAt === null);
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  };
  return { rows, prisma: { pushDevice } };
}

const A = Buffer.alloc(16, 1);
const B = Buffer.alloc(16, 2);
const CO1 = Buffer.alloc(16, 9);
const CO2 = Buffer.alloc(16, 8);

describe('PushDevicesService (D225)', () => {
  it('registers once, however often the app calls: the same token is one row whose language follows the latest call', async () => {
    const { rows, prisma } = table();
    const devices = new PushDevicesService(prisma as never);
    const first = await devices.register(A, CO1, { token: 'ExponentPushToken[a]', platform: 'ios', locale: 'en' });
    const again = await devices.register(A, CO1, { token: 'ExponentPushToken[a]', platform: 'ios', locale: 'ar' });
    expect(again.deviceId).toBe(first.deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].locale).toBe('ar');
  });

  it('a person may have several phones, each its own row', async () => {
    const { rows, prisma } = table();
    const devices = new PushDevicesService(prisma as never);
    await devices.register(A, CO1, { token: 'ExponentPushToken[a]', platform: 'ios', locale: 'en' });
    await devices.register(A, CO1, { token: 'ExponentPushToken[b]', platform: 'ios', locale: 'fr' });
    expect(rows.map((r) => r.locale)).toEqual(['en', 'fr']);
  });

  it('a counter phone that changes hands — even to another business — is the newcomer’s, and only theirs', async () => {
    const { rows, prisma } = table();
    const devices = new PushDevicesService(prisma as never);
    await devices.register(A, CO1, { token: 'ExponentPushToken[a]', platform: 'ios', locale: 'en' });
    await devices.revoke(A, 'ExponentPushToken[a]');
    await devices.register(B, CO2, { token: 'ExponentPushToken[a]', platform: 'ios', locale: 'ar' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: B, companyId: CO2, revokedAt: null, locale: 'ar' });
  });

  it('two first registrations at once end as one row, not an error', async () => {
    const { rows, prisma } = table();
    const devices = new PushDevicesService(prisma as never);
    // The lookup misses for both before either writes.
    prisma.pushDevice.findUnique.mockResolvedValue(null as never);
    await Promise.all([
      devices.register(A, CO1, { token: 'ExponentPushToken[a]', platform: 'ios', locale: 'en' }),
      devices.register(A, CO1, { token: 'ExponentPushToken[a]', platform: 'ios', locale: 'en' }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('a rotated token revokes the one it replaces — the caller’s own only', async () => {
    const { rows, prisma } = table();
    const devices = new PushDevicesService(prisma as never);
    await devices.register(A, CO1, { token: 'ExponentPushToken[old]', platform: 'ios', locale: 'en' });
    await devices.register(B, CO1, { token: 'ExponentPushToken[theirs]', platform: 'ios', locale: 'en' });
    await devices.register(A, CO1, { token: 'ExponentPushToken[new]', platform: 'ios', locale: 'en', replaces: 'ExponentPushToken[old]' });
    await devices.register(A, CO1, { token: 'ExponentPushToken[new]', platform: 'ios', locale: 'en', replaces: 'ExponentPushToken[theirs]' });
    expect(rows.find((r) => r.token === 'ExponentPushToken[old]')!.revokedAt).not.toBeNull();
    expect(rows.find((r) => r.token === 'ExponentPushToken[theirs]')!.revokedAt).toBeNull();
    expect(rows.find((r) => r.token === 'ExponentPushToken[new]')!.revokedAt).toBeNull();
  });

  it('signing out revokes this phone for this person; nobody can revoke another person’s phone', async () => {
    const { rows, prisma } = table();
    const devices = new PushDevicesService(prisma as never);
    await devices.register(A, CO1, { token: 'ExponentPushToken[a]', platform: 'ios', locale: 'en' });
    expect(await devices.revoke(B, 'ExponentPushToken[a]')).toEqual({ revoked: 0 });
    expect(await devices.revoke(A, 'ExponentPushToken[a]')).toEqual({ revoked: 1 });
    expect(await devices.revoke(A, 'ExponentPushToken[a]')).toEqual({ revoked: 0 });
    expect(rows[0].revokedAt).not.toBeNull();
  });
});
