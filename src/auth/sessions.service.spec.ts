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
