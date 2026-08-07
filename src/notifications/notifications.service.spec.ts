import { NotificationsService } from './notifications.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * The notification list contract (G2A-CP4.5).
 *
 * Two things matter here and both are about not lying to the recipient: a user
 * sees their own notifications and company broadcasts and nobody else's, and the
 * list is bounded so a busy shop cannot turn the screen into an unbounded fetch.
 */

const ME = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const SOMEONE_ELSE = uuidToBin('018f0000-0000-7000-8000-00000000a002');

interface Row {
  id: Buffer;
  targetUserId: Buffer | null;
  isRead: boolean;
}

function makeService(rows: Row[]) {
  const matches = (r: Row, where: Record<string, unknown>): boolean => {
    const or = where.OR as { targetUserId: Buffer | null }[] | undefined;
    if (or && !or.some((c) => (c.targetUserId === null ? r.targetUserId === null : r.targetUserId?.equals(c.targetUserId)))) {
      return false;
    }
    if ('isRead' in where && r.isRead !== where.isRead) return false;
    return true;
  };

  const db = {
    notification: {
      findMany: async ({ where, cursor, skip, take }: never) => {
        const w = where as unknown as Record<string, unknown>;
        let hits = rows.filter((r) => matches(r, w));
        hits = [...hits].sort((a, b) => Buffer.compare(b.id, a.id)); // id desc
        const c = cursor as unknown as { id: Buffer } | undefined;
        if (c) {
          const at = hits.findIndex((r) => r.id.equals(c.id));
          hits = hits.slice(at + (skip ? Number(skip) : 0));
        }
        return hits.slice(0, take as unknown as number);
      },
      count: async ({ where }: never) =>
        rows.filter((r) => matches(r, where as unknown as Record<string, unknown>)).length,
      updateMany: async ({ where, data }: never) => {
        const w = where as unknown as { id: Buffer; OR: { targetUserId: Buffer | null }[] };
        const hits = rows.filter((r) => r.id.equals(w.id) && matches(r, w as unknown as Record<string, unknown>));
        for (const r of hits) Object.assign(r, data);
        return { count: hits.length };
      },
    },
  };
  return new NotificationsService([] as never, db as never);
}

const row = (targetUserId: Buffer | null, isRead = false): Row => ({
  id: newUuidV7Bin(),
  targetUserId,
  isRead,
});

describe('listing notifications', () => {
  it('returns the user’s own and company broadcasts', async () => {
    const mine = row(ME);
    const broadcast = row(null);
    const theirs = row(SOMEONE_ELSE);
    const service = makeService([mine, broadcast, theirs]);

    const page = await service.listForUser(ME);
    const ids = page.rows.map((r) => binToUuid(r.id));
    expect(ids).toContain(binToUuid(mine.id));
    expect(ids).toContain(binToUuid(broadcast.id));
    expect(ids).not.toContain(binToUuid(theirs.id));
  });

  it('never shows another user’s notification, even one-to-one', async () => {
    const service = makeService([row(SOMEONE_ELSE), row(SOMEONE_ELSE)]);
    await expect(service.listForUser(ME)).resolves.toMatchObject({ rows: [] });
  });

  it('is bounded even when the caller asks for more', async () => {
    const service = makeService(Array.from({ length: 200 }, () => row(ME)));
    const page = await service.listForUser(ME, { limit: 5000 });
    expect(page.rows.length).toBeLessThanOrEqual(50);
  });

  it('applies a sane default page size', async () => {
    const service = makeService(Array.from({ length: 100 }, () => row(ME)));
    const page = await service.listForUser(ME);
    expect(page.rows).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
  });

  it('stops offering a cursor on the last page', async () => {
    const service = makeService([row(ME), row(ME)]);
    const page = await service.listForUser(ME, { limit: 25 });
    expect(page.nextCursor).toBeNull();
  });

  it('filters to unread when asked, and always reports the unread count', async () => {
    const service = makeService([row(ME, false), row(ME, true), row(null, false)]);
    const unread = await service.listForUser(ME, { onlyUnread: true });
    expect(unread.rows.every((r) => !r.isRead)).toBe(true);
    expect(unread.unreadCount).toBe(2);

    const all = await service.listForUser(ME);
    expect(all.rows).toHaveLength(3);
    expect(all.unreadCount).toBe(2);
  });
});

describe('marking read', () => {
  it('marks the caller’s own notification', async () => {
    const mine = row(ME);
    const service = makeService([mine]);
    await expect(service.markRead(ME, mine.id)).resolves.toEqual({ updated: 1 });
    expect(mine.isRead).toBe(true);
  });

  it('cannot mark someone else’s as read', async () => {
    const theirs = row(SOMEONE_ELSE);
    const service = makeService([theirs]);
    await expect(service.markRead(ME, theirs.id)).resolves.toEqual({ updated: 0 });
    expect(theirs.isRead).toBe(false);
  });
});
