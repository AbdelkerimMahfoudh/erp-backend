/**
 * A phone's history, as stable facts for a client to put into words.
 *
 * The audit log is written for accountability, not for reading: an action is
 * `create` or `status_change`, a status lives inside a JSON `before`/`after`,
 * the actor is a binary id, and a few system flows left an English sentence in
 * a reason field. The Unit screen showed exactly that — `status_change`, eleven
 * times, in French and Arabic.
 *
 * This shapes each entry into facts that do not depend on language:
 *
 *   - `fromStatus` / `toStatus` — null when the entry does not record them;
 *     nothing is inferred from neighbouring entries.
 *   - `context` — a stable code for a known system reason (a return intake, a
 *     cancelled transfer). A reason that is not a known code stays in `reason`
 *     for technical detail and is never promoted to a label.
 *   - `actor` — name and role at the branch where it happened, when known.
 *   - `branch`, `toBranch`, `fromBranch` — names, when the entry names them.
 *
 * **The server translates nothing.** The mobile app maps codes to words in the
 * shop's language. Every legacy field (`action`, `before`, `after`, `reason`,
 * `by`) is kept, so an older client keeps working.
 *
 * Kept free of Prisma so the rules can be tested directly.
 */

export type UnitEventContext =
  | 'return_intake'
  | 'return_approved'
  | 'return_rejected'
  | 'transfer_rejected'
  | 'transfer_cancelled';

/** System-written reasons, as the services wrote them, mapped to stable codes. */
const CONTEXT_BY_REASON: Record<string, UnitEventContext> = {
  'return custody intake': 'return_intake',
  'return approved — held, not sellable': 'return_approved',
  'return rejected — handed back to the customer': 'return_rejected',
  'transfer rejected': 'transfer_rejected',
  'transfer cancelled': 'transfer_cancelled',
};

export interface RawUnitAuditEvent {
  id: bigint;
  at: Date;
  entityType: string;
  action: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  userId: Buffer | null;
  branchId: Buffer | null;
}

/** A store's or a person's two names (D225): the Arabic one is null until given. */
export interface TimelineName {
  name: string;
  nameAr: string | null;
}

export interface TimelineLookups {
  /** By user id (hex): both names, and role key per branch id (hex). */
  users: Map<string, TimelineName & { roles: Map<string, string> }>;
  /** By branch id (hex): both names. */
  branches: Map<string, TimelineName>;
}

export interface UnitTimelineEntry {
  id: string;
  at: Date;
  entity: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  context: UnitEventContext | null;
  actor: (TimelineName & { role: string | null }) | null;
  branch: TimelineName | null;
  fromBranch: TimelineName | null;
  toBranch: TimelineName | null;
  transferId: string | null;
  // ── legacy, unchanged ──
  before: unknown;
  after: unknown;
  reason: string | null;
  by: string | null;
}

const hex = (b: Buffer) => b.toString('hex');
/** A UUID string as stored inside audit JSON → the hex key the lookups use. */
const uuidHex = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f-]{32,36}$/i.test(value) ? value.replace(/-/g, '').toLowerCase() : null;

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Every user id and branch id a set of entries refers to, for one lookup each. */
export function referencedIds(events: RawUnitAuditEvent[]): { userIds: Buffer[]; branchIds: Buffer[] } {
  const users = new Map<string, Buffer>();
  const branches = new Map<string, Buffer>();
  for (const e of events) {
    if (e.userId) users.set(hex(e.userId), e.userId);
    if (e.branchId) branches.set(hex(e.branchId), e.branchId);
    for (const key of ['branch', 'toBranch', 'fromBranch']) {
      const id = uuidHex(field(e.after, key));
      if (id) branches.set(id, Buffer.from(id, 'hex'));
    }
  }
  return { userIds: [...users.values()], branchIds: [...branches.values()] };
}

/** Newest first. One output entry per audit row — nothing merged, nothing dropped. */
export function shapeUnitTimeline(events: RawUnitAuditEvent[], lookups: TimelineLookups): UnitTimelineEntry[] {
  return [...events]
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0))
    .map((e) => {
      const branchKey = e.branchId ? hex(e.branchId) : null;
      const user = e.userId ? lookups.users.get(hex(e.userId)) : undefined;
      const store = (id: string | null): TimelineName | null => {
        const found = id ? lookups.branches.get(id) : undefined;
        return found ? { name: found.name, nameAr: found.nameAr } : null;
      };
      const named = (value: unknown) => store(uuidHex(value));
      // A reason may sit in the column or, for returns, inside `after`.
      const systemReason = text(e.reason) ?? text(field(e.after, 'reason'));

      return {
        id: e.id.toString(),
        at: e.at,
        entity: e.entityType,
        action: e.action,
        fromStatus: text(field(e.before, 'status')),
        toStatus: text(field(e.after, 'status')),
        context: systemReason ? (CONTEXT_BY_REASON[systemReason] ?? null) : null,
        actor: user
          ? {
              name: user.name,
              nameAr: user.nameAr,
              role: (branchKey ? user.roles.get(branchKey) : undefined) ?? [...user.roles.values()][0] ?? null,
            }
          : null,
        branch: store(branchKey),
        fromBranch: named(field(e.after, 'fromBranch')),
        toBranch: named(field(e.after, 'toBranch')) ?? named(field(e.after, 'branch')),
        transferId: text(field(e.after, 'transferId')),
        before: e.before,
        after: e.after,
        reason: e.reason,
        by: e.userId ? formatUuid(hex(e.userId)) : null,
      };
    });
}

function formatUuid(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
