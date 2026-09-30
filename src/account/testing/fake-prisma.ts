/**
 * An in-memory stand-in for the Prisma client, for the account tests.
 *
 * It implements the subset of the query API the account services use —
 * equality and a few operators in `where`, `select` as a projection,
 * `orderBy` on one column, `increment`, and interactive transactions — and it
 * enforces the two constraints the deletion design leans on: the UNIQUE
 * `active_key` on deletion requests and on OTP challenges. A double that
 * always succeeds would let a broken race guard pass here and fail in a shop.
 *
 * Nothing here is clever. A `where` it does not understand throws, so a test
 * cannot pass by accident on an unmatched clause.
 */

import { Prisma } from '@prisma/client';

type Row = Record<string, unknown>;

const UNIQUE: Record<string, string[][]> = {
  accountDeletionRequest: [['activeKey'], ['companyId', 'clientUuid']],
  otpChallenge: [['activeKey'], ['companyId', 'idempotencyKey']],
  user: [['companyId', 'phone'], ['companyId', 'login']],
};

/** Column defaults the real schema applies on insert (`@default`), for the models these tests create. */
const DEFAULTS: Record<string, Row> = {
  otpChallenge: {
    status: 'pending',
    deviceId: null,
    candidatePhone: null,
    attemptCount: 0,
    lastAttemptAt: null,
    sendCount: 0,
    lastSentAt: null,
    resendNotBefore: null,
    verifiedAt: null,
    consumedAt: null,
    cancelledAt: null,
    lockedAt: null,
    provider: null,
    providerMessageId: null,
    deliveryState: 'not_sent',
    deliveryDetail: null,
    idempotencyKey: null,
  },
  accountDeletionRequest: {
    status: 'awaiting_code',
    challengeId: null,
    language: 'en',
    activeKey: null,
    clientUuid: null,
    requestIp: null,
    codeSentAt: null,
    confirmedAt: null,
    processingStartedAt: null,
    completedAt: null,
    cancelledAt: null,
    failureDetail: null,
    retainedSummary: null,
    version: 0,
  },
  auditLog: { branchId: null, userId: null, entityId: null, before: null, after: null, reason: null, ip: null },
  subscriptionEvent: { note: null, periodEndAfter: null, branchesAfter: null, seatsAfter: null, actor: null },
};

function same(a: unknown, b: unknown): boolean {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
    return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}

function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((c) => matches(row, c))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Row[]).every((c) => matches(row, c))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matches(row, cond as Row)) return false;
      continue;
    }
    const actual = row[key];
    if (cond !== null && typeof cond === 'object' && !Buffer.isBuffer(cond) && !(cond instanceof Date)) {
      const c = cond as Row;
      for (const [op, value] of Object.entries(c)) {
        switch (op) {
          case 'equals':
            if (!same(actual, value)) return false;
            break;
          case 'not':
            if (same(actual, value)) return false;
            break;
          case 'in':
            if (!(value as unknown[]).some((v) => same(actual, v))) return false;
            break;
          case 'notIn':
            if ((value as unknown[]).some((v) => same(actual, v))) return false;
            break;
          case 'gte':
            if (!(actual instanceof Date && actual >= (value as Date))) return false;
            break;
          case 'gt':
            if (!(actual instanceof Date && actual > (value as Date))) return false;
            break;
          case 'lte':
            if (!(actual instanceof Date && actual <= (value as Date))) return false;
            break;
          case 'lt':
            if (!(actual instanceof Date && actual < (value as Date))) return false;
            break;
          default:
            throw new Error(`fake-prisma: unsupported where operator "${op}" on "${key}"`);
        }
      }
      continue;
    }
    if (!same(actual, cond)) return false;
  }
  return true;
}

function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

function apply(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date) && 'increment' in (v as Row)) {
      row[k] = ((row[k] as number) ?? 0) + ((v as Row).increment as number);
    } else {
      row[k] = v;
    }
  }
}

export class FakePrisma {
  readonly tables = new Map<string, Row[]>();
  private counter = 0;

  constructor() {
    return new Proxy(this, {
      get: (target, prop: string | symbol) => {
        if (typeof prop === 'symbol' || prop in target) return (target as never)[prop as never];
        return target.delegate(prop);
      },
    });
  }

  rows(model: string): Row[] {
    if (!this.tables.has(model)) this.tables.set(model, []);
    return this.tables.get(model)!;
  }

  seed(model: string, ...rows: Row[]): void {
    for (const r of rows) this.rows(model).push({ ...r });
  }

  async $transaction<T>(arg: ((tx: FakePrisma) => Promise<T>) | Promise<unknown>[]): Promise<T> {
    if (typeof arg === 'function') {
      /*
       * A snapshot, restored IN PLACE on failure: the rollback the design
       * relies on. Row objects keep their identity so a test holding a
       * reference from before the transaction still reads the restored state.
       */
      const snapshot = new Map(
        [...this.tables.entries()].map(([k, v]) => [k, v.map((ref) => ({ ref, data: { ...ref } }))]),
      );
      try {
        return await arg(this);
      } catch (e) {
        for (const model of [...this.tables.keys()]) {
          if (!snapshot.has(model)) this.tables.set(model, []);
        }
        for (const [model, entries] of snapshot) {
          this.tables.set(
            model,
            entries.map(({ ref, data }) => {
              for (const key of Object.keys(ref)) if (!(key in data)) delete ref[key];
              return Object.assign(ref, data);
            }),
          );
        }
        throw e;
      }
    }
    return Promise.all(arg) as Promise<T>;
  }

  private assertUnique(model: string, candidate: Row, exceptRow?: Row): void {
    for (const columns of UNIQUE[model] ?? []) {
      if (columns.some((c) => candidate[c] === null || candidate[c] === undefined)) continue;
      const clash = this.rows(model).find(
        (r) => r !== exceptRow && columns.every((c) => same(r[c], candidate[c])),
      );
      if (clash) {
        const e = new Error(`Unique constraint failed on ${model}.${columns.join('+')}`) as Error & { code: string; meta: Row };
        e.code = 'P2002';
        e.meta = { target: columns.join('_') };
        // Shaped like Prisma's own error, so `instanceof` checks in services still see P2002.
        Object.setPrototypeOf(e, Prisma.PrismaClientKnownRequestError.prototype);
        throw e;
      }
    }
  }

  private delegate(model: string) {
    const rows = () => this.rows(model);
    const order = (list: Row[], orderBy?: Row | Row[]): Row[] => {
      const spec = Array.isArray(orderBy) ? orderBy[0] : orderBy;
      if (!spec) return list;
      const [col, dir] = Object.entries(spec)[0];
      return [...list].sort((a, b) => {
        const x = a[col] as Date | number | string;
        const y = b[col] as Date | number | string;
        const cmp = x < y ? -1 : x > y ? 1 : 0;
        return dir === 'desc' ? -cmp : cmp;
      });
    };
    return {
      create: async ({ data, select }: { data: Row; select?: Row }) => {
        const row: Row = { ...(DEFAULTS[model] ?? {}), ...data };
        if (!('createdAt' in row)) row.createdAt = new Date(Date.now() + this.counter++);
        this.assertUnique(model, row);
        rows().push(row);
        return project(row, select);
      },
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        const found = rows().find((r) => matches(r, where));
        return found ? project(found, select) : null;
      },
      findFirst: async ({ where, select, orderBy }: { where?: Row; select?: Row; orderBy?: Row | Row[] }) => {
        const found = order(rows().filter((r) => matches(r, where ?? {})), orderBy)[0];
        return found ? project(found, select) : null;
      },
      findMany: async ({ where, select, orderBy, take }: { where?: Row; select?: Row; orderBy?: Row | Row[]; take?: number }) => {
        const list = order(rows().filter((r) => matches(r, where ?? {})), orderBy);
        return (take ? list.slice(0, take) : list).map((r) => project(r, select));
      },
      count: async ({ where }: { where?: Row }) => rows().filter((r) => matches(r, where ?? {})).length,
      update: async ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
        const row = rows().find((r) => matches(r, where));
        if (!row) {
          const e = new Error('Record to update not found') as Error & { code: string };
          e.code = 'P2025';
          Object.setPrototypeOf(e, Prisma.PrismaClientKnownRequestError.prototype);
          throw e;
        }
        const next = { ...row };
        apply(next, data);
        this.assertUnique(model, next, row);
        apply(row, data);
        return project(row, select);
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hits = rows().filter((r) => matches(r, where));
        for (const h of hits) {
          const next = { ...h };
          apply(next, data);
          this.assertUnique(model, next, h);
        }
        for (const h of hits) apply(h, data);
        return { count: hits.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const keep = rows().filter((r) => !matches(r, where));
        const removed = rows().length - keep.length;
        this.tables.set(model, keep);
        return { count: removed };
      },
    };
  }
}

