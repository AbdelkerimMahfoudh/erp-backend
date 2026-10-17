import { Prisma } from '@prisma/client';

/**
 * An in-memory stand-in for the messaging tables (0098), enough for the policy, the records, the email log and the
 * webhook worker to run for real in a unit test: equality, `in`, `lt`/`lte`/`gte`, `not: null`, `OR`, increments,
 * unique keys (P2002) and `skipDuplicates`. Nothing here talks to a database.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const value = row[key] ?? null;
    if (cond !== null && typeof cond === 'object' && !Buffer.isBuffer(cond) && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c && !(c.in as unknown[]).some((v) => same(v, value))) return false;
      if ('not' in c && (c.not === null ? value === null : same(value, c.not))) return false;
      if ('lt' in c && (value === null || compare(value, c.lt) >= 0)) return false;
      if ('lte' in c && (value === null || compare(value, c.lte) > 0)) return false;
      if ('gte' in c && (value === null || compare(value, c.gte) < 0)) return false;
      continue;
    }
    if (!same(value, cond)) return false;
  }
  return true;
}

function apply(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object' && 'increment' in (v as Row)) row[k] = ((row[k] as number) ?? 0) + ((v as { increment: number }).increment);
    else row[k] = v;
  }
}

function unique(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
}

class Table {
  rows: Row[] = [];
  /** Fail the next calls of these methods, to prove what happens when the database is unavailable. */
  failing = new Set<string>();

  constructor(
    private readonly uniques: string[] = [],
    private readonly defaults: () => Row = () => ({}),
  ) {}

  private check(method: string) {
    if (this.failing.has(method) || this.failing.has('*')) throw new Error('database unavailable');
  }

  private clashes(row: Row, except?: Row): boolean {
    return this.uniques.some((u) => row[u] != null && this.rows.some((r) => r !== except && same(r[u], row[u])));
  }

  create = jest.fn(async ({ data }: { data: Row }) => {
    this.check('create');
    const row = { ...this.defaults(), ...data };
    if (this.clashes(row)) throw unique();
    this.rows.push(row);
    return row;
  });

  createMany = jest.fn(async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
    this.check('createMany');
    let count = 0;
    for (const d of data) {
      const row = { ...this.defaults(), ...d };
      if (this.clashes(row)) {
        if (skipDuplicates) continue;
        throw unique();
      }
      this.rows.push(row);
      count += 1;
    }
    return { count };
  });

  findUnique = jest.fn(async ({ where }: { where: Where }) => {
    this.check('findUnique');
    return this.rows.find((r) => matches(r, where)) ?? null;
  });

  findFirst = jest.fn(async ({ where, orderBy }: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'> }) => {
    this.check('findFirst');
    return this.sorted(this.rows.filter((r) => matches(r, where)), orderBy)[0] ?? null;
  });

  findMany = jest.fn(async ({ where, orderBy, take }: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'>; take?: number }) => {
    this.check('findMany');
    return this.sorted(this.rows.filter((r) => matches(r, where)), orderBy).slice(0, take ?? Infinity);
  });

  count = jest.fn(async ({ where }: { where?: Where }) => {
    this.check('count');
    return this.rows.filter((r) => matches(r, where)).length;
  });

  update = jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
    this.check('update');
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw new Error('not found');
    apply(row, data);
    return row;
  });

  updateMany = jest.fn(async ({ where, data }: { where?: Where; data: Row }) => {
    this.check('updateMany');
    const hit = this.rows.filter((r) => matches(r, where));
    for (const r of hit) apply(r, data);
    return { count: hit.length };
  });

  upsert = jest.fn(async ({ where, create, update }: { where: Where; create: Row; update: Row }) => {
    this.check('upsert');
    const row = this.rows.find((r) => matches(r, where));
    if (row) {
      apply(row, update);
      return row;
    }
    const fresh = { ...this.defaults(), ...create };
    this.rows.push(fresh);
    return fresh;
  });

  deleteMany = jest.fn(async ({ where }: { where?: Where }) => {
    this.check('deleteMany');
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return { count: before - this.rows.length };
  });

  private sorted(rows: Row[], orderBy?: Record<string, 'asc' | 'desc'>): Row[] {
    if (!orderBy) return rows;
    const [[key, dir]] = Object.entries(orderBy);
    return [...rows].sort((a, b) => compare(a[key], b[key]) * (dir === 'desc' ? -1 : 1));
  }
}

let clock = 0;
/** Strictly increasing instants, so "latest" is unambiguous inside one millisecond. */
const tick = () => new Date(Date.now() + clock++);

export function fakeMessagingPrisma() {
  const tables = {
    whatsAppMessage: new Table(['idempotencyKey', 'providerMessageId'], () => ({ attempts: 0, createdAt: tick(), statusAt: tick() })),
    whatsAppWebhookEvent: new Table(['dedupeKey'], () => ({ state: 'pending', attempts: 0, nextAttemptAt: new Date(0), receivedAt: tick(), claimToken: null, claimedUntil: null })),
    whatsAppContact: new Table(['numberHash'], () => ({ optOutScope: 'none', optOutAt: null, optOutSource: null, lastInboundAt: null, undeliverableAt: null, createdAt: tick() })),
    whatsAppConsent: new Table([], () => ({ createdAt: tick() })),
    emailMessage: new Table(['idempotencyKey'], () => ({ attempts: 0, createdAt: tick() })),
    otpChallenge: new Table(),
    messagingDeliveryProof: new Table(),
    auditLog: new Table(),
  };
  return Object.assign(tables, {
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(tables)),
  });
}

export type FakeMessagingPrisma = ReturnType<typeof fakeMessagingPrisma>;
