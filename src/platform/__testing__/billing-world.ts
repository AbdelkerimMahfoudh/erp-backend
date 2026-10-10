import { Prisma } from '@prisma/client';
import { BillingService } from '../../billing/billing.service';
import { SeatAllocationService } from '../seat-allocation.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../../common/utils/uuid.util';
import type { Activity } from '../../entitlement/activity';

/**
 * One business, its billing periods and its store requests, held in memory — with the REAL `BillingService`, the
 * real renewal and the real `SeatAllocationService` running on top (D158, docs/73 §11.1).
 *
 * The seat-allocation spec mocks billing away, which is right for the request lifecycle and blind to money: no
 * figure it checks ever reaches a period. Here every request, confirmation and renewal writes a period the real
 * arithmetic assessed, so a spec can say what the shop was actually charged.
 *
 * Two things a database does are reproduced because the rules under test lean on them:
 *
 *  - **one transaction at a time** — `$transaction` runs its callbacks in turn, which is what the subscription
 *    row's `FOR UPDATE` gives every path that takes it; reads outside a transaction still interleave freely;
 *  - **all or nothing** — a callback that throws leaves every table as it found it, and the unique keys of
 *    `branches` and `branch_replacements` refuse a duplicate with P2002, as MySQL would.
 *
 * Staff and seats are not modelled (the census reads no one): these specs are about the branch fee.
 */

export const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c101');
const OWNER = uuidToBin('018f0000-0000-7000-8000-00000000a101');
const OWNER_ROLE = uuidToBin('018f0000-0000-7000-8000-00000000e101');
export const ADMIN = { id: newUuidV7Bin(), email: 'ops@example.test', name: 'Ops' };
export const CTX = { admin: ADMIN, ip: '127.0.0.1' };
export const OWNER_LABEL = 'owner@shop.test';

type AnyRow = Record<string, any>;

interface Tables {
  subscriptions: AnyRow[];
  branches: AnyRow[];
  billingPeriods: AnyRow[];
  planVersions: AnyRow[];
  seatAllocations: AnyRow[];
  branchReplacements: AnyRow[];
  payments: AnyRow[];
  events: AnyRow[];
  userBranches: AnyRow[];
  /** The tenant's audit trail (`AuditService.recordTx`), written inside the transaction. */
  auditLogs: AnyRow[];
}

function same(a: unknown, b: unknown): boolean {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** The subset of Prisma's `where` these paths use: equality, `in`, `not`, `OR`. Relation filters are not modelled. */
function matches(row: AnyRow, where: AnyRow | undefined): boolean {
  for (const [key, want] of Object.entries(where ?? {})) {
    if (key === 'OR') {
      if (!(want as AnyRow[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const have = row[key] ?? null;
    if (want !== null && typeof want === 'object' && !Buffer.isBuffer(want) && !(want instanceof Date)) {
      if ('in' in want) {
        if (!(want.in as unknown[]).some((x) => same(have, x))) return false;
      } else if ('not' in want) {
        if (same(have, want.not)) return false;
      } else {
        throw new Error(`billing-world: unsupported filter on ${key}: ${JSON.stringify(want)}`);
      }
    } else if (!same(have, want)) {
      return false;
    }
  }
  return true;
}

function duplicate(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
}

/** Prisma's `{ increment }` and plain values, applied to a row in place. */
function apply(row: AnyRow, data: AnyRow): AnyRow {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date) && 'increment' in v) {
      row[k] = (row[k] ?? 0) + (v as { increment: number }).increment;
    } else {
      row[k] = v;
    }
  }
  return row;
}

export interface WorldOptions {
  /** The stores the business has when its paid period opens, in creation order. */
  stores: { name: string; activity: Activity }[];
  periodStart?: Date;
  periodEnd?: Date;
  /** What the subscription is paid up to: beyond `periodEnd` when the Owner paid the next month early. */
  currentPeriodEnd?: Date;
  now?: Date;
}

export async function makeBillingWorld(opts: WorldOptions) {
  const periodStart = opts.periodStart ?? new Date('2026-10-01T00:00:00.000Z');
  const periodEnd = opts.periodEnd ?? new Date('2026-11-01T00:00:00.000Z');
  let now = opts.now ?? new Date('2026-10-10T10:00:00.000Z');
  const clock = { now: () => now };

  const sub: AnyRow = {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    status: 'activated',
    subscribedBranchCount: opts.stores.length,
    version: 0,
    currentPeriodEnd: opts.currentPeriodEnd ?? periodEnd,
    company: { name: 'Shop', publicStoreId: 'ABCDEF1234' },
  };
  const t: Tables = {
    subscriptions: [sub],
    branches: opts.stores.map((s, i) => ({
      id: newUuidV7Bin(),
      companyId: COMPANY,
      name: s.name,
      type: 'store',
      activity: s.activity,
      activityNext: null,
      activityChangedAt: null,
      isActive: true,
      deletedAt: null,
      createdAt: new Date(periodStart.getTime() - (opts.stores.length - i) * 60_000),
    })),
    billingPeriods: [],
    planVersions: [
      {
        id: Buffer.alloc(16, 3),
        planKey: 'standard',
        version: 3,
        branchMonthly: 500,
        agentMonthly: 300,
        bothMonthly: 700,
        includedStaffPerBranch: 1,
        extraStaffMonthly: 100,
        effectiveFrom: new Date('2026-10-08T00:00:00.000Z'),
        reason: 'D154',
      },
    ],
    seatAllocations: [],
    branchReplacements: [],
    payments: [],
    events: [],
    userBranches: [],
    auditLogs: [],
  };
  const locks: string[] = [];
  const platformAudits: AnyRow[] = [];

  const byNewest = <T extends AnyRow>(rows: T[], key: string): T[] =>
    [...rows].sort((a, b) => (b[key] as Date).getTime() - (a[key] as Date).getTime());
  const hydrate = (r: AnyRow): AnyRow => {
    const named = (id: Buffer | null) => {
      const b = id ? t.branches.find((x) => x.id.equals(id)) : null;
      return b ? { id: b.id, name: b.name } : null;
    };
    return {
      ...r,
      branch: named(r.branchId),
      replaces: named(r.replacesBranchId),
      user: null,
      payment: r.paymentId ? (t.payments.find((p) => p.id.equals(r.paymentId)) ?? null) : null,
      company: sub.company,
    };
  };

  const db: AnyRow = {
    subscription: {
      findFirst: async ({ where }: AnyRow) => {
        const s = t.subscriptions.find((x) => matches(x, where));
        return s ? { ...s } : null;
      },
      update: async ({ where, data }: AnyRow) => ({ ...apply(t.subscriptions.find((x) => x.id.equals(where.id))!, data) }),
    },
    company: { findUnique: async () => ({ name: sub.company.name }) },
    branch: {
      findFirst: async ({ where }: AnyRow) => {
        const b = t.branches.find((x) => matches(x, where));
        return b ? { ...b } : null;
      },
      findMany: async ({ where }: AnyRow) =>
        t.branches
          .filter((b) => matches(b, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((b) => ({ ...b })),
      create: async ({ data }: AnyRow) => {
        if (t.branches.some((b) => b.companyId.equals(data.companyId) && b.name === data.name)) throw duplicate();
        const row = { activityNext: null, activityChangedAt: null, isActive: true, deletedAt: null, createdAt: now, ...data };
        t.branches.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: AnyRow) => ({ ...apply(t.branches.find((b) => b.id.equals(where.id))!, data) }),
      updateMany: async ({ where, data }: AnyRow) => {
        const hits = t.branches.filter((b) => matches(b, where));
        for (const b of hits) apply(b, data);
        return { count: hits.length };
      },
    },
    userBranch: {
      // The Owner is the business's one owner; the relation filters of the real query are not modelled.
      findMany: async () => [{ userId: OWNER, roleId: OWNER_ROLE }],
      create: async ({ data }: AnyRow) => (t.userBranches.push(data), data),
    },
    seatAllocation: {
      findFirst: async ({ where }: AnyRow) => {
        const r = t.seatAllocations.find((x) => matches(x, where));
        return r ? hydrate(r) : null;
      },
      findUnique: async ({ where }: AnyRow) => {
        const r = t.seatAllocations.find((x) => x.id.equals(where.id));
        return r ? hydrate(r) : null;
      },
      findMany: async ({ where }: AnyRow) => t.seatAllocations.filter((x) => matches(x, where)).map(hydrate),
      count: async ({ where }: AnyRow) => t.seatAllocations.filter((x) => matches(x, where)).length,
      create: async ({ data }: AnyRow) => {
        const row = {
          branchId: null,
          userId: null,
          label: null,
          activityFrom: null,
          activityTo: null,
          activityEffective: null,
          replacesBranchId: null,
          replacementCredit: null,
          replacementPeriodId: null,
          currency: 'MRU',
          requestedAt: now,
          paymentId: null,
          confirmedBy: null,
          confirmedAt: null,
          closedAt: null,
          closedBy: null,
          reason: null,
          version: 0,
          ...data,
        };
        t.seatAllocations.push(row);
        return hydrate(row);
      },
      updateMany: async ({ where, data }: AnyRow) => {
        const hits = t.seatAllocations.filter((x) => matches(x, where));
        for (const r of hits) apply(r, data);
        return { count: hits.length };
      },
    },
    subscriptionPayment: {
      create: async ({ data }: AnyRow) => (t.payments.push({ ...data }), data),
    },
    subscriptionEvent: {
      create: async ({ data }: AnyRow) => (t.events.push({ ...data, at: now }), data),
    },
    planVersion: {
      findMany: async () => [...t.planVersions],
    },
    billingPeriod: {
      findFirst: async ({ where }: AnyRow) => {
        const p = byNewest(t.billingPeriods.filter((x) => matches(x, where)), 'periodStart')[0];
        return p ? { ...p } : null;
      },
      create: async ({ data }: AnyRow) => (t.billingPeriods.push({ ...data }), data),
      update: async ({ where, data }: AnyRow) => ({ ...apply(t.billingPeriods.find((p) => p.id.equals(where.id))!, data) }),
    },
    branchReplacement: {
      findMany: async ({ where }: AnyRow) => t.branchReplacements.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      findFirst: async ({ where }: AnyRow) => {
        const r = t.branchReplacements.find((x) => matches(x, where));
        return r ? { ...r } : null;
      },
      // The two unique keys of 0091: one replacement per slot, and per replacement branch.
      create: async ({ data }: AnyRow) => {
        const taken = t.branchReplacements.some(
          (r) =>
            (r.billingPeriodId.equals(data.billingPeriodId) && r.archivedBranchId.equals(data.archivedBranchId)) ||
            r.replacementBranchId.equals(data.replacementBranchId),
        );
        if (taken) throw duplicate();
        t.branchReplacements.push({ ...data });
        return data;
      },
    },
    // The subscription lock is recorded; the census finds no staff and no held seats.
    $queryRaw: async (q: { strings?: readonly string[] } | readonly string[]) => {
      const text = (Array.isArray(q) ? q : ((q as { strings?: readonly string[] }).strings ?? [])).join('?');
      if (/FOR UPDATE/.test(text)) locks.push(text.replace(/\s+/g, ' ').trim());
      return [];
    },
  };

  let queue: Promise<unknown> = Promise.resolve();
  db.$transaction = (fn: (tx: AnyRow) => Promise<unknown>) => {
    const run = queue.then(async () => {
      const saved = Object.fromEntries(
        Object.entries(t).map(([name, rows]) => [name, (rows as AnyRow[]).map((r) => ({ ...r }))]),
      ) as unknown as Tables;
      try {
        return await fn(db);
      } catch (e) {
        for (const name of Object.keys(t) as (keyof Tables)[]) {
          t[name].length = 0;
          t[name].push(...saved[name]);
        }
        throw e;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const billing = new BillingService(db as never, clock);
  const tenantAudit = {
    recordTx: async (_tx: unknown, params: AnyRow) => void t.auditLogs.push(params),
  };
  const platformAudit = { record: async (e: AnyRow) => void platformAudits.push(e) };
  const service = new SeatAllocationService(db as never, platformAudit as never, billing, clock, tenantAudit as never);

  await billing.openPeriod(COMPANY, sub.id, periodEnd, { startsAt: periodStart });

  const branch = (name: string): AnyRow => {
    const b = t.branches.find((x) => x.name === name);
    if (!b) throw new Error(`billing-world: no branch named ${name}`);
    return b;
  };
  const latest = (): AnyRow => byNewest(t.billingPeriods, 'periodStart')[0];

  return {
    service,
    billing,
    db,
    t,
    locks,
    platformAudits,
    clock: {
      now: () => now,
      set: (d: Date) => {
        now = d;
      },
    },
    subscription: () => t.subscriptions[0],
    branch,
    branchId: (name: string): string => binToUuid(branch(name).id),
    /** Archive a store the only way one can be archived today: directly in the database (docs/73 §11.6). */
    archive: (name: string) => {
      branch(name).isActive = false;
    },
    reactivate: (name: string) => {
      branch(name).isActive = true;
    },
    period: latest,
    periods: () => [...t.billingPeriods].sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime()),
    request: (id: string): AnyRow => t.seatAllocations.find((r) => binToUuid(r.id) === id)!,
    /** The Super Admin confirms a payment of this amount for the request. */
    confirm: (id: string, amount: number, extra: { reference?: string; expectedVersion?: number } = {}) =>
      service.confirmPayment(
        uuidToBin(id),
        { amount: String(amount), paidAt: new Date(now.getTime() - 60_000), reference: extra.reference ?? 'BK-1001', expectedVersion: extra.expectedVersion },
        CTX,
      ),
  };
}

export type BillingWorld = Awaited<ReturnType<typeof makeBillingWorld>>;
