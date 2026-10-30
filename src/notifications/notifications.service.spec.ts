import { memoryNotifications, type MemoryRow } from './__testing__/memory-notifications';
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

const row = (targetUserId: Buffer | null, isRead = false): MemoryRow => ({
  id: newUuidV7Bin(),
  targetUserId,
  branchId: null,
  isRead,
  type: 'sale.recorded',
  title: 'x',
  readBy: [],
});

const makeService = (rows: MemoryRow[]) => memoryNotifications(rows);

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
    expect(mine.readBy.map((u) => u.equals(ME))).toEqual([true]);
    expect((await service.listForUser(ME)).rows[0].isRead).toBe(true);
  });

  it('cannot mark someone else’s as read', async () => {
    const theirs = row(SOMEONE_ELSE);
    const service = makeService([theirs]);
    await expect(service.markRead(ME, theirs.id)).resolves.toEqual({ updated: 0 });
    expect(theirs.readBy).toEqual([]);
  });
});

describe('read state is per person (D225, 0113)', () => {
  it('one member reading a store broadcast does not read it for another', async () => {
    const broadcast = row(null);
    const service = makeService([broadcast]);
    await service.markRead(ME, broadcast.id);
    expect((await service.listForUser(ME)).unreadCount).toBe(0);
    expect((await service.listForUser(SOMEONE_ELSE)).unreadCount).toBe(1);
  });

  it('marks everything I can see as read, and nothing of anyone else', async () => {
    const mine = row(ME);
    const broadcast = row(null);
    const theirs = row(SOMEONE_ELSE);
    const service = makeService([mine, broadcast, theirs]);
    await expect(service.markAllRead(ME)).resolves.toEqual({ updated: 2 });
    expect((await service.listForUser(ME)).unreadCount).toBe(0);
    expect(theirs.readBy).toEqual([]);
  });

  it('filters the centre by category, from the catalogue', async () => {
    const sale = row(ME);
    const approval = { ...row(ME), type: 'discount_approval.requested' };
    const service = makeService([sale, approval]);
    const page = await service.listForUser(ME, { filter: 'approvals' });
    expect(page.rows.map((r) => r.type)).toEqual(['discount_approval.requested']);
    expect(page.rows[0].category).toBe('approvals');
    expect((await service.listForUser(ME, { filter: 'all' })).rows).toHaveLength(2);
  });
});
