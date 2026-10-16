import { NotificationsService } from './notifications.service';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * A broadcast about a branch reaches the people of that branch only.
 *
 * `sale.recorded` (invoice and total), `closing.completed` and `debt.charged`
 * are written with no target user and the branch they are about. The list
 * scoped to `targetUserId = me OR targetUserId IS NULL` and never read the
 * branch, so a Store Manager assigned to one branch read the other branch's
 * sales as they happened (found live). A broadcast with no branch — stock
 * received, a partner's proposal — stays company-wide.
 */

const ME = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const MINE = uuidToBin('018f0000-0000-7000-8000-0000000000b1');
const THEIRS = uuidToBin('018f0000-0000-7000-8000-0000000000b2');

interface Row {
  id: Buffer;
  targetUserId: Buffer | null;
  branchId: Buffer | null;
  isRead: boolean;
  title: string;
}

const eq = (a: Buffer | null, b: unknown) => (b === null ? a === null : a !== null && Buffer.isBuffer(b) && a.equals(b));

/** Evaluates the where shapes the service builds: equality, `in`, nested OR. */
function matches(r: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((c) => matches(r, c));
    if (key === 'isRead') return r.isRead === cond;
    const value = (r as unknown as Record<string, Buffer | null>)[key];
    if (cond && typeof cond === 'object' && !Buffer.isBuffer(cond) && 'in' in cond) {
      return (cond as { in: Buffer[] }).in.some((b) => eq(value, b));
    }
    return eq(value, cond);
  });
}

function makeService(rows: Row[]) {
  const db = {
    userBranch: {
      findMany: async ({ where }: any) => (where.userId.equals(ME) ? [{ branchId: MINE }] : []),
    },
    notification: {
      findMany: async ({ where, take }: any) =>
        rows.filter((r) => matches(r, where)).sort((a, b) => Buffer.compare(b.id, a.id)).slice(0, take),
      count: async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
      updateMany: async ({ where, data }: any) => {
        const hits = rows.filter((r) => matches(r, where));
        for (const r of hits) Object.assign(r, data);
        return { count: hits.length };
      },
    },
  };
  return new NotificationsService([] as never, db as never);
}

const row = (branchId: Buffer | null, title: string, targetUserId: Buffer | null = null): Row => ({
  id: newUuidV7Bin(),
  targetUserId,
  branchId,
  isRead: false,
  title,
});

describe('branch broadcasts stay in their branch', () => {
  const own = row(MINE, 'Sale 00007 — 900');
  const other = row(THEIRS, 'Sale 00001 — 17500');
  const companyWide = row(null, 'Received 6 item(s)');
  const addressedToMe = row(THEIRS, 'Transfer arrived', ME);

  it('lists my branch’s broadcasts, company-wide ones and my own — not another branch’s', async () => {
    const service = makeService([own, other, companyWide, addressedToMe]);

    const page = await service.listForUser(ME);

    expect(page.rows.map((r) => r.title).sort()).toEqual(
      ['Received 6 item(s)', 'Sale 00007 — 900', 'Transfer arrived'].sort(),
    );
    expect(page.unreadCount).toBe(3);
  });

  it('cannot mark another branch’s broadcast as read', async () => {
    const theirs = row(THEIRS, 'Day closed');
    const service = makeService([theirs]);

    await expect(service.markRead(ME, theirs.id)).resolves.toEqual({ updated: 0 });
    expect(theirs.isRead).toBe(false);
  });
});
