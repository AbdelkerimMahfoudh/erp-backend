import { Prisma } from '@prisma/client';
import { BillingService } from '../../billing/billing.service';
import { EntitlementService } from '../../entitlement/entitlement.service';
import { StaffInvitationService } from '../../staff/staff-invitation.service';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import type { Activity } from '../../entitlement/activity';
import { PlatformAuditService } from '../platform-audit.service';
import { SeatAllocationService } from '../seat-allocation.service';
import { StaffActivationService } from '../staff-activation.service';
import { SubscriptionLifecycleService } from '../subscription-lifecycle.service';
import { TrialService } from '../trial/trial.service';
import { TrialEndRoll } from '../trial/trial-end-roll';
import { TrialEndSweeper } from '../trial/trial-end.sweeper';
import { TRIAL_TERMS_VERSION } from '../trial/trial-rules';
import { evaluationColumnsOf, isEvaluationRead } from '../../entitlement/__testing__/evaluation-columns';

/**
 * Several businesses, their stores, people, subscriptions, billing periods, payments, seat and store requests and
 * free trial rows, held in memory — with the REAL `BillingService`, `SubscriptionRenewal`, `SeatAllocationService`,
 * `SubscriptionLifecycleService`, `StaffActivationService`, `StaffInvitationService`, `TrialService`, `TrialEndRoll`,
 * `TrialEndSweeper` and `EntitlementService` running on top (D176, the add-ons of a free trial).
 *
 * The narrower worlds (billing-world, trial-world) each see one side: billing without trials, trials without money.
 * The add-on rules live where the two meet — a store paid for during a trial, put in force when it ends, raising the
 * first paid period once — so this world holds both, and a spec says what the shop was actually charged.
 *
 * What a database does that these rules lean on is reproduced, generically:
 *
 *  - **Prisma's reads** — `where` with equality, `in`, `notIn`, `not`, `lt`/`lte`/`gt`/`gte`, `OR`/`AND`/`NOT`, and
 *    relation filters (`is`-style objects, `some`/`none`/`every`); `select`/`include` through the relations the
 *    services read; `orderBy` on several keys (NULL first in ascending order and last in descending, as MySQL, or
 *    where `{ sort, nulls }` puts it); `take`, `distinct`. An unsupported filter throws loudly, so a changed query
 *    cannot pass here by accident.
 *  - **the keys and the CHECK** — one store name per company, one claim and one eligibility per company, the two keys
 *    of `branch_replacements`, and 0097's `ck_seat_alloc_scheduled`, each refusing as MySQL would;
 *  - **the census SQL** — the staff and held-seat queries of `seat-census.ts`, computed from the tables;
 *  - **the subscription row's lock** — `FOR UPDATE` waits while a test holds a company's row, `FOR UPDATE NOWAIT`
 *    fails at once with the P2010 / 3572 Prisma gives on MySQL;
 *  - **the other rows the trial's end takes with NOWAIT** (N1) — a business, a claim, a period, a store, a request,
 *    a person, a role — fail the same way while a test holds the row as another connection would (exclusively, or
 *    shared: a shared hold refuses only an exclusive NOWAIT, as InnoDB's lock modes do);
 *  - **one transaction at a time, all or nothing** — `$transaction` runs its callbacks in turn (what the subscription
 *    lock gives every path that takes it), each on its own client; a callback that throws undoes exactly what it
 *    wrote through that client, newest first, while a write made outside it in the meantime (an autocommitted
 *    statement on another connection: a refusal, an Owner's seat request) stands — as InnoDB would leave it;
 *  - **the clock** — one mutable instant for every service.
 */

type Row = Record<string, any>;

interface Rel {
  model: string;
  one: boolean;
  local: string;
  foreign: string;
}

/** The relations the services read through, by model. */
const REL: Record<string, Record<string, Rel>> = {
  company: {
    subscription: { model: 'subscription', one: true, local: 'id', foreign: 'companyId' },
    trialEligibility: { model: 'trialEligibility', one: true, local: 'id', foreign: 'companyId' },
    trialClaim: { model: 'trialClaim', one: true, local: 'id', foreign: 'companyId' },
    branches: { model: 'branch', one: false, local: 'id', foreign: 'companyId' },
    users: { model: 'user', one: false, local: 'id', foreign: 'companyId' },
  },
  subscription: { company: { model: 'company', one: true, local: 'companyId', foreign: 'id' } },
  seatAllocation: {
    branch: { model: 'branch', one: true, local: 'branchId', foreign: 'id' },
    replaces: { model: 'branch', one: true, local: 'replacesBranchId', foreign: 'id' },
    user: { model: 'user', one: true, local: 'userId', foreign: 'id' },
    payment: { model: 'subscriptionPayment', one: true, local: 'paymentId', foreign: 'id' },
    company: { model: 'company', one: true, local: 'companyId', foreign: 'id' },
  },
  user: {
    userBranches: { model: 'userBranch', one: false, local: 'id', foreign: 'userId' },
    seatAllocations: { model: 'seatAllocation', one: false, local: 'id', foreign: 'userId' },
    company: { model: 'company', one: true, local: 'companyId', foreign: 'id' },
  },
  userBranch: {
    role: { model: 'role', one: true, local: 'roleId', foreign: 'id' },
    user: { model: 'user', one: true, local: 'userId', foreign: 'id' },
    branch: { model: 'branch', one: true, local: 'branchId', foreign: 'id' },
  },
};

const MODELS = [
  'company',
  'subscription',
  'branch',
  'role',
  'user',
  'userBranch',
  'seatAllocation',
  'subscriptionPayment',
  'billingPeriod',
  'planVersion',
  'branchReplacement',
  'trialClaim',
  'trialEligibility',
  'trialSetupLink',
  'subscriptionEvent',
  'platformAuditEvent',
  'graceEpisode',
] as const;
type Model = (typeof MODELS)[number];
type Tables = Record<Model, Row[]>;
/** One write a transaction made: the row it replaced (null for an insert) and the row it wrote. */
interface Undo {
  model: Model;
  before: Row | null;
  after: Row;
}

/** What a created row holds before its data, per model: the columns' defaults. */
function defaultsOf(model: Model, now: Date): Row {
  switch (model) {
    case 'company':
      return { isActive: true, closedAt: null, timezone: 'UTC', createdAt: now };
    case 'branch':
      return { type: 'store', activity: 'electronics', activityNext: null, activityChangedAt: null, isActive: true, deletedAt: null, phone: null, address: null, createdAt: now };
    case 'user':
      return { email: null, phone: null, emailVerifiedAt: null, phoneVerifiedAt: null, invitedAt: null, activatedAt: null, isActive: true, deletedAt: null, lastLoginAt: null, createdAt: now };
    case 'seatAllocation':
      return {
        branchId: null,
        userId: null,
        status: 'pending_payment',
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
        effectiveAt: null,
        closedAt: null,
        closedBy: null,
        reason: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
    case 'subscriptionPayment':
      return { currency: 'MRU', channel: 'manual', reference: null, note: null, confirmedBy: null, confirmedAt: null, reversesId: null, createdAt: now };
    case 'billingPeriod':
      return { currency: 'MRU', assessedActivityFeeByBranch: null, createdAt: now, updatedAt: now };
    case 'subscriptionEvent':
      return { note: null, periodEndAfter: null, branchesAfter: null, seatsAfter: null, createdAt: now };
    case 'platformAuditEvent':
      return { adminId: null, reason: null, beforeJson: null, afterJson: null, ip: null, targetId: null, targetLabel: null, createdAt: now };
    case 'trialClaim':
      return { expiryRecordedAt: null, setupLinkId: null, createdAt: now };
    case 'trialEligibility':
      return { closedAt: null, closedReason: null, basis: 'self_registration', createdAt: now };
    case 'trialSetupLink':
      return { consumedAt: null, revokedAt: null, revokedReason: null, createdAt: now };
    default:
      return { createdAt: now };
  }
}

export function same(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const an = a === undefined || a === null;
  const bn = b === undefined || b === null;
  if (an || bn) return an && bn ? 0 : an ? -1 : 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return Buffer.compare(a, b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const isOperatorObject = (v: unknown): v is Row =>
  v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date) && !(v instanceof Prisma.Decimal) && !Array.isArray(v);

const OPERATORS = new Set(['equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte']);

function fieldMatches(have: unknown, cond: unknown, where: string): boolean {
  if (cond === undefined) return true;
  if (!isOperatorObject(cond)) return same(have, cond);
  for (const [op, v] of Object.entries(cond)) {
    if (!OPERATORS.has(op)) throw new Error(`trial-billing-world: unsupported filter ${op} on ${where}`);
    if (v === undefined) continue;
    const isNull = have === undefined || have === null;
    switch (op) {
      case 'equals':
        if (!same(have, v)) return false;
        break;
      case 'in':
        if (!(v as unknown[]).some((x) => same(have, x))) return false;
        break;
      case 'notIn':
        if (isNull || (v as unknown[]).some((x) => same(have, x))) return false;
        break;
      case 'not':
        if (isOperatorObject(v)) {
          if (fieldMatches(have, v, where)) return false;
        } else if (v === null) {
          if (isNull) return false;
        } else if (isNull || same(have, v)) {
          // SQL: `col <> x` is not true for a NULL column.
          return false;
        }
        break;
      default: {
        if (isNull) return false;
        const c = compare(have, v);
        if ((op === 'lt' && !(c < 0)) || (op === 'lte' && !(c <= 0)) || (op === 'gt' && !(c > 0)) || (op === 'gte' && !(c >= 0))) return false;
      }
    }
  }
  return true;
}

const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);
/** Writable fields only: Prisma drops `undefined`. */
const defined = (data: Row): Row => Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

function lockBusy(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Raw query failed. Code: `3572`. Message: `Statement aborted because lock(s) could not be acquired immediately and NOWAIT is set.`',
    { code: 'P2010', clientVersion: 'test', meta: { code: '3572', message: 'Statement aborted because lock(s) could not be acquired immediately and NOWAIT is set.' } },
  );
}
function duplicate(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target } });
}
function notFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record to update not found.', { code: 'P2025', clientVersion: 'test' });
}

/** The unique keys MySQL would refuse a duplicate of, per model. */
const UNIQUE: Partial<Record<Model, string[][]>> = {
  subscription: [['companyId']],
  branch: [['companyId', 'name']],
  trialClaim: [['companyId']],
  trialEligibility: [['companyId']],
  branchReplacement: [['billingPeriodId', 'archivedBranchId'], ['replacementBranchId']],
};

/** 0097's CHECK: a scheduled request has its start, and is a seat or a store. */
function checkRow(model: Model, row: Row): void {
  if (model === 'seatAllocation' && row.status === 'scheduled' && (row.effectiveAt === null || row.effectiveAt === undefined || !['seat', 'store'].includes(row.kind))) {
    throw new Error("Check constraint 'ck_seat_alloc_scheduled' is violated.");
  }
}

export const ADMIN = { id: newUuidV7Bin(), email: 'ops@example.test', name: 'Ops' };
export const CTX = { admin: ADMIN, ip: '127.0.0.1' };
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export interface WorldOptions {
  now?: Date;
  /** Plan versions in force from the given instants (the first is version 1). Default: 500 / 300 / 700, seat 100. */
  plans?: { effectiveFrom: Date; branchMonthly?: number; agentMonthly?: number; bothMonthly?: number; extraStaffMonthly?: number }[];
}

export interface BusinessOptions {
  name?: string;
  timezone?: string;
  stores?: { name: string; activity?: Activity }[];
  status?: 'pending_activation' | 'activated' | 'suspended' | 'cancelled' | 'rejected';
  /** Registered itself: an open trial eligibility (the default). */
  eligible?: boolean;
}

export interface Business {
  companyId: Buffer;
  ownerId: Buffer;
  subscriptionId: Buffer;
  name: string;
  stores: Record<string, Buffer>;
  roles: { owner: Buffer; employee: Buffer };
}

export function makeTrialBillingWorld(opts: WorldOptions = {}) {
  let now = opts.now ?? new Date('2026-10-14T09:30:00.123Z');
  const clock = { now: () => now };
  const t = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Tables;
  const plans = opts.plans ?? [{ effectiveFrom: new Date('2026-01-01T00:00:00.000Z') }];
  plans.forEach((p, i) =>
    t.planVersion.push({
      id: Buffer.alloc(16, 0x30 + i),
      planKey: 'standard',
      version: i + 1,
      branchMonthly: p.branchMonthly ?? 500,
      agentMonthly: p.agentMonthly ?? 300,
      bothMonthly: p.bothMonthly ?? 700,
      includedStaffPerBranch: 1,
      extraStaffMonthly: p.extraStaffMonthly ?? 100,
      effectiveFrom: p.effectiveFrom,
      createdBy: 'test',
      reason: `v${i + 1}`,
    }),
  );

  // ── the locks ─────────────────────────────────────────────────────────────
  /** Companies whose subscription row a test holds, as another connection would. */
  const held = new Map<string, { released: Promise<void>; release: () => void }>();
  /** Every subscription lock asked for, in order. */
  const locks: { company: string; nowait: boolean; outcome: 'taken' | 'busy' | 'waited' }[] = [];
  /** Other rows a test holds as another connection would, by `table:id`, and how (N1). */
  const heldRows = new Map<string, 'update' | 'share'>();
  /** Every other row taken with NOWAIT, in order (N1). */
  const rowLocks: { table: string; id: string; mode: 'update' | 'share'; outcome: 'taken' | 'busy' }[] = [];
  /** Every transaction's options, in order. */
  const txOptions: unknown[] = [];
  const hooks = {
    /** Runs after an event row is written, with whether a transaction was open. */
    onEvent: null as null | ((data: Row, inTransaction: boolean) => Promise<void> | void),
    /** Runs when a subscription lock is asked for, before it is granted. */
    onLock: null as null | ((company: string, nowait: boolean) => Promise<void> | void),
    /** Throws from inside the next `openStoreTx`-style branch creation: a failure injected into an activation. */
    failBranchCreate: 0,
  };

  // ── the generic delegate ──────────────────────────────────────────────────
  function related(model: string, row: Row, key: string): Row | Row[] | null {
    const rel = REL[model]?.[key];
    if (!rel) throw new Error(`trial-billing-world: no relation ${model}.${key}`);
    const rows = t[rel.model as Model];
    if (rel.one) return rows.find((r) => same(r[rel.foreign], row[rel.local])) ?? null;
    return rows.filter((r) => same(r[rel.foreign], row[rel.local]));
  }

  function matches(model: string, row: Row, where: Row | undefined): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (cond === undefined) continue;
      if (key === 'OR') {
        if (!asArray(cond as Row[]).some((w) => matches(model, row, w))) return false;
        continue;
      }
      if (key === 'AND') {
        if (!asArray(cond as Row[]).every((w) => matches(model, row, w))) return false;
        continue;
      }
      if (key === 'NOT') {
        if (asArray(cond as Row[]).some((w) => matches(model, row, w))) return false;
        continue;
      }
      const rel = REL[model]?.[key];
      if (rel) {
        if (rel.one) {
          const r = related(model, row, key) as Row | null;
          if (cond === null) {
            if (r) return false;
          } else if (isOperatorObject(cond) && ('is' in cond || 'isNot' in cond)) {
            if ('is' in cond && (cond.is === null ? r !== null : !r || !matches(rel.model, r, cond.is))) return false;
            if ('isNot' in cond && (cond.isNot === null ? r === null : !!r && matches(rel.model, r, cond.isNot))) return false;
          } else if (!r || !matches(rel.model, r, cond as Row)) {
            return false;
          }
        } else {
          const rs = related(model, row, key) as Row[];
          const c = cond as Row;
          if (c.some && !rs.some((r) => matches(rel.model, r, c.some))) return false;
          if (c.none && rs.some((r) => matches(rel.model, r, c.none))) return false;
          if (c.every && !rs.every((r) => matches(rel.model, r, c.every))) return false;
        }
        continue;
      }
      if (!fieldMatches(row[key], cond, `${model}.${key}`)) return false;
    }
    return true;
  }

  function project(model: string, row: Row, args: Row | undefined): Row {
    const relationValue = (key: string, spec: unknown): unknown => {
      const rel = REL[model]?.[key];
      if (!rel) throw new Error(`trial-billing-world: no relation ${model}.${key}`);
      const sub = (spec === true ? {} : spec) as Row;
      if (rel.one) {
        const r = related(model, row, key) as Row | null;
        return r ? project(rel.model, r, sub) : null;
      }
      return query(rel.model as Model, related(model, row, key) as Row[], sub).map((r) => project(rel.model, r, sub));
    };
    if (args?.select) {
      const out: Row = {};
      for (const [k, v] of Object.entries(args.select as Row)) {
        if (!v) continue;
        out[k] = REL[model]?.[k] ? relationValue(k, v) : (row[k] ?? null);
      }
      return out;
    }
    const out: Row = { ...row };
    for (const [k, v] of Object.entries((args?.include as Row) ?? {})) if (v) out[k] = relationValue(k, v);
    return out;
  }

  /** Filter, order, page and de-duplicate rows of one model as Prisma would. */
  function query(model: Model, rows: Row[], args: Row = {}): Row[] {
    let out = rows.filter((r) => matches(model, r, args.where));
    if (args.orderBy) {
      const keys = asArray(args.orderBy as Row).map((o) => {
        const [k, spec] = Object.entries(o)[0] as [string, 'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls?: 'first' | 'last' }];
        return typeof spec === 'string' ? { k, dir: spec, nulls: undefined } : { k, dir: spec.sort, nulls: spec.nulls };
      });
      const isNull = (v: unknown) => v === null || v === undefined;
      out = out
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          for (const { k, dir, nulls } of keys) {
            const [x, y] = [a.row[k], b.row[k]];
            if (nulls && isNull(x) !== isNull(y)) return isNull(x) === (nulls === 'first') ? -1 : 1;
            const c = compare(x, y);
            if (c !== 0) return dir === 'desc' ? -c : c;
          }
          return a.index - b.index;
        })
        .map(({ row }) => row);
    }
    if (args.distinct) {
      const seen = new Set<string>();
      out = out.filter((r) => {
        const k = (args.distinct as string[]).map((f) => (Buffer.isBuffer(r[f]) ? r[f].toString('hex') : String(r[f]))).join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (typeof args.skip === 'number') out = out.slice(args.skip);
    if (typeof args.take === 'number') out = out.slice(0, args.take);
    return out;
  }

  function applyData(row: Row, data: Row): Row {
    const next: Row = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isOperatorObject(v) && ('increment' in v || 'decrement' in v || 'set' in v)) {
        if ('increment' in v) next[k] = (next[k] ?? 0) + v.increment;
        if ('decrement' in v) next[k] = (next[k] ?? 0) - v.decrement;
        if ('set' in v) next[k] = v.set;
      } else {
        next[k] = v;
      }
    }
    return next;
  }

  function assertUnique(model: Model, row: Row, except: Row | null): void {
    for (const key of UNIQUE[model] ?? []) {
      const clash = t[model].some((r) => r !== except && key.every((f) => same(r[f], row[f])));
      if (clash) throw duplicate(`${model}:${key.join(',')}`);
    }
  }

  /**
   * One model's delegate. `undo`, for a transaction's client: every row it inserts or replaces is noted, so a
   * rollback takes back this transaction's writes and nobody else's.
   */
  function delegate(model: Model, undo: Undo[] | null = null): Row {
    return {
      findFirst: async (args: Row = {}) => {
        const r = query(model, t[model], args)[0];
        return r ? project(model, r, args) : null;
      },
      findFirstOrThrow: async (args: Row = {}) => {
        const r = query(model, t[model], args)[0];
        if (!r) throw notFound();
        return project(model, r, args);
      },
      findUnique: async (args: Row) => {
        const r = t[model].find((x) => matches(model, x, args.where));
        return r ? project(model, r, args) : null;
      },
      findUniqueOrThrow: async (args: Row) => {
        const r = t[model].find((x) => matches(model, x, args.where));
        if (!r) throw notFound();
        return project(model, r, args);
      },
      findMany: async (args: Row = {}) => query(model, t[model], args).map((r) => project(model, r, args)),
      count: async (args: Row = {}) => query(model, t[model], { where: args.where }).length,
      create: async (args: Row) => {
        if (model === 'branch' && hooks.failBranchCreate > 0) {
          hooks.failBranchCreate -= 1;
          throw new Error('injected: the branch could not be created');
        }
        const row = { ...defaultsOf(model, now), ...defined(args.data) };
        checkRow(model, row);
        assertUnique(model, row, null);
        t[model].push(row);
        undo?.push({ model, before: null, after: row });
        if (model === 'subscriptionEvent' && hooks.onEvent) await hooks.onEvent(row, undo !== null);
        return project(model, row, args);
      },
      update: async (args: Row) => {
        const index = t[model].findIndex((x) => matches(model, x, args.where));
        if (index < 0) throw notFound();
        const next = applyData(t[model][index], defined(args.data));
        if ('updatedAt' in next) next.updatedAt = now;
        checkRow(model, next);
        assertUnique(model, next, t[model][index]);
        undo?.push({ model, before: t[model][index], after: next });
        t[model][index] = next;
        return project(model, next, args);
      },
      updateMany: async (args: Row) => {
        const hits = t[model].map((r, i) => ({ r, i })).filter(({ r }) => matches(model, r, args.where));
        const nexts = hits.map(({ r }) => {
          const next = applyData(r, defined(args.data));
          if ('updatedAt' in next) next.updatedAt = now;
          checkRow(model, next);
          return next;
        });
        hits.forEach(({ r, i }, k) => {
          undo?.push({ model, before: r, after: nexts[k] });
          t[model][i] = nexts[k];
        });
        return { count: hits.length };
      },
    };
  }

  /** Take back one transaction's writes, newest first: each inserted row removed, each replaced row put back. */
  function rollBack(undo: Undo[]): void {
    for (const { model, before, after } of [...undo].reverse()) {
      const index = t[model].indexOf(after);
      if (index < 0) continue;
      if (before === null) t[model].splice(index, 1);
      else t[model][index] = before;
    }
  }

  // ── raw SQL: the locks, the census, the read-back ────────────────────────
  async function lock(companyId: Buffer, nowait: boolean): Promise<Row[]> {
    const company = binToUuid(companyId);
    await hooks.onLock?.(company, nowait);
    const h = held.get(company);
    if (h && nowait) {
      locks.push({ company, nowait, outcome: 'busy' });
      throw lockBusy();
    }
    if (h) {
      locks.push({ company, nowait, outcome: 'waited' });
      await h.released;
    } else {
      locks.push({ company, nowait, outcome: 'taken' });
    }
    const sub = t.subscription.find((s) => same(s.companyId, companyId));
    return sub ? [{ id: sub.id }] : [];
  }

  /** `SELECT id FROM <table> WHERE id = ? FOR UPDATE|SHARE NOWAIT`: taken, or refused at once while held. */
  function rowLock(table: string, id: Buffer, mode: 'update' | 'share'): Row[] {
    const held = heldRows.get(`${table}:${binToUuid(id)}`);
    const busy = held !== undefined && (held === 'update' || mode === 'update');
    rowLocks.push({ table, id: binToUuid(id), mode, outcome: busy ? 'busy' : 'taken' });
    if (busy) throw lockBusy();
    return [{ id }];
  }

  async function queryRaw(q: unknown, ...rest: unknown[]): Promise<Row[]> {
    const strings: readonly string[] = Array.isArray(q) ? (q as readonly string[]) : ((q as { strings: readonly string[] }).strings ?? []);
    const values: unknown[] = Array.isArray(q) ? rest : ((q as { values: unknown[] }).values ?? []);
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    if (isEvaluationRead(strings)) {
      // The entitlement evaluation's one statement (R1-F4): the subscription, its company and its two trial rows.
      const companyId = values[0] as Buffer;
      const sub = t.subscription.find((x) => same(x.companyId, companyId));
      const company = sub ? t.company.find((c) => same(c.id, companyId)) : undefined;
      if (!sub || !company) return [];
      const eligibility = t.trialEligibility.find((e) => same(e.companyId, companyId)) ?? null;
      const claim = t.trialClaim.find((c) => same(c.companyId, companyId)) ?? null;
      return [evaluationColumnsOf(sub as never, company as never, eligibility as never, claim as never)];
    }
    if (/^SELECT id FROM subscriptions WHERE company_id = \? FOR UPDATE NOWAIT$/.test(text)) return lock(values[0] as Buffer, true);
    if (/^SELECT id FROM subscriptions WHERE company_id = \? FOR UPDATE$/.test(text)) return lock(values[0] as Buffer, false);
    const row = /^SELECT id FROM (companies|trial_claims|billing_periods|branches|seat_allocations|users|roles) WHERE id = \? FOR (UPDATE|SHARE) NOWAIT$/.exec(text);
    if (row) return rowLock(row[1], values[0] as Buffer, row[2] === 'SHARE' ? 'share' : 'update');
    if (/^SELECT id FROM branches WHERE id = \? AND company_id = \? FOR UPDATE$/.test(text)) return [];
    if (text.includes('COUNT(DISTINCT u.id)')) {
      const companyId = values[0] as Buffer;
      const by = new Map<string, Set<string>>();
      for (const u of t.user) {
        if (!same(u.companyId, companyId) || !u.isActive || u.deletedAt !== null) continue;
        for (const ub of t.userBranch.filter((x) => same(x.userId, u.id))) {
          const role = t.role.find((r) => same(r.id, ub.roleId));
          if (role?.key === 'owner') continue;
          const k = (ub.branchId as Buffer).toString('hex').toUpperCase();
          if (!by.has(k)) by.set(k, new Set());
          by.get(k)!.add(binToUuid(u.id));
        }
      }
      return [...by.entries()].map(([branch_hex, set]) => ({ branch_hex, n: BigInt(set.size) }));
    }
    if (/FROM seat_allocations WHERE company_id = \? AND kind = 'seat' AND branch_id IS NOT NULL AND status IN \('paid', 'granted'\) GROUP BY branch_id, status/.test(text)) {
      const companyId = values[0] as Buffer;
      const by = new Map<string, number>();
      for (const a of t.seatAllocation) {
        if (!same(a.companyId, companyId) || a.kind !== 'seat' || !a.branchId || !['paid', 'granted'].includes(a.status)) continue;
        const k = `${(a.branchId as Buffer).toString('hex').toUpperCase()}|${a.status}`;
        by.set(k, (by.get(k) ?? 0) + 1);
      }
      return [...by.entries()].map(([k, n]) => ({ branch_hex: k.split('|')[0], status: k.split('|')[1], n: BigInt(n) }));
    }
    if (/^SELECT status, effective_at, payment_id FROM seat_allocations WHERE id = \?$/.test(text)) {
      const r = t.seatAllocation.find((a) => same(a.id, values[0]));
      return r ? [{ status: r.status, effective_at: r.effectiveAt, payment_id: r.paymentId }] : [];
    }
    if (
      text ===
      "SELECT DISTINCT sa.company_id FROM seat_allocations sa JOIN companies c ON c.id = sa.company_id WHERE sa.status = 'scheduled' AND sa.effective_at <= ? AND c.closed_at IS NULL AND EXISTS ( SELECT 1 FROM billing_periods bp WHERE bp.company_id = sa.company_id AND bp.period_start <= ? AND (bp.period_end IS NULL OR bp.period_end > ?) ) LIMIT 200"
    ) {
      // The sweeper's: scheduled and due, in an open company with a paid period in force.
      const [due, start, end] = values as Date[];
      const inForce = (companyId: Buffer) =>
        t.billingPeriod.some(
          (p) => same(p.companyId, companyId) && p.periodStart.getTime() <= start.getTime() && (p.periodEnd === null || p.periodEnd.getTime() > end.getTime()),
        );
      const seen = new Map<string, Buffer>();
      for (const a of t.seatAllocation) {
        if (a.status !== 'scheduled' || !a.effectiveAt || a.effectiveAt.getTime() > due.getTime()) continue;
        const company = t.company.find((c) => same(c.id, a.companyId));
        if (company && company.closedAt === null && inForce(a.companyId)) seen.set(a.companyId.toString('hex'), a.companyId);
      }
      return [...seen.values()].slice(0, 200).map((company_id) => ({ company_id }));
    }
    if (/^SELECT company_id FROM trial_claims WHERE expiry_recorded_at IS NULL AND ends_at <= \? LIMIT 200$/.test(text)) {
      const at = values[0] as Date;
      return t.trialClaim
        .filter((c) => c.expiryRecordedAt === null && c.endsAt.getTime() <= at.getTime())
        .slice(0, 200)
        .map((c) => ({ company_id: c.companyId }));
    }
    throw new Error(`trial-billing-world: unexpected raw query "${text}"`);
  }

  const db: Row = Object.fromEntries(MODELS.map((m) => [m, delegate(m)]));
  db.$queryRaw = queryRaw;

  let queue: Promise<unknown> = Promise.resolve();
  db.$transaction = async (fn: (tx: Row) => Promise<unknown>, options?: unknown) => {
    txOptions.push(options ?? null);
    const run = queue.then(async () => {
      // Its own client, as Prisma's interactive transaction is: what it writes is noted, to be taken back on a throw.
      const undo: Undo[] = [];
      const tx: Row = Object.fromEntries(MODELS.map((m) => [m, delegate(m, undo)]));
      tx.$queryRaw = queryRaw;
      try {
        return await fn(tx);
      } catch (e) {
        rollBack(undo);
        throw e;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  // ── the services ──────────────────────────────────────────────────────────
  const billing = new BillingService(db as never, clock);
  const audit = new PlatformAuditService(db as never);
  const tenantAudit = { recordTx: async () => undefined };
  const seats = new SeatAllocationService(db as never, audit, billing, clock, tenantAudit as never);
  const lifecycle = new SubscriptionLifecycleService(db as never, audit, billing, clock);
  const activation = new StaffActivationService(db as never, seats, clock);
  const entitlement = new EntitlementService(db as never, {} as never, clock);
  const trialEnd = new TrialEndRoll(db as never, clock);
  const sweeper = new TrialEndSweeper(db as never, clock);
  const trial = new TrialService(db as never, entitlement, audit, { otpPepper: 'test-pepper-at-least-32-characters-long!!' } as never, {} as never, clock);

  // ── the fixtures ──────────────────────────────────────────────────────────
  let counter = 0;
  function business(o: BusinessOptions = {}): Business {
    counter += 1;
    const companyId = newUuidV7Bin();
    const subscriptionId = newUuidV7Bin();
    const ownerId = newUuidV7Bin();
    const roles = { owner: newUuidV7Bin(), employee: newUuidV7Bin() };
    const name = o.name ?? `Shop ${counter}`;
    const created = new Date(now.getTime() - 7 * DAY);
    t.company.push({ id: companyId, name, publicStoreId: `TB${String(counter).padStart(8, '0')}`, timezone: o.timezone ?? 'Africa/Casablanca', isActive: true, closedAt: null, createdAt: created });
    t.role.push({ id: roles.owner, companyId, key: 'owner', name: 'Owner' }, { id: roles.employee, companyId, key: 'store_employee', name: 'Employee' });
    t.user.push({
      ...defaultsOf('user', created),
      id: ownerId,
      companyId,
      name: `Owner ${counter}`,
      email: `owner${counter}@shop.test`,
      emailVerifiedAt: created,
      passwordHash: 'x',
    });
    const stores: Record<string, Buffer> = {};
    (o.stores ?? [{ name: 'Main', activity: 'electronics' }]).forEach((s, i) => {
      const id = newUuidV7Bin();
      stores[s.name] = id;
      t.branch.push({ ...defaultsOf('branch', new Date(created.getTime() + i)), id, companyId, name: s.name, activity: s.activity ?? 'electronics' });
      t.userBranch.push({ id: newUuidV7Bin(), companyId, userId: ownerId, branchId: id, roleId: roles.owner });
    });
    t.subscription.push({
      id: subscriptionId,
      companyId,
      status: o.status ?? 'pending_activation',
      currentPeriodEnd: null,
      isComplimentary: false,
      complimentaryReason: null,
      complimentaryUntil: null,
      subscribedBranchCount: Object.keys(stores).length,
      additionalSeats: 0,
      version: 1,
    });
    if (o.eligible ?? true) {
      t.trialEligibility.push({ ...defaultsOf('trialEligibility', created), id: newUuidV7Bin(), companyId, ownerUserId: ownerId, registrationMethod: 'email' });
    }
    return { companyId, ownerId, subscriptionId, name, stores, roles };
  }

  /** A person at the business: active (holding a seat now) or invited and pending, contacts verified or not. */
  function person(b: Business, o: { name: string; stores: string[]; active?: boolean; verified?: boolean; invitedAt?: Date }): Buffer {
    const id = newUuidV7Bin();
    const active = o.active ?? false;
    t.user.push({
      ...defaultsOf('user', now),
      id,
      companyId: b.companyId,
      name: o.name,
      email: `${o.name.toLowerCase()}.${binToUuid(id).slice(-6)}@shop.test`,
      emailVerifiedAt: active || o.verified ? now : null,
      isActive: active,
      invitedAt: o.invitedAt ?? now,
      activatedAt: active ? now : null,
      passwordHash: 'x',
    });
    for (const s of o.stores) t.userBranch.push({ id: newUuidV7Bin(), companyId: b.companyId, userId: id, branchId: b.stores[s], roleId: b.roles.employee });
    return id;
  }

  /**
   * The Owner's Team screen at a business: adding and withdrawing accounts. No message channel is configured, so no
   * code goes out (the person's proof is set on the row by the spec that needs it).
   */
  function staff(b: Business): StaffInvitationService {
    return new StaffInvitationService(
      db as never,
      { companyId: () => b.companyId, requireUserId: () => b.ownerId } as never,
      { recordTx: async () => undefined } as never,
      { hash: async () => 'x' } as never,
      { start: async () => ({ delivery: 'outbox' }) } as never,
      { canDeliver: () => false } as never,
      { peek: () => null } as never,
      entitlement,
      activation,
      seats,
    );
  }

  /**
   * The Owner closes the business (account deletion), as `AccountDeletionService.closeCompany` does to the tables this
   * world holds — the subscription row locked first, the people de-identified and deleted, every store deactivated,
   * the subscription cancelled, the trial eligibility closed and the company closed — in one transaction. The other
   * tables that closure blanks (customers, receipts, sessions, …) are not held here and decide nothing below.
   */
  async function closeCompany(b: Business): Promise<void> {
    await db.$transaction(async (tx: Row) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM subscriptions WHERE company_id = ${b.companyId} FOR UPDATE`);
      const at = now;
      await tx.user.updateMany({ where: { companyId: b.companyId, deletedAt: null }, data: { isActive: false, deletedAt: at, email: null, phone: null } });
      await tx.branch.updateMany({ where: { companyId: b.companyId }, data: { isActive: false } });
      const sub = await tx.subscription.findFirst({ where: { companyId: b.companyId } });
      if (sub && sub.status !== 'cancelled') {
        await tx.subscription.update({ where: { id: sub.id }, data: { status: 'cancelled', version: { increment: 1 } } });
        await tx.subscriptionEvent.create({
          data: { id: newUuidV7Bin(), companyId: b.companyId, subscriptionId: sub.id, kind: 'cancelled', note: 'Business closed by its Owner (account deletion)', actor: 'owner:account-deletion' },
        });
      }
      await tx.trialEligibility.updateMany({ where: { companyId: b.companyId, closedAt: null }, data: { closedAt: at, closedReason: 'cancelled' } });
      await tx.company.update({ where: { id: b.companyId }, data: { isActive: false, closedAt: at } });
    });
  }

  const of = <M extends Model>(model: M, b: Business) => t[model].filter((r) => same(r.companyId, b.companyId));
  const uuid = (id: Buffer) => binToUuid(id);

  return {
    db,
    t,
    clock: {
      now: () => now,
      set: (d: Date) => {
        now = d;
      },
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    },
    hooks,
    locks,
    rowLocks,
    txOptions,
    /**
     * Hold another row as another connection would (N1) — `companies`, `trial_claims`, `billing_periods`, `branches`,
     * `seat_allocations`, `users` or `roles`, by id, exclusively or shared — until the returned function is called.
     */
    holdRow(table: string, id: Buffer, mode: 'update' | 'share' = 'update'): () => void {
      const key = `${table}:${binToUuid(id)}`;
      heldRows.set(key, mode);
      return () => {
        heldRows.delete(key);
      };
    },
    /** Hold a company's subscription row as another connection would, until the returned function is called. */
    hold(b: Business): () => void {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const company = binToUuid(b.companyId);
      held.set(company, { released, release });
      return () => {
        held.delete(company);
        release();
      };
    },
    billing,
    audit,
    seats,
    lifecycle,
    activation,
    entitlement,
    trialEnd,
    sweeper,
    trial,
    business,
    person,
    staff,
    closeCompany,
    /** The Owner claims the trial on the website, now. */
    claim: (b: Business, key = `claim-${binToUuid(b.companyId)}`) =>
      trial.claim({ companyId: b.companyId, userId: b.ownerId }, { idempotencyKey: key, termsVersion: TRIAL_TERMS_VERSION }),
    /** The Super Admin confirms a payment of this amount for the request. */
    confirm: (requestId: string, amount: number | string, extra: { reference?: string; expectedVersion?: number } = {}) =>
      seats.confirmPayment(
        Buffer.from(requestId.replace(/-/g, ''), 'hex'),
        { amount: String(amount), paidAt: new Date(now.getTime() - 60_000), reference: extra.reference ?? 'BK-1', expectedVersion: extra.expectedVersion },
        CTX,
      ),
    company: (b: Business) => t.company.find((c) => same(c.id, b.companyId))!,
    subscription: (b: Business) => t.subscription.find((s) => same(s.companyId, b.companyId))!,
    claimOf: (b: Business) => t.trialClaim.find((c) => same(c.companyId, b.companyId)) ?? null,
    eligibility: (b: Business) => t.trialEligibility.find((c) => same(c.companyId, b.companyId)) ?? null,
    branches: (b: Business) => of('branch', b),
    branch: (b: Business, name: string) => of('branch', b).find((x) => x.name === name) ?? null,
    requests: (b: Business) => of('seatAllocation', b),
    request: (id: string) => t.seatAllocation.find((r) => binToUuid(r.id) === id)!,
    payments: (b: Business) => of('subscriptionPayment', b),
    /** Oldest first: the reverse of the order every reader takes them in (billing.service.ts `NEWEST_PERIOD_FIRST`). */
    periods: (b: Business) =>
      query('billingPeriod', of('billingPeriod', b), {
        orderBy: [{ periodStart: 'asc' }, { periodEnd: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      }),
    events: (b: Business, kind?: string) => of('subscriptionEvent', b).filter((e) => !kind || e.kind === kind),
    audits: (b: Business, action?: string) => t.platformAuditEvent.filter((a) => same(a.targetId, b.companyId) && (!action || a.action === action)),
    user: (id: Buffer) => t.user.find((u) => same(u.id, id))!,
    uuid,
  };
}

export type TrialBillingWorld = ReturnType<typeof makeTrialBillingWorld>;
