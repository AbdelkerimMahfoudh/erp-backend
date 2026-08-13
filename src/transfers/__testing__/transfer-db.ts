import { Prisma } from '@prisma/client';
import { newUuidV7Bin, uuidToBin } from '../../common/utils/uuid.util';

/**
 * A database-like double for the transfer lifecycle.
 *
 * It behaves like the database rather than like a mock: company scoping, the
 * `(company_id, client_uuid)` unique key, compare-and-swap on `version` and on
 * `status`, relation loading, and a `$transaction` that really does roll back.
 * A service that transitioned without a version check, wrote a notification
 * outside the transaction, or reserved a unit somebody else already held fails
 * here rather than in a shop.
 *
 * What it deliberately does NOT prove — real row locks, genuine concurrent
 * writers, CHECK constraints and the append-only triggers — is proven against
 * real MySQL in the H1.1 and H1.3 live verification, because a double can only
 * ever agree with itself.
 *
 * Excluded from the build via `tsconfig.build.json`; it exists only for specs.
 */

export interface Row {
  id: Buffer;
  companyId: Buffer;
  [k: string]: unknown;
}

export interface Db {
  branch: Row[];
  user: Row[];
  userBranch: Row[];
  unit: Row[];
  product: Row[];
  stockTransfer: Row[];
  transferItem: Row[];
  notification: Row[];
  auditLog: Row[];
  setting: Row[];
}

export const emptyDb = (): Db => ({
  branch: [],
  user: [],
  userBranch: [],
  unit: [],
  product: [],
  stockTransfer: [],
  transferItem: [],
  notification: [],
  auditLog: [],
  setting: [],
});

const eq = (a: unknown, b: unknown): boolean =>
  Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b;

/**
 * Relations the double can resolve, as (parent model, key) → how to find it.
 * `list` distinguishes a to-many from a to-one, exactly as Prisma's shape does.
 */
const RELATIONS: Record<string, { model: keyof Db; fk: string; on?: string; list?: boolean }> = {
  'stockTransfer.items': { model: 'transferItem', fk: 'transferId', on: 'id', list: true },
  'stockTransfer.fromBranch': { model: 'branch', fk: 'id', on: 'fromBranchId' },
  'stockTransfer.toBranch': { model: 'branch', fk: 'id', on: 'toBranchId' },
  'stockTransfer.requestedBy': { model: 'user', fk: 'id', on: 'requestedById' },
  'stockTransfer.approvedBy': { model: 'user', fk: 'id', on: 'approvedById' },
  'stockTransfer.decidedBy': { model: 'user', fk: 'id', on: 'decidedById' },
  'stockTransfer.sentBy': { model: 'user', fk: 'id', on: 'sentById' },
  'stockTransfer.receivedBy': { model: 'user', fk: 'id', on: 'receivedById' },
  'transferItem.unit': { model: 'unit', fk: 'id', on: 'unitId' },
  'transferItem.product': { model: 'product', fk: 'id', on: 'productId' },
  'unit.product': { model: 'product', fk: 'id', on: 'productId' },
  'userBranch.user': { model: 'user', fk: 'id', on: 'userId' },
};

/** Match a Prisma-ish `where` against a row, supporting the operators we use. */
export function matches(db: Db, model: keyof Db, row: Row, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true;
  for (const [key, cond] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'OR') {
      if (!(cond as unknown[]).some((c) => matches(db, model, row, c))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as unknown[]).every((c) => matches(db, model, row, c))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matches(db, model, row, cond)) return false;
      continue;
    }

    // Relation filter: `role: { key: 'owner' }`, `user: { isActive: true } `.
    const rel = RELATIONS[`${String(model)}.${key}`];
    if (rel) {
      const related = resolveRelation(db, row, rel);
      const many = Array.isArray(related) ? related : related ? [related] : [];
      const c = cond as Record<string, unknown>;
      if ('some' in c) {
        if (!many.some((r) => matches(db, rel.model, r, c.some))) return false;
      } else if (!many.some((r) => matches(db, rel.model, r, cond))) {
        return false;
      }
      continue;
    }
    /**
     * `role` on a userBranch is stored denormalised: `roleKey` plus the set of
     * permission keys that role holds. Both shapes the code uses are supported —
     * `role: { key: 'owner' }` and the recipient lookup
     * `role: { rolePermissions: { some: { permission: { key: '…' } } } }`.
     *
     * The relation name is asserted, not guessed. An earlier version accepted
     * `permissions` here, which is NOT what `Role` declares — so the double
     * happily agreed with a query real Prisma rejected outright, and only a
     * live request found it. A double that tolerates a shape the database does
     * not is worse than no double at all.
     */
    if (key === 'role') {
      const c = cond as {
        key?: string;
        rolePermissions?: { some?: { permission?: { key?: string } } };
      };
      for (const k of Object.keys(c)) {
        if (k !== 'key' && k !== 'rolePermissions') {
          throw new Error(
            `role filter used '${k}', but Role declares only 'key' and 'rolePermissions'`,
          );
        }
      }
      if (c.key !== undefined && !eq(row.roleKey, c.key)) return false;
      const wanted = c.rolePermissions?.some?.permission?.key;
      if (wanted !== undefined) {
        const held = (row.rolePermissionKeys as string[] | undefined) ?? [];
        if (!held.includes(wanted)) return false;
      }
      continue;
    }

    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !Buffer.isBuffer(cond) && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('not' in c && eq(value, c.not)) return false;
      if ('in' in c && !(c.in as unknown[]).some((v) => eq(value, v))) return false;
      if ('notIn' in c && (c.notIn as unknown[]).some((v) => eq(value, v))) return false;
      if ('gt' in c && !(Number(value) > Number(c.gt))) return false;
      if ('gte' in c && !(Number(value) >= Number(c.gte))) return false;
      if ('lt' in c && !(Number(value) < Number(c.lt))) return false;
      if ('contains' in c && !String(value ?? '').toLowerCase().includes(String(c.contains).toLowerCase())) {
        return false;
      }
      continue;
    }
    if (!eq(value, cond)) return false;
  }
  return true;
}

function resolveRelation(db: Db, row: Row, rel: { model: keyof Db; fk: string; on?: string; list?: boolean }) {
  const key = row[rel.on ?? 'id'];
  if (key === null || key === undefined) return rel.list ? [] : null;
  const hits = db[rel.model].filter((r) => eq(r[rel.fk], key));
  return rel.list ? hits : (hits[0] ?? null);
}

/** Apply `select` / `include`, recursing into relations. */
function project(db: Db, model: keyof Db, row: Row, opts: { select?: unknown; include?: unknown }): unknown {
  const spec = (opts.select ?? opts.include) as Record<string, unknown> | undefined;
  if (!spec) return row;
  // `include` keeps every scalar; `select` keeps only what was asked for.
  const out: Record<string, unknown> = opts.include ? { ...row } : {};
  for (const [key, value] of Object.entries(spec)) {
    if (!value) continue;

    // `_count: { select: { items: true } }` — a relation tally, not a column.
    if (key === '_count') {
      const wanted = (value as { select?: Record<string, unknown> }).select ?? {};
      const counts: Record<string, number> = {};
      for (const relKey of Object.keys(wanted)) {
        const rel = RELATIONS[`${String(model)}.${relKey}`];
        const related = rel ? resolveRelation(db, row, rel) : null;
        counts[relKey] = Array.isArray(related) ? related.length : related ? 1 : 0;
      }
      out._count = counts;
      continue;
    }

    const rel = RELATIONS[`${String(model)}.${key}`];
    if (rel) {
      const related = resolveRelation(db, row, rel);
      const nested = typeof value === 'object' ? (value as { select?: unknown; include?: unknown }) : {};
      out[key] = Array.isArray(related)
        ? related.map((r) => project(db, rel.model, r, nested))
        : related
          ? project(db, rel.model, related as Row, nested)
          : null;
      continue;
    }
    if (!opts.include) out[key] = row[key];
  }
  return out;
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

/** Unique keys the real schema enforces — the double enforces them too. */
const UNIQUE: Partial<Record<keyof Db, (r: Row) => string | null>> = {
  stockTransfer: (r) => (r.clientUuid ? (r.clientUuid as Buffer).toString('hex') : null),
  /**
   * `notifications_company_target_dedupe_key` (migration 0033). Returning null
   * for a row with no dedupe key mirrors MySQL, where NULLs never collide — so
   * an ordinary notification is still an ordinary insert.
   */
  notification: (r) =>
    r.dedupeKey
      ? `${r.targetUserId ? (r.targetUserId as Buffer).toString('hex') : 'all'}:${String(r.dedupeKey)}`
      : null,
};

/**
 * Column defaults the real schema applies on INSERT.
 *
 * Without these a freshly created transfer has `version: undefined`, every
 * compare-and-swap on version 0 matches nothing, and the double would fail the
 * whole lifecycle for a reason the database does not have.
 */
const DEFAULTS: Partial<Record<keyof Db, Record<string, unknown>>> = {
  stockTransfer: {
    version: 0,
    status: 'pending_approval',
    autoApproved: false,
    transferNo: null,
    sentById: null,
    receivedById: null,
    receivedAt: null,
    requestedById: null,
    approvedById: null,
    approvedAt: null,
    decisionReason: null,
    decidedById: null,
    decidedAt: null,
  },
  transferItem: { quantity: 1, unitId: null, productId: null },
  notification: { isRead: false, branchId: null, targetUserId: null, body: null, actionLink: null },
  unit: { status: 'in_stock' },
};

/** Apply Prisma's `data` operators (`{ increment: 1 }`) onto a row. */
function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
      const v = value as Record<string, unknown>;
      if ('increment' in v) {
        row[key] = Number(row[key] ?? 0) + Number(v.increment);
        continue;
      }
    }
    row[key] = value;
  }
}

export function makeClient(db: Db, companyId: Buffer) {
  const model = (name: keyof Db) => {
    const scoped = () => db[name].filter((r) => r.companyId.equals(companyId));
    const find = (where: unknown) => scoped().find((r) => matches(db, name, r, where)) ?? null;

    return {
      findFirst: async (args: { where?: unknown; select?: unknown; include?: unknown; orderBy?: unknown } = {}) => {
        const hit = find(args.where);
        return hit ? project(db, name, hit, args) : null;
      },
      findUnique: async (args: { where?: unknown; select?: unknown; include?: unknown }) => {
        const hit = find(args.where);
        return hit ? project(db, name, hit, args) : null;
      },
      findMany: async (
        args: {
          where?: unknown;
          select?: unknown;
          include?: unknown;
          orderBy?: { id?: 'asc' | 'desc' } | { id?: 'asc' | 'desc' }[];
          take?: number;
          skip?: number;
          cursor?: { id: Buffer };
        } = {},
      ) => {
        let rows = scoped().filter((r) => matches(db, name, r, args.where));
        const order = Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy;
        if (order?.id) {
          rows = [...rows].sort((a, b) =>
            order.id === 'desc' ? b.id.compare(a.id) : a.id.compare(b.id),
          );
        }
        if (args.cursor) {
          const at = rows.findIndex((r) => r.id.equals(args.cursor!.id));
          rows = at >= 0 ? rows.slice(at) : [];
        }
        if (args.skip) rows = rows.slice(args.skip);
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        return rows.map((r) => project(db, name, r, args));
      },
      count: async (args: { where?: unknown } = {}) =>
        scoped().filter((r) => matches(db, name, r, args.where)).length,
      groupBy: async (args: { by: string[]; where?: unknown }) => {
        const rows = scoped().filter((r) => matches(db, name, r, args.where));
        const buckets = new Map<string, { key: Record<string, unknown>; n: number }>();
        for (const r of rows) {
          const key = Object.fromEntries(args.by.map((b) => [b, r[b]]));
          const k = JSON.stringify(args.by.map((b) => String(r[b])));
          const bucket = buckets.get(k) ?? { key, n: 0 };
          bucket.n += 1;
          buckets.set(k, bucket);
        }
        return [...buckets.values()].map((b) => ({ ...b.key, _count: { _all: b.n } }));
      },
      create: async ({ data, select, include }: { data: Record<string, unknown>; select?: unknown; include?: unknown }) => {
        const row = {
          id: (data.id as Buffer) ?? newUuidV7Bin(),
          createdAt: new Date(),
          ...(DEFAULTS[name] ?? {}),
          ...data,
          companyId: (data.companyId as Buffer) ?? companyId,
        } as Row;
        const key = UNIQUE[name];
        if (key) {
          const mine = key(row);
          if (mine && db[name].some((r) => r.companyId.equals(row.companyId) && key(r) === mine)) {
            throw uniqueViolation();
          }
        }
        db[name].push(row);
        return project(db, name, row, { select, include });
      },
      update: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
        const hit = find(where);
        if (!hit) throw new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: 'test' });
        applyData(hit, data);
        return hit;
      },
      updateMany: async ({ where, data }: { where?: unknown; data: Record<string, unknown> }) => {
        const hits = scoped().filter((r) => matches(db, name, r, where));
        for (const hit of hits) applyData(hit, data);
        return { count: hits.length };
      },
      deleteMany: async ({ where }: { where?: unknown } = {}) => {
        const hits = scoped().filter((r) => matches(db, name, r, where));
        for (const hit of hits) db[name].splice(db[name].indexOf(hit), 1);
        return { count: hits.length };
      },
    };
  };

  const client: Record<string, unknown> = {};
  for (const name of Object.keys(emptyDb()) as (keyof Db)[]) client[name] = model(name);

  /**
   * A real transaction, not a pass-through. The whole point of several tests is
   * that a failure part-way leaves NOTHING behind — no reserved unit, no
   * half-created transfer, no notification for a transition that rolled back.
   */
  client.$transaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const snapshot = Object.fromEntries(
      (Object.keys(db) as (keyof Db)[]).map((k) => [k, db[k].map((r) => ({ ...r }))]),
    ) as unknown as Db;
    try {
      return await fn(client);
    } catch (e) {
      for (const k of Object.keys(db) as (keyof Db)[]) {
        db[k].splice(0, db[k].length, ...snapshot[k]);
      }
      throw e;
    }
  };

  /**
   * Raw SQL is NOT emulated, and asking for it fails loudly.
   *
   * Quantity reservation, shipment and the weighted average are single
   * conditional UPDATEs whose whole correctness lives in a WHERE clause MySQL
   * evaluates while holding a row lock. Re-implementing that in JavaScript
   * would test the re-implementation — the same mistake that let H1.3's
   * recipient query stay green against a double while real Prisma rejected it.
   *
   * Those paths are proved against **real MySQL** in the H1.4 race suite
   * instead. Throwing here means a future test that wanders into one gets an
   * unmistakable failure rather than a quiet pass.
   */
  const rawNotEmulated = () => {
    throw new Error(
      'This double does not emulate raw SQL. Quantity reservation and the weighted ' +
        'average are proved against real MySQL (H1.4 race suite), not here.',
    );
  };
  client.$executeRaw = rawNotEmulated;
  client.$executeRawUnsafe = rawNotEmulated;
  client.$queryRaw = rawNotEmulated;
  client.$queryRawUnsafe = rawNotEmulated;

  return client;
}

// ─────────────────────────── fixture builders ───────────────────────────

export const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
export const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
export const SOURCE = uuidToBin('018f0000-0000-7000-8000-0000000b0001');
export const DEST = uuidToBin('018f0000-0000-7000-8000-0000000b0002');
export const THIRD = uuidToBin('018f0000-0000-7000-8000-0000000b0003');

export const OWNER = uuidToBin('018f0000-0000-7000-8000-00000000a001');
export const MANAGER = uuidToBin('018f0000-0000-7000-8000-00000000a002');
export const EMPLOYEE = uuidToBin('018f0000-0000-7000-8000-00000000a003');
export const DEST_MANAGER = uuidToBin('018f0000-0000-7000-8000-00000000a004');
export const DEST_EMPLOYEE = uuidToBin('018f0000-0000-7000-8000-00000000a005');
export const BOTH_BRANCH_EMPLOYEE = uuidToBin('018f0000-0000-7000-8000-00000000a006');

/** Permission sets exactly as migrations 0031/0032 grant them. */
export const OWNER_PERMISSIONS = [
  'transfer.view',
  'transfer.request',
  'transfer.approve',
  'transfer.ship',
  'transfer.receive',
  'transfer.cancel',
  'transfer.cancel_own',
];
export const MANAGER_PERMISSIONS = [...OWNER_PERMISSIONS];
export const EMPLOYEE_PERMISSIONS = [
  'transfer.view',
  'transfer.request',
  'transfer.ship',
  'transfer.receive',
  'transfer.cancel_own',
];

/** What each role holds, exactly as `0031`/`0032` grant it. */
export const PERMISSIONS_BY_ROLE: Record<string, string[]> = {
  owner: OWNER_PERMISSIONS,
  store_manager: MANAGER_PERMISSIONS,
  store_employee: EMPLOYEE_PERMISSIONS,
};

export function seedBranchesAndPeople(db: Db): void {
  db.branch.push(
    { id: SOURCE, companyId: COMPANY, name: 'Main Store' },
    { id: DEST, companyId: COMPANY, name: 'Warehouse' },
    { id: THIRD, companyId: COMPANY, name: 'Airport Kiosk' },
  );

  const people: [Buffer, string, string, Buffer[]][] = [
    [OWNER, 'Aicha the Owner', 'owner', [SOURCE, DEST, THIRD]],
    [MANAGER, 'Moussa the Manager', 'store_manager', [SOURCE]],
    [EMPLOYEE, 'Salma the Employee', 'store_employee', [SOURCE]],
    [DEST_MANAGER, 'Demba the Manager', 'store_manager', [DEST]],
    [DEST_EMPLOYEE, 'Dieynaba the Employee', 'store_employee', [DEST]],
    [BOTH_BRANCH_EMPLOYEE, 'Baba the Employee', 'store_employee', [SOURCE, DEST]],
  ];

  for (const [id, name, roleKey, branches] of people) {
    db.user.push({ id, companyId: COMPANY, name, isActive: true, deletedAt: null });
    for (const branchId of branches) {
      db.userBranch.push({
        id: newUuidV7Bin(),
        companyId: COMPANY,
        userId: id,
        branchId,
        roleKey,
        // Denormalised so the recipient lookup can ask "who holds this key
        // here?" exactly as the real query does, through the role.
        rolePermissionKeys: PERMISSIONS_BY_ROLE[roleKey],
        // The double reads relation filters through `user`, so mirror the row.
        user: { isActive: true, deletedAt: null },
      });
    }
  }
}

/** Deactivate a user, as `user.deletedAt`/`isActive` would. */
export function deactivate(db: Db, userId: Buffer): void {
  const user = db.user.find((u) => (u.id as Buffer).equals(userId));
  if (user) user.isActive = false;
  for (const ub of db.userBranch) {
    if ((ub.userId as Buffer).equals(userId)) {
      ub.user = { isActive: false, deletedAt: null };
    }
  }
}

let unitSeq = 0;

export function seedUnit(
  db: Db,
  opts: { branchId?: Buffer; status?: string; imei?: string; companyId?: Buffer } = {},
): Row {
  unitSeq += 1;
  const productId = newUuidV7Bin();
  const companyId = opts.companyId ?? COMPANY;
  db.product.push({
    id: productId,
    companyId,
    brand: 'Samsung',
    model: `Galaxy A${10 + unitSeq}`,
    variant: '128GB',
    trackingType: 'imei',
  });
  const unit: Row = {
    id: newUuidV7Bin(),
    companyId,
    productId,
    branchId: opts.branchId ?? SOURCE,
    status: opts.status ?? 'in_stock',
    imeiPrimary: opts.imei ?? `35693803564${String(3800 + unitSeq).padStart(4, '0')}`,
    serialNo: null,
    cost: 1000,
  };
  db.unit.push(unit);
  return unit;
}
