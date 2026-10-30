import { NotificationsService } from '../notifications.service';

/**
 * An in-memory `notifications` + `notification_reads` that evaluates the where shapes NotificationsService builds:
 * AND, OR, equality, `in`, `isRead`, `type: { in }` and `reads: { none: { userId } }`. Shared by the specs, so the
 * read rules are evaluated in one place.
 */
export interface MemoryRow {
  id: Buffer;
  targetUserId: Buffer | null;
  branchId: Buffer | null;
  isRead: boolean;
  type: string;
  title: string;
  /** Who has read it (0113). */
  readBy: Buffer[];
}

const eq = (a: Buffer | null, b: unknown) => (b === null ? a === null : a !== null && Buffer.isBuffer(b) && a.equals(b));

export function matches(r: MemoryRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((c) => matches(r, c));
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((c) => matches(r, c));
    if (key === 'isRead') return r.isRead === cond;
    if (key === 'reads') {
      const none = (cond as { none: { userId: Buffer } }).none;
      return !r.readBy.some((u) => u.equals(none.userId));
    }
    if (key === 'type') return (cond as { in: string[] }).in.includes(r.type);
    const value = (r as unknown as Record<string, Buffer | null>)[key];
    if (cond && typeof cond === 'object' && !Buffer.isBuffer(cond) && 'in' in cond) {
      return (cond as { in: Buffer[] }).in.some((b) => eq(value, b));
    }
    return eq(value, cond);
  });
}

export function memoryNotifications(rows: MemoryRow[], assigned: (userId: Buffer) => Buffer[] = () => []) {
  const find = (id: Buffer) => rows.find((r) => r.id.equals(id));
  const db = {
    userBranch: { findMany: async ({ where }: any) => assigned(where.userId).map((branchId) => ({ branchId })) },
    notification: {
      findMany: async ({ where, cursor, skip, take, include }: any) => {
        let hits = rows.filter((r) => matches(r, where)).sort((a, b) => Buffer.compare(b.id, a.id));
        if (cursor) hits = hits.slice(hits.findIndex((r) => r.id.equals(cursor.id)) + (skip ?? 0));
        const reader: Buffer | undefined = include?.reads?.where?.userId;
        return hits.slice(0, take).map((r) => ({
          ...r,
          companyId: Buffer.alloc(16),
          payload: null,
          ...(reader ? { reads: r.readBy.filter((u) => u.equals(reader)).map(() => ({ readAt: new Date() })) } : {}),
        }));
      },
      findFirst: async ({ where }: any) => {
        const r = rows.find((x) => matches(x, where));
        return r ? { ...r, companyId: Buffer.alloc(16) } : null;
      },
      count: async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
    },
    notificationRead: {
      upsert: async ({ where }: any) => {
        const r = find(where.notificationId_userId.notificationId)!;
        const u: Buffer = where.notificationId_userId.userId;
        if (!r.readBy.some((x) => x.equals(u))) r.readBy.push(u);
        return {};
      },
      createMany: async ({ data }: any) => {
        for (const d of data) {
          const r = find(d.notificationId)!;
          if (!r.readBy.some((x) => x.equals(d.userId))) r.readBy.push(d.userId);
        }
        return { count: data.length };
      },
    },
  };
  return new NotificationsService([] as never, db as never);
}
