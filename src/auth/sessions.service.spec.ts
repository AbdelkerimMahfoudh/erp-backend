import { FakePrisma } from '../account/testing/fake-prisma';
import { SessionsService } from './sessions.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * `isAccessValid` is the per-request gate behind every authenticated route
 * (F1.1). It must reject a revoked or expired session, a session whose user was
 * deactivated or deleted, and a session that does not belong to the caller.
 */
const USER = newUuidV7Bin();
const SID = newUuidV7Bin();
const future = () => new Date(Date.now() + 3_600_000);
const past = () => new Date(Date.now() - 1_000);

function makeService(sessionRow: any) {
  const prisma = { authSession: { findUnique: jest.fn(async () => sessionRow) } };
  return new SessionsService(prisma as never, {} as never, {} as never);
}

const validRow = (over: any = {}) => ({
  id: SID,
  userId: USER,
  revokedAt: null,
  expiresAt: future(),
  user: { isActive: true, deletedAt: null },
  ...over,
});

describe('SessionsService.isAccessValid', () => {
  it('accepts a live session for an active user who owns it', async () => {
    const svc = makeService(validRow());
    expect(await svc.isAccessValid(SID, binToUuid(USER))).toBe(true);
  });

  it('rejects a missing session', async () => {
    const svc = makeService(null);
    expect(await svc.isAccessValid(SID, binToUuid(USER))).toBe(false);
  });

  it('rejects a revoked session (this is how deactivation cuts the token off)', async () => {
    const svc = makeService(validRow({ revokedAt: new Date() }));
    expect(await svc.isAccessValid(SID, binToUuid(USER))).toBe(false);
  });

  it('rejects an expired session', async () => {
    const svc = makeService(validRow({ expiresAt: past() }));
    expect(await svc.isAccessValid(SID, binToUuid(USER))).toBe(false);
  });

  it('rejects a session whose user is deactivated', async () => {
    const svc = makeService(validRow({ user: { isActive: false, deletedAt: null } }));
    expect(await svc.isAccessValid(SID, binToUuid(USER))).toBe(false);
  });

  it('rejects a session whose user is soft-deleted', async () => {
    const svc = makeService(validRow({ user: { isActive: true, deletedAt: new Date() } }));
    expect(await svc.isAccessValid(SID, binToUuid(USER))).toBe(false);
  });

  it('rejects a session that belongs to a different user', async () => {
    const svc = makeService(validRow({ userId: newUuidV7Bin() }));
    expect(await svc.isAccessValid(SID, binToUuid(USER))).toBe(false);
  });
});

/**
 * `rotate` is the refresh token's one-time use (docs/15 §5): a token rotates once, and a token that is no longer the
 * current one is reuse and revokes the session — under concurrency too (BE2-02).
 */
describe('SessionsService.rotate', () => {
  function rotating() {
    const prisma = new FakePrisma();
    // Argon2 takes real time: the verify yields, so concurrent refreshes all read the row before any writes it.
    const hashing = {
      hash: async (s: string) => `h:${s}`,
      verify: async (h: string, s: string) => (await new Promise((r) => setTimeout(r, 5)), h === `h:${s}`),
    };
    prisma.seed('authSession', { id: SID, userId: USER, companyId: USER, refreshTokenHash: 'h:first', revokedAt: null, expiresAt: future() });
    const svc = new SessionsService(prisma as never, hashing as never, {} as never);
    const row = () => prisma.rows('authSession')[0];
    return { svc, row };
  }

  it('rotates once; the old token presented again is reuse and revokes the session', async () => {
    const { svc, row } = rotating();
    await expect(svc.rotate(SID, 'first', 'second')).resolves.toMatchObject({ userId: USER });
    expect(row()).toMatchObject({ refreshTokenHash: 'h:second', revokedAt: null });
    await expect(svc.rotate(SID, 'first', 'third')).resolves.toBeNull();
    expect(row().revokedAt).toBeInstanceOf(Date);
  });

  it('ten refreshes with the same token at once: one rotates, the rest are reuse, and the session is revoked', async () => {
    const { svc, row } = rotating();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => svc.rotate(SID, 'first', `next-${i}`)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(row().revokedAt).toBeInstanceOf(Date);
  });
});
