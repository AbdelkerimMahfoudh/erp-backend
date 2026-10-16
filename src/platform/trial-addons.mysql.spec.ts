import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AccountDeletionService } from '../account/account-deletion.service';
import { BillingService } from '../billing/billing.service';
import { SubscriptionRenewal } from '../billing/renewal';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { EntitlementService } from '../entitlement/entitlement.service';
import { PlatformAuditService } from './platform-audit.service';
import { SeatAllocationService } from './seat-allocation.service';
import { StaffActivationService } from './staff-activation.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { TrialEndRoll } from './trial/trial-end-roll';
import { TrialEndSweeper } from './trial/trial-end.sweeper';
import { TrialService } from './trial/trial.service';
import { TRIAL_DURATION_MS, TRIAL_TERMS_VERSION } from './trial/trial-rules';

/**
 * Additional stores and paid seats during the free trial (D176) on REAL MySQL — what an in-memory world cannot show:
 * InnoDB's locks (FOR UPDATE, NOWAIT, gap locks), true concurrency over a connection pool, 0097's CHECK, the census
 * and sweeper SQL as written, and DATETIME(6) instants.
 *
 * Env-gated, and skipped otherwise (CI runs `npx jest --ci` with no database): set ADDON_ROOT_URL (root: the
 * fixtures and the lock holders) and ADDON_APP_URL (phonestore_app: every service under test) to a DISPOSABLE
 * database at 0097, restored from a backup — both naming the same database, whose name starts with `addon_`. It
 * writes businesses, people, requests and payments, and never removes them: drop the database afterwards. A
 * recorded manual pre-merge gate (docs/22, docs/76).
 *
 * The services are constructed by hand over the application account with an injected clock, so the 168 h boundary is
 * crossed by setting the clock; the instants they store are the clock's, to the microsecond MySQL keeps.
 */

const ROOT_URL = process.env.ADDON_ROOT_URL ?? '';
const APP_URL = process.env.ADDON_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(600_000);

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Printed beside the results: how each race came out. */
const note = (line: string) => process.stdout.write(`[trial-addons.mysql] ${line}\n`);

/** One clock for every service of a "process": fixed at an instant, or running with real time from one. */
class TestClock {
  private fixed: Date | null = null;
  private from = 0;
  private base = 0;
  now = (): Date => (this.fixed ? new Date(this.fixed.getTime()) : new Date(this.from + (Date.now() - this.base)));
  set(at: Date): void {
    this.fixed = at;
  }
  /** From `at` on, moving with real time — to cross an instant while things run. */
  runFrom(at: Date): void {
    this.fixed = null;
    this.from = at.getTime();
    this.base = Date.now();
  }
}

let root: PrismaClient;
let app: PrismaClient;
const ADMIN = { id: newUuidV7Bin(), email: 'addons-mysql@example.test', name: 'Add-ons' };
const CTX = { admin: ADMIN, ip: '127.0.0.1' } as never;

/** Everything one API process would hold, over the application account. */
function servicesAt(clock: TestClock, client: PrismaClient = app) {
  const db = client as never;
  const audit = new PlatformAuditService(db);
  const billing = new BillingService(db, clock);
  const seats = new SeatAllocationService(db, audit, billing, clock, { recordTx: async () => undefined } as never);
  const lifecycle = new SubscriptionLifecycleService(db, audit, billing, clock);
  const activation = new StaffActivationService(db, seats, clock);
  const entitlement = new EntitlementService(db, {} as never, clock);
  const trialEnd = new TrialEndRoll(db, clock);
  const sweeper = new TrialEndSweeper(db, clock);
  const trial = new TrialService(db, entitlement, audit, { otpPepper: 'mysql-spec-pepper-at-least-32-characters' } as never, {} as never, clock);
  const renewal = new SubscriptionRenewal(db, billing, clock);
  return { audit, billing, seats, lifecycle, activation, entitlement, trialEnd, sweeper, trial, renewal, clock };
}
type Services = ReturnType<typeof servicesAt>;

// ── fixtures, as root ───────────────────────────────────────────────────────
let seq = 0;
const tag = () => {
  seq += 1;
  return `${Date.now().toString(36).slice(-5)}${seq.toString(36)}`.toUpperCase().slice(-9);
};
const personalId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.toUpperCase().slice(-10).padStart(10, '0');

interface Business {
  companyId: Buffer;
  id: string;
  ownerId: Buffer;
  stores: Record<string, Buffer>;
  roles: { owner: Buffer; employee: Buffer };
}

async function business(o: { stores?: string[]; timezone?: string } = {}): Promise<Business> {
  const t = tag();
  const companyId = newUuidV7Bin();
  const ownerId = newUuidV7Bin();
  const roles = { owner: newUuidV7Bin(), employee: newUuidV7Bin() };
  await root.company.create({ data: { id: companyId, name: `Add-ons ${t}`, publicStoreId: `AO${t}`, settingsJson: {}, timezone: o.timezone ?? 'Africa/Casablanca' } });
  await root.role.createMany({
    data: [
      { id: roles.owner, companyId, key: 'owner', name: 'Owner' },
      { id: roles.employee, companyId, key: 'store_employee', name: 'Employee' },
    ],
  });
  await root.user.create({
    data: { id: ownerId, companyId, name: 'Owner', login: `owner-${t.toLowerCase()}`, personalId: personalId(), email: `o${t.toLowerCase()}@example.test`, emailVerifiedAt: new Date(), passwordHash: 'x' },
  });
  const stores: Record<string, Buffer> = {};
  for (const name of o.stores ?? ['Main']) {
    const id = newUuidV7Bin();
    stores[name] = id;
    await root.branch.create({ data: { id, companyId, name } });
    await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId, userId: ownerId, branchId: id, roleId: roles.owner } });
  }
  await root.subscription.create({
    data: { id: newUuidV7Bin(), companyId, status: 'pending_activation', currentPeriodEnd: null, subscribedBranchCount: Object.keys(stores).length },
  });
  await root.trialEligibility.create({ data: { id: newUuidV7Bin(), companyId, ownerUserId: ownerId, registrationMethod: 'email' } });
  return { companyId, id: binToUuid(companyId), ownerId, stores, roles };
}

/** A person at the business: active (holding a seat now), or invited and pending with their contact proven. */
async function person(b: Business, o: { name: string; store: string; active?: boolean; invitedAt: Date }): Promise<Buffer> {
  const id = newUuidV7Bin();
  const t = tag().toLowerCase();
  await root.user.create({
    data: {
      id,
      companyId: b.companyId,
      name: o.name,
      login: `staff-${t}`,
      personalId: personalId(),
      email: `${o.name.toLowerCase()}.${t}@example.test`,
      emailVerifiedAt: o.invitedAt,
      passwordHash: 'x',
      isActive: o.active ?? false,
      invitedAt: o.invitedAt,
      activatedAt: o.active ? o.invitedAt : null,
    },
  });
  await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId: b.companyId, userId: id, branchId: b.stores[o.store], roleId: b.roles.employee } });
  return id;
}

const bin = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex');

/** The Owner claims the trial; the claim's end, as stored. */
async function claim(s: Services, b: Business, key = `claim-${b.id}`): Promise<Date> {
  await s.trial.claim({ companyId: b.companyId, userId: b.ownerId }, { idempotencyKey: key, termsVersion: TRIAL_TERMS_VERSION });
  const row = await root.trialClaim.findUniqueOrThrow({ where: { companyId: b.companyId } });
  return row.endsAt;
}

const confirm = (s: Services, requestId: string, amount: number, reference: string, expectedVersion?: number) =>
  s.seats.confirmPayment(bin(requestId), { amount: String(amount), paidAt: new Date(s.clock.now().getTime() - 60_000), reference, expectedVersion }, CTX);

const approve = (s: Services, b: Business) => s.lifecycle.approve(b.id, { months: 1, reason: 'paid by transfer' }, CTX);

/** What the business could be charged by, as stored. */
async function ledger(b: Business) {
  const [periods, payments, branches, requests, activations, expiries] = await Promise.all([
    root.billingPeriod.findMany({ where: { companyId: b.companyId }, orderBy: [{ periodStart: 'asc' }, { id: 'asc' }] }),
    root.subscriptionPayment.findMany({ where: { companyId: b.companyId }, orderBy: { id: 'asc' } }),
    root.branch.findMany({ where: { companyId: b.companyId }, orderBy: { createdAt: 'asc' } }),
    root.seatAllocation.findMany({ where: { companyId: b.companyId }, orderBy: { id: 'asc' } }),
    root.platformAuditEvent.findMany({ where: { targetId: b.companyId, action: { in: ['store.activate', 'seat.activate'] } } }),
    root.subscriptionEvent.count({ where: { companyId: b.companyId, kind: 'trial_expired' } }),
  ]);
  return {
    periods: periods.map((p) => ({ start: p.periodStart.toISOString(), total: p.assessedTotal, branchFee: p.assessedBranchFee, staffFee: p.assessedStaffFee, active: p.activeBranchCount })),
    payments: payments.map((p) => p.amount.toString()),
    branches: branches.map((x) => x.name),
    requests: requests.map((r) => ({ kind: r.kind, label: r.label, status: r.status, version: r.version, effectiveAt: r.effectiveAt?.toISOString() ?? null })),
    activations: activations.length,
    expiries,
  };
}

/** Hold rows from another connection (root) until released: `held` once the statement returned. */
function hold(sql: Prisma.Sql) {
  let release!: () => void;
  let held!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const isHeld = new Promise<void>((r) => (held = r));
  const done = root.$transaction(
    async (tx) => {
      await tx.$queryRaw(sql);
      held();
      await released;
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
  const ended = done.then(() => {
    throw new Error('the holder ended before it held');
  });
  // Observed here: only the race below reads it, and once the row is held it settles with nobody waiting.
  ended.catch(() => undefined);
  return { held: Promise.race([isHeld, ended]), release, done };
}

/** Whether a statement of another connection is waiting for a row lock on this table. */
async function waitingOn(table: string): Promise<boolean> {
  const [r] = await root.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM performance_schema.data_locks
     WHERE OBJECT_SCHEMA = DATABASE() AND OBJECT_NAME = ${table} AND LOCK_STATUS = 'WAITING'`;
  return Number(r.n) > 0;
}

async function until(what: string, condition: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const timed = async <T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> => {
  const start = process.hrtime.bigint();
  const value = await work();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, value };
};

const p2010Code = (e: unknown): string | null =>
  e instanceof Prisma.PrismaClientKnownRequestError ? String((e.meta as { code?: unknown } | undefined)?.code ?? '') : null;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

run('add-ons during the free trial, on real MySQL (D176)', () => {
  beforeAll(async () => {
    const name = (url: string) => new URL(url).pathname.replace(/^\//, '');
    if (name(ROOT_URL) !== name(APP_URL) || !/^addon_/.test(name(ROOT_URL))) {
      throw new Error(`refusing to run: both URLs must name one disposable database whose name starts with addon_ (got ${name(ROOT_URL)} / ${name(APP_URL)})`);
    }
    root = new PrismaClient({ datasourceUrl: ROOT_URL });
    app = new PrismaClient({ datasourceUrl: APP_URL });
    const [who] = await app.$queryRaw<{ u: string }[]>`SELECT CURRENT_USER() AS u`;
    expect(who.u).toBe('phonestore_app@127.0.0.1');
    const [applied] = await root.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM _prisma_migrations WHERE migration_name = '0097_scheduled_addons' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(Number(applied.n)).toBe(1);
    const [check] = await root.$queryRaw<{ clause: string }[]>`
      SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'ck_seat_alloc_scheduled'`;
    note(`database ${name(ROOT_URL)} at 0097; services as ${who.u}; CHECK ${check.clause}`);
    await root.platformAdmin.create({ data: { id: ADMIN.id, email: ADMIN.email, name: ADMIN.name, passwordHash: 'x' } });
  });
  afterAll(async () => {
    await root?.$disconnect();
    await app?.$disconnect();
  });

  /** A business whose Owner claimed the trial at `claimedAt`, the clock an hour later, optionally approved for a month. */
  async function inTrial(o: { approve?: boolean; claimedAt?: Date; stores?: string[] } = {}) {
    const clock = new TestClock();
    const claimedAt = o.claimedAt ?? new Date(Math.floor(Date.now() / 1000) * 1000 + 123);
    clock.set(claimedAt);
    const s = servicesAt(clock);
    const b = await business({ stores: o.stores });
    const T = await claim(s, b);
    clock.set(new Date(claimedAt.getTime() + HOUR));
    if (o.approve) await approve(s, b);
    return { s, b, T, clock };
  }

  // Runs first, on a database that holds only its businesses: the sweeper's queries read every company.
  describe('12. suspended business at the scheduled activation time — through the sweeper’s own SQL', () => {
    it('suspended or cancelled with a paid period: in force on schedule; closed or never approved: never visited for it', async () => {
      const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 123);
      const make = async (setup: (s: Services, b: Business) => Promise<unknown>) => {
        const w = await inTrial({ approve: true, claimedAt });
        await setup(w.s, w.b);
        const store = (await w.s.seats.requestStore(w.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
        await confirm(w.s, store, 500, `BK-${w.b.id.slice(-4)}`);
        return { ...w, store };
      };
      const control = await make(async () => undefined);
      const suspended = await make((s, b) => s.lifecycle.suspend(b.id, { reason: 'documents to check' }, CTX));
      const cancelled = await make((s, b) => s.lifecycle.cancel(b.id, { reason: 'asked to stop' }, CTX));
      const closed = await make(async () => undefined);
      // Closed by its Owner before the end: the real closure, as the application account runs it.
      const deletion = new AccountDeletionService(app as never, {} as never, {} as never, {} as never);
      await app.$transaction((tx) =>
        (deletion as unknown as { closeCompany: (tx: unknown, r: unknown, now: Date) => Promise<unknown> }).closeCompany(
          tx,
          { companyId: closed.b.companyId, userId: closed.b.ownerId },
          new Date(claimedAt.getTime() + 2 * HOUR),
        ),
      );
      // Never approved: the request waits for paid access.
      const waiting = await inTrial({ claimedAt });
      const waitingStore = (await waiting.s.seats.requestStore(waiting.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
      await confirm(waiting.s, waitingStore, 500, 'BK-WAIT');
      for (const w of [control, suspended, cancelled, closed]) expect((await root.seatAllocation.findUniqueOrThrow({ where: { id: bin(w.store) } })).status).toBe('scheduled');

      const T = control.T;
      const clock = new TestClock();
      clock.set(new Date(T.getTime() + 60_000));
      const sweeper = servicesAt(clock).sweeper;
      const first = await sweeper.sweep();
      note(`sweep at T+1min: ${JSON.stringify(first)}`);

      for (const w of [control, suspended, cancelled]) {
        const l = await ledger(w.b);
        expect(l.requests).toEqual([expect.objectContaining({ status: 'paid', effectiveAt: T.toISOString() })]);
        expect(l.branches).toEqual(['Main', 'B']);
        expect(l.periods).toEqual([expect.objectContaining({ start: T.toISOString(), total: 1000 })]);
        expect(l.expiries).toBe(1);
      }
      expect((await root.subscription.findUniqueOrThrow({ where: { companyId: suspended.b.companyId } })).status).toBe('suspended');
      expect((await root.subscription.findUniqueOrThrow({ where: { companyId: cancelled.b.companyId } })).status).toBe('cancelled');
      for (const w of [closed, { b: waiting.b }]) {
        const l = await ledger(w.b);
        expect(l.requests).toEqual([expect.objectContaining({ status: 'scheduled', effectiveAt: T.toISOString() })]);
        expect(l.branches.filter((x) => x === 'B')).toEqual([]);
        expect(l.activations).toBe(0);
        // The trial did end: written down once, so neither is looked for again.
        expect(l.expiries).toBe(1);
      }

      // Reinstated a day later: nothing more is put in force or charged.
      const settled = await ledger(suspended.b);
      suspended.clock.set(new Date(T.getTime() + DAY));
      await suspended.s.lifecycle.reinstate(suspended.b.id, { reason: 'documents received' }, CTX);
      expect(await ledger(suspended.b)).toEqual(settled);

      // A second pass visits none of them: nothing of theirs can be put in force now.
      clock.set(new Date(T.getTime() + 2 * 60_000));
      const ours = [control, suspended, cancelled, closed, { b: waiting.b }];
      const before = await Promise.all(ours.map((w) => ledger(w.b)));
      const visited = jest.spyOn(TrialEndRoll.prototype, 'applyIfDue');
      const second = await sweeper.sweep();
      note(`second sweep: ${JSON.stringify(second)}`);
      const ids = new Set(ours.map((w) => w.b.companyId.toString('hex')));
      expect(visited.mock.calls.filter(([id]) => ids.has((id as Buffer).toString('hex')))).toEqual([]);
      expect(await Promise.all(ours.map((w) => ledger(w.b)))).toEqual(before);
    });
  });

  describe('3. payment confirmed during trial — 0097’s CHECK binds the application account', () => {
    it('scheduled as phonestore_app and read back exactly; the CHECK refuses, for the app and for root, what the one writer never writes', async () => {
      const { s, b, T } = await inTrial();
      const store = (await s.seats.requestStore(b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
      const r = await confirm(s, store, 500, 'BK-1');
      expect(r).toMatchObject({ applied: true, allocation: { status: 'scheduled', effectiveAt: T.toISOString() } });
      const [back] = await root.$queryRaw<{ status: string; effective_at: Date; payment_id: Buffer }[]>`
        SELECT status, effective_at, payment_id FROM seat_allocations WHERE id = ${bin(store)}`;
      const [payment] = await root.subscriptionPayment.findMany({ where: { companyId: b.companyId } });
      expect(back.status).toBe('scheduled');
      expect(back.effective_at.getTime()).toBe(T.getTime());
      expect(Buffer.from(back.payment_id).equals(payment.id)).toBe(true);
      expect(await ledger(b)).toMatchObject({ payments: ['500'], branches: ['Main'], periods: [] });

      // Fixtures for the refusals: a seat awaiting payment and an activity change awaiting payment.
      const sub = await root.subscription.findUniqueOrThrow({ where: { companyId: b.companyId } });
      const seat = newUuidV7Bin();
      const activity = newUuidV7Bin();
      await root.seatAllocation.createMany({
        data: [
          { id: seat, companyId: b.companyId, subscriptionId: sub.id, branchId: b.stores.Main, kind: 'seat', status: 'pending_payment', monthlyAmount: 100, requestedBy: 'owner' },
          { id: activity, companyId: b.companyId, subscriptionId: sub.id, branchId: b.stores.Main, kind: 'activity', status: 'pending_payment', activityFrom: 'electronics', activityTo: 'both', monthlyAmount: 200, requestedBy: 'owner' },
        ],
      });
      const refusals: string[] = [];
      for (const [who, client] of [['phonestore_app', app], ['root', root]] as const) {
        const attempts: [string, Prisma.Sql][] = [
          ['a seat scheduled without its start', Prisma.sql`UPDATE seat_allocations SET status = 'scheduled', effective_at = NULL, payment_id = ${payment.id} WHERE id = ${seat}`],
          ['an activity change scheduled', Prisma.sql`UPDATE seat_allocations SET status = 'scheduled', effective_at = ${T}, payment_id = ${payment.id} WHERE id = ${activity}`],
          [
            'a store inserted scheduled without its start',
            Prisma.sql`INSERT INTO seat_allocations (id, company_id, subscription_id, kind, status, label, monthly_amount, currency, requested_by, requested_at, version, created_at, updated_at)
                       VALUES (${newUuidV7Bin()}, ${b.companyId}, ${sub.id}, 'store', 'scheduled', 'X', 500, 'MRU', 'owner', NOW(6), 0, NOW(6), NOW(6))`,
          ],
        ];
        for (const [what, sql] of attempts) {
          const e = await client.$executeRaw(sql).catch((x: unknown) => x);
          expect(p2010Code(e)).toBe('3819');
          expect(String((e as Error).message)).toMatch(/ck_seat_alloc_scheduled/);
          refusals.push(`${who}: ${what} → 3819`);
        }
        // The well-formed write passes the CHECK (the confirmation's own), and is put back.
        await expect(client.$executeRaw`UPDATE seat_allocations SET status = 'scheduled', effective_at = ${T}, payment_id = ${payment.id} WHERE id = ${seat}`).resolves.toBe(1);
        await expect(client.$executeRaw`UPDATE seat_allocations SET status = 'pending_payment', effective_at = NULL, payment_id = NULL WHERE id = ${seat}`).resolves.toBe(1);
      }
      note(refusals.join('; '));
      expect((await root.seatAllocation.findMany({ where: { companyId: b.companyId, status: 'scheduled' } })).map((x) => binToUuid(x.id))).toEqual([store]);
    });
  });

  describe('6. exact activation at trial expiry — the journey on real SQL (with 1, 4 and 5 on the way)', () => {
    it('requested and paid during the trial, approved, nothing in force to the last millisecond, all of it at the end — once', async () => {
      const { s, b, T, clock } = await inTrial();
      await person(b, { name: 'Ali', store: 'Main', active: true, invitedAt: clock.now() });
      const sara = await person(b, { name: 'Sara', store: 'Main', invitedAt: clock.now() });

      // 1. Requested during the trial: waiting for payment, nothing opened, nothing billed.
      const store = (await s.seats.requestStore(b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation;
      expect(store).toMatchObject({ status: 'pending_payment', monthlyAmount: 500, label: 'B', activityTo: 'electronics', effectiveAt: null });
      const seat = (await s.seats.requestSeat(b.companyId, { branchId: b.stores.Main, userId: sara, requestedBy: 'owner' })).allocation;
      expect(seat).toMatchObject({ status: 'pending_payment', monthlyAmount: 100 });
      expect(await ledger(b)).toMatchObject({ branches: ['Main'], periods: [], payments: [] });

      // 4. Approved during the trial: one period, from the trial's end, at the base only — before and after the payments.
      await approve(s, b);
      await confirm(s, store.id, 500, 'BK-1');
      await confirm(s, seat.id, 100, 'BK-2');
      expect(await ledger(b)).toMatchObject({
        periods: [{ start: T.toISOString(), total: 500, branchFee: 500, staffFee: 0, active: 1 }],
        payments: ['500', '100'],
        branches: ['Main'],
      });

      // 5. The last millisecond of the trial: nothing open, counted, activated or recorded — not even by a sweep.
      clock.set(new Date(T.getTime() - 1));
      const early = await s.entitlement.forCompany(b.companyId);
      expect(early.seatsByStore).toEqual([expect.objectContaining({ name: 'Main', paidSeats: 0 })]);
      await expect(s.activation.tryActivate(sara, 'ops')).resolves.toEqual({ activated: false, alreadyActive: false, pending: ['seat_scheduled'] });
      await s.sweeper.sweep();
      expect(await ledger(b)).toMatchObject({
        requests: [expect.objectContaining({ status: 'scheduled' }), expect.objectContaining({ status: 'scheduled' })],
        expiries: 0,
        branches: ['Main'],
      });
      expect((await root.trialClaim.findUniqueOrThrow({ where: { companyId: b.companyId } })).expiryRecordedAt).toBeNull();

      // 6. One evaluation at exactly the end.
      clock.set(T);
      const at = await s.entitlement.forCompany(b.companyId);
      const done = await ledger(b);
      expect((await root.trialClaim.findUniqueOrThrow({ where: { companyId: b.companyId } })).expiryRecordedAt?.getTime()).toBe(T.getTime());
      expect(done).toMatchObject({
        branches: ['Main', 'B'],
        requests: [expect.objectContaining({ kind: 'store', status: 'paid', effectiveAt: T.toISOString() }), expect.objectContaining({ kind: 'seat', status: 'paid', effectiveAt: T.toISOString() })],
        periods: [{ start: T.toISOString(), total: 1100, branchFee: 1000, staffFee: 100, active: 2 }],
        activations: 2,
        expiries: 1,
      });
      expect(at).toMatchObject({ activeBranchCount: 2, subscribedBranchCount: 2 });
      expect(at.seatsByStore.find((x) => x.name === 'Main')).toMatchObject({ paidSeats: 1 });
      expect(await root.user.findUniqueOrThrow({ where: { id: sara } })).toMatchObject({ isActive: true });
      const audits = await root.platformAuditEvent.findMany({ where: { targetId: b.companyId, action: { in: ['store.activate', 'seat.activate'] } } });
      expect(audits.map((a) => [a.action, (a.afterJson as { raisedBy: number }).raisedBy]).sort()).toEqual([
        ['seat.activate', 100],
        ['store.activate', 500],
      ]);

      // 7. Whoever looks again finds nothing more to charge.
      clock.set(new Date(T.getTime() + 5 * 60_000));
      await s.entitlement.forCompany(b.companyId);
      await s.trialEnd.applyIfDue(b.companyId);
      await s.sweeper.sweep();
      await s.renewal.rollIfDue(b.companyId);
      await s.billing.assessNow(b.companyId);
      await expect(confirm(s, store.id, 500, 'BK-1')).resolves.toMatchObject({ applied: false });
      expect(await ledger(b)).toEqual(done);
    });
  });

  describe('7. one charge only — the R1 reproduction on real MySQL', () => {
    it('a store paid for before the approval: the first period opens at 500, not 1000, and is 1000 after the end — never 1500', async () => {
      const { s, b, T, clock } = await inTrial();
      const store = (await s.seats.requestStore(b.companyId, { name: 'Second', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
      await confirm(s, store, 500, 'BK-TRIAL-1');
      await approve(s, b);
      expect((await ledger(b)).periods.map((p) => p.total)).toEqual([500]);
      clock.set(T);
      await s.entitlement.forCompany(b.companyId);
      expect(await ledger(b)).toMatchObject({ periods: [{ total: 1000 }], payments: ['500'] });
    });

    it('a seat paid for before the approval: the staff fee is 0 during the trial and 100 from its end', async () => {
      const { s, b, T, clock } = await inTrial();
      await person(b, { name: 'Ali', store: 'Main', active: true, invitedAt: clock.now() });
      const seat = (await s.seats.requestSeat(b.companyId, { branchId: b.stores.Main, requestedBy: 'owner' })).allocation.id;
      await confirm(s, seat, 100, 'BK-TRIAL-2');
      await approve(s, b);
      expect((await ledger(b)).periods.map((p) => [p.staffFee, p.total])).toEqual([[0, 500]]);
      clock.set(T);
      await s.entitlement.forCompany(b.companyId);
      expect((await ledger(b)).periods.map((p) => [p.staffFee, p.total])).toEqual([[100, 600]]);
    });
  });

  describe('8. duplicate payment confirmation — two connections at once', () => {
    it('ten times: one confirmation schedules, the other is refused as changed, one payment; a retry answers with the same payment', async () => {
      for (let i = 0; i < 10; i += 1) {
        const { s, b } = await inTrial();
        const store = (await s.seats.requestStore(b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
        const outcomes = await Promise.allSettled([confirm(s, store, 500, 'BK-A'), confirm(s, store, 500, 'BK-B')]);
        expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
        const refused = (outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason;
        expect(refused).toBeInstanceOf(ConflictException);
        expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'seat_request_changed' });
        const won = (outcomes.find((o) => o.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof confirm>>>).value;
        expect(await root.subscriptionPayment.count({ where: { companyId: b.companyId } })).toBe(1);
        await expect(confirm(s, store, 500, 'BK-C')).resolves.toMatchObject({ applied: false, paymentId: won.paymentId, allocation: { status: 'scheduled' } });
        expect(await root.subscriptionPayment.count({ where: { companyId: b.companyId } })).toBe(1);
      }
    });
  });

  describe('9. concurrent expiry and payment confirmation', () => {
    /** Approved during the trial, store B and Sara's seat at Main scheduled. */
    async function scheduled() {
      const w = await inTrial({ approve: true });
      await person(w.b, { name: 'Ali', store: 'Main', active: true, invitedAt: w.clock.now() });
      const sara = await person(w.b, { name: 'Sara', store: 'Main', invitedAt: w.clock.now() });
      const store = (await w.s.seats.requestStore(w.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
      const seat = (await w.s.seats.requestSeat(w.b.companyId, { branchId: w.b.stores.Main, userId: sara, requestedBy: 'owner' })).allocation.id;
      await confirm(w.s, store, 500, 'BK-1');
      await confirm(w.s, seat, 100, 'BK-2');
      return { ...w, sara, store, seat };
    }

    it('(i) thirty times: a confirmation holds the subscription row at the end — twelve evaluations each answer at once; then one records the end and activates, once', async () => {
      const worst: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const w = await scheduled();
        w.clock.set(new Date(w.T.getTime() + 1_000));
        // A store asked for after the end, with the first paid period in force: confirmed at once.
        const late = (await w.s.seats.requestStore(w.b.companyId, { name: 'C', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
        // Choreography: the confirmation's own look at the end finds the row busy (r1), then takes the row and stops
        // at its payment insert (r2's gap lock) — holding the subscription row while the evaluations run.
        const r1 = hold(Prisma.sql`SELECT id FROM subscriptions WHERE company_id = ${w.b.companyId} FOR UPDATE`);
        const r2 = hold(Prisma.sql`SELECT id FROM subscription_payments WHERE company_id = ${w.b.companyId} FOR UPDATE`);
        await Promise.all([r1.held, r2.held]);
        const confirming = confirm(w.s, late, 500, `BK-C${i}`);
        await until('the confirmation to wait for the subscription row', () => waitingOn('subscriptions'));
        r1.release();
        await r1.done;
        await until('the confirmation to hold the row and wait at its payment', () => waitingOn('subscription_payments'));

        const evaluations = await Promise.all(Array.from({ length: 12 }, () => timed(() => w.s.entitlement.writeRefusal(w.b.companyId))));
        const ms = evaluations.map((e) => e.ms);
        worst.push(Math.max(...ms));
        expect(Math.max(...ms)).toBeLessThan(200);
        expect(evaluations.every((e) => e.value === null)).toBe(true);
        // Nothing recorded or activated behind the confirmation's back.
        expect(await ledger(w.b)).toMatchObject({ expiries: 0, activations: 0, branches: ['Main'] });

        r2.release();
        await r2.done;
        await expect(confirming).resolves.toMatchObject({ applied: true, allocation: { status: 'paid', effectiveAt: null } });
        // A second later — the lazy path's back-off after `busy` — one evaluation records the end and activates.
        w.clock.set(new Date(w.T.getTime() + 2_500));
        await w.s.entitlement.forCompany(w.b.companyId);
        const l = await ledger(w.b);
        expect(l).toMatchObject({ expiries: 1, activations: 2, branches: ['Main', 'C', 'B'] });
        expect(l.requests.filter((r) => r.label === 'B' || r.kind === 'seat').every((r) => r.status === 'paid' && r.effectiveAt === w.T.toISOString())).toBe(true);
        expect(l.periods).toEqual([expect.objectContaining({ total: 1600, staffFee: 100, active: 3 })]);
        expect(l.payments).toHaveLength(3);
      }
      note(`(i) slowest of twelve evaluations per run (ms): ${worst.map((x) => x.toFixed(1)).join(', ')}`);
    });

    it('(ii) thirty times: confirmed as the clock crosses the end, beside evaluations — scheduled then activated, or at once; never both', async () => {
      const outcomes: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        const w = await inTrial({ approve: true });
        const store = (await w.s.seats.requestStore(w.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
        // Started 5 to 45 ms before the end: the confirmation reads its instant after the lock, on either side of it.
        w.clock.runFrom(new Date(w.T.getTime() - 5 - (i % 6) * 8));
        const [confirmed] = await Promise.allSettled([
          confirm(w.s, store, 500, 'BK-1'),
          ...Array.from({ length: 4 }, () => w.s.entitlement.forCompany(w.b.companyId)),
          w.s.trialEnd.applyIfDue(w.b.companyId),
        ]);
        expect(confirmed.status).toBe('fulfilled');
        // Settle: past any back-off, everybody looks once more.
        w.clock.set(new Date(w.T.getTime() + 10_000));
        await w.s.entitlement.forCompany(w.b.companyId);
        await w.s.trialEnd.applyIfDue(w.b.companyId);
        const l = await ledger(w.b);
        const [request] = l.requests;
        expect(request.status).toBe('paid');
        expect(l.branches.filter((x) => x === 'B')).toHaveLength(1);
        expect(l.payments).toEqual(['500']);
        expect(l.expiries).toBe(1);
        expect(l.periods.map((p) => p.total)).toEqual([1000]);
        if (request.effectiveAt === null) outcomes.push('at-once');
        else {
          expect(request.effectiveAt).toBe(w.T.toISOString());
          expect(l.activations).toBe(1);
          outcomes.push('scheduled');
        }
      }
      note(`(ii) outcomes: ${outcomes.join(',')}`);
    });

    it('(iii) thirty times: confirmed a millisecond after the end with the first period in force — at once, the period raised once, the end recorded once', async () => {
      for (let i = 0; i < 30; i += 1) {
        const w = await inTrial({ approve: true });
        const store = (await w.s.seats.requestStore(w.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
        w.clock.set(new Date(w.T.getTime() + 1));
        const [confirmed] = await Promise.allSettled([confirm(w.s, store, 500, 'BK-1'), ...Array.from({ length: 12 }, () => w.s.entitlement.forCompany(w.b.companyId))]);
        expect(confirmed).toMatchObject({ status: 'fulfilled', value: { allocation: { status: 'paid', effectiveAt: null } } });
        w.clock.set(new Date(w.T.getTime() + 10_000));
        await w.s.entitlement.forCompany(w.b.companyId);
        expect(await ledger(w.b)).toMatchObject({ branches: ['Main', 'B'], payments: ['500'], expiries: 1, activations: 0, periods: [{ total: 1000 }] });
      }
    });

    it('(iv) thirty times: confirmed a millisecond after the end with no paid period — refused, no payment, the request still waiting', async () => {
      for (let i = 0; i < 30; i += 1) {
        const w = await inTrial();
        const store = (await w.s.seats.requestStore(w.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
        w.clock.set(new Date(w.T.getTime() + 1));
        const [confirmed] = await Promise.allSettled([confirm(w.s, store, 500, 'BK-1'), ...Array.from({ length: 12 }, () => w.s.entitlement.forCompany(w.b.companyId))]);
        expect(confirmed.status).toBe('rejected');
        const refused = (confirmed as PromiseRejectedResult).reason;
        expect(refused).toBeInstanceOf(ConflictException);
        expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'paid_period_not_started' });
        w.clock.set(new Date(w.T.getTime() + 10_000));
        await w.s.entitlement.forCompany(w.b.companyId);
        expect(await ledger(w.b)).toMatchObject({
          branches: ['Main'],
          payments: [],
          periods: [],
          expiries: 1,
          requests: [expect.objectContaining({ status: 'pending_payment', version: 0, effectiveAt: null })],
        });
      }
    });
  });

  describe('supporting — R1-F2: the end is recorded without ever waiting on the subscription row', () => {
    it('the row held for 8 s: twelve evaluations and an unrelated business each answer at once; after the back-off, one records it, once', async () => {
      const clock = new TestClock();
      const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 123);
      clock.set(claimedAt);
      const queries: string[] = [];
      const logged = new PrismaClient({ datasourceUrl: APP_URL, log: [{ emit: 'event', level: 'query' }] });
      (logged as unknown as { $on: (e: 'query', f: (q: { query: string }) => void) => void }).$on('query', (q) => queries.push(q.query));
      try {
        const s = servicesAt(clock, logged);
        const b = await business();
        const other = await business();
        const T = await claim(s, b);
        await claim(s, other);
        clock.set(new Date(T.getTime() + 60_000));
        // The unrelated business: its trial ended too, and is recorded — its evaluations have nothing to do.
        await s.entitlement.writeRefusal(other.companyId);

        const holder = hold(Prisma.sql`SELECT id FROM subscriptions WHERE company_id = ${b.companyId} FOR UPDATE`);
        await holder.held;
        const from = queries.length;
        const [stuck, unrelated] = await Promise.all([
          Promise.all(Array.from({ length: 12 }, () => timed(() => s.entitlement.writeRefusal(b.companyId)))),
          timed(() => s.entitlement.writeRefusal(other.companyId)),
        ]);
        const nowaits = queries.slice(from).filter((q) => /FOR UPDATE NOWAIT/.test(q)).length;
        note(`R1-F2: twelve evaluations (ms) ${stuck.map((x) => x.ms.toFixed(1)).join(', ')}; unrelated ${unrelated.ms.toFixed(1)} ms; NOWAIT attempts ${nowaits}`);
        expect(stuck.every((x) => x.ms < 200 && x.value?.state === 'trial_expired')).toBe(true);
        expect(unrelated.ms).toBeLessThan(200);
        expect(nowaits).toBe(1);
        // Held for 8 s in all, as another writer would.
        await new Promise((r) => setTimeout(r, 8_000));
        holder.release();
        await holder.done;
        expect(await root.subscriptionEvent.count({ where: { companyId: b.companyId, kind: 'trial_expired' } })).toBe(0);

        clock.set(new Date(T.getTime() + 61_500));
        await Promise.all(Array.from({ length: 12 }, () => s.entitlement.writeRefusal(b.companyId)));
        expect(await root.subscriptionEvent.count({ where: { companyId: b.companyId, kind: 'trial_expired' } })).toBe(1);
        expect((await root.trialClaim.findUniqueOrThrow({ where: { companyId: b.companyId } })).expiryRecordedAt?.getTime()).toBe(T.getTime() + 61_500);
      } finally {
        await logged.$disconnect();
      }
    });
  });

  describe('supporting — N1: any other row the end’s work needs, held by another writer — nothing waits, nothing is half-done', () => {
    /** Approved during the trial; Ali holds Main's included seat; store B, a seat for nobody and Sara's seat paid for during it. */
    async function threeScheduled() {
      const w = await inTrial({ approve: true });
      await person(w.b, { name: 'Ali', store: 'Main', active: true, invitedAt: w.clock.now() });
      const sara = await person(w.b, { name: 'Sara', store: 'Main', invitedAt: w.clock.now() });
      const store = (await w.s.seats.requestStore(w.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
      const unnamed = (await w.s.seats.requestSeat(w.b.companyId, { branchId: w.b.stores.Main, requestedBy: 'owner' })).allocation.id;
      const seat = (await w.s.seats.requestSeat(w.b.companyId, { branchId: w.b.stores.Main, userId: sara, requestedBy: 'owner' })).allocation.id;
      await confirm(w.s, store, 500, 'BK-B');
      await confirm(w.s, unnamed, 100, 'BK-S0');
      await confirm(w.s, seat, 100, 'BK-SARA');
      const p1 = (await root.billingPeriod.findFirstOrThrow({ where: { companyId: w.b.companyId } })).id;
      const ownerRole = w.b.roles.owner;
      return { ...w, sara, store, unnamed, seat, p1, ownerRole };
    }

    /** All of the activation or none of it: the three requests, the store, the raise and the audits move together. */
    async function wholeOrNothing(b: Business): Promise<'none' | 'all'> {
      const l = await ledger(b);
      const paid = l.requests.filter((r) => r.status === 'paid').length;
      expect([0, 3]).toContain(paid);
      expect(l.branches).toEqual(paid === 3 ? ['Main', 'B'] : ['Main']);
      expect(l.periods.map((p) => p.total)).toEqual([paid === 3 ? 1200 : 500]);
      expect(l.activations).toBe(paid);
      expect(l.payments).toEqual(['500', '100', '100']);
      return paid === 3 ? 'all' : 'none';
    }

    /** One round of looking: twelve evaluations at once, another instance's, and the administrator's trigger. */
    async function round(w: Awaited<ReturnType<typeof threeScheduled>>): Promise<number[]> {
      const other = servicesAt(Object.assign(new TestClock(), { now: () => w.clock.now() }) as TestClock);
      const timings = await Promise.all([
        ...Array.from({ length: 12 }, () => timed(() => w.s.entitlement.writeRefusal(w.b.companyId))),
        timed(() => other.entitlement.forCompany(w.b.companyId)),
        timed(() => w.s.trialEnd.applyIfDue(w.b.companyId)),
      ]);
      return timings.map((t) => t.ms);
    }

    it('the person’s row and the first period held for 8 s: every evaluation answers at once, the end is recorded, nothing of the activation is written — released, it is all done once', async () => {
      const w = await threeScheduled();
      const holders = [
        hold(Prisma.sql`SELECT id FROM users WHERE id = ${w.sara} FOR UPDATE`),
        hold(Prisma.sql`SELECT id FROM billing_periods WHERE id = ${w.p1} FOR UPDATE`),
      ];
      await Promise.all(holders.map((h) => h.held));
      w.clock.runFrom(new Date(w.T.getTime() + 1_000));
      const ms: number[] = [];
      const started = Date.now();
      while (Date.now() - started < 8_000) {
        ms.push(...(await round(w)));
        expect(await wholeOrNothing(w.b)).toBe('none');
        await new Promise((r) => setTimeout(r, 400));
      }
      note(`N1 users + P1 held 8 s: ${ms.length} evaluations, slowest ${Math.max(...ms).toFixed(1)} ms`);
      expect(Math.max(...ms)).toBeLessThan(200);
      // The end itself needs neither row: written down once, meanwhile.
      expect((await ledger(w.b)).expiries).toBe(1);
      expect(await root.user.findUniqueOrThrow({ where: { id: w.sara } })).toMatchObject({ isActive: false, activatedAt: null });

      for (const h of holders) h.release();
      await Promise.all(holders.map((h) => h.done));
      // Past the lazy path's second of back-off, one evaluation does all of it, once.
      await new Promise((r) => setTimeout(r, 1_100));
      await w.s.entitlement.forCompany(w.b.companyId);
      expect(await wholeOrNothing(w.b)).toBe('all');
      const l = await ledger(w.b);
      expect(l.requests.map((r) => r.effectiveAt)).toEqual([w.T.toISOString(), w.T.toISOString(), w.T.toISOString()]);
      expect(l.expiries).toBe(1);
      expect(await root.user.findUniqueOrThrow({ where: { id: w.sara } })).toMatchObject({ isActive: true });
      await round(w);
      expect(await ledger(w.b)).toEqual(l);
    });

    it('each other row on its own — the business’s row, the claim, the store request, an Owner, the Owner’s role — held: never a wait, never half-done; released, done once', async () => {
      const cases: { what: string; sql: (w: Awaited<ReturnType<typeof threeScheduled>>) => Prisma.Sql; activatesMeanwhile: boolean; recordsMeanwhile: boolean }[] = [
        { what: 'the business’s row', sql: (w) => Prisma.sql`SELECT id FROM companies WHERE id = ${w.b.companyId} FOR UPDATE`, activatesMeanwhile: false, recordsMeanwhile: false },
        { what: 'the claim', sql: (w) => Prisma.sql`SELECT id FROM trial_claims WHERE company_id = ${w.b.companyId} FOR UPDATE`, activatesMeanwhile: true, recordsMeanwhile: false },
        { what: 'the store request', sql: (w) => Prisma.sql`SELECT id FROM seat_allocations WHERE id = ${bin(w.store)} FOR UPDATE`, activatesMeanwhile: false, recordsMeanwhile: true },
        { what: 'the Owner', sql: (w) => Prisma.sql`SELECT id FROM users WHERE id = ${w.b.ownerId} FOR UPDATE`, activatesMeanwhile: false, recordsMeanwhile: true },
        { what: 'the Owner’s role', sql: (w) => Prisma.sql`SELECT id FROM roles WHERE id = ${w.ownerRole} FOR UPDATE`, activatesMeanwhile: false, recordsMeanwhile: true },
      ];
      const lines: string[] = [];
      for (const c of cases) {
        const w = await threeScheduled();
        const h = hold(c.sql(w));
        await h.held;
        w.clock.runFrom(new Date(w.T.getTime() + 1_000));
        const ms = [...(await round(w)), ...(await round(w))];
        expect(Math.max(...ms)).toBeLessThan(200);
        expect(await wholeOrNothing(w.b)).toBe(c.activatesMeanwhile ? 'all' : 'none');
        expect((await ledger(w.b)).expiries).toBe(c.recordsMeanwhile ? 1 : 0);
        lines.push(`${c.what}: slowest ${Math.max(...ms).toFixed(1)} ms`);
        h.release();
        await h.done;
        await new Promise((r) => setTimeout(r, 1_100));
        await w.s.entitlement.forCompany(w.b.companyId);
        expect(await wholeOrNothing(w.b)).toBe('all');
        expect((await ledger(w.b)).expiries).toBe(1);
      }
      note(`N1 one row held: ${lines.join('; ')}`);
    });
  });

  describe('supporting — N2: the sweeper looks again at a business it found busy, within its pass', () => {
    it('a business’s row held when the pass reaches it: put in force about a second after the holder lets go, in the same pass — another due business on the first look', async () => {
      const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 123);
      const held = await inTrial({ approve: true, claimedAt });
      const free = await inTrial({ approve: true, claimedAt });
      for (const w of [held, free]) {
        const store = (await w.s.seats.requestStore(w.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
        await confirm(w.s, store, 500, `BK-${w.b.id.slice(-4)}`);
      }
      const holder = hold(Prisma.sql`SELECT id FROM subscriptions WHERE company_id = ${held.b.companyId} FOR UPDATE`);
      await holder.held;
      const clock = new TestClock();
      clock.set(new Date(held.T.getTime() + 40_000));
      const started = Date.now();
      const pass = servicesAt(clock).sweeper.sweep();
      await until('the free business to be put in force by the first look', async () => (await ledger(free.b)).activations === 1, 5_000);
      // Held across the pass's first look and its next two: the business waits for the holder, never for a minute.
      await new Promise((r) => setTimeout(r, Math.max(0, 2_500 - (Date.now() - started))));
      expect((await ledger(held.b)).activations).toBe(0);
      holder.release();
      await holder.done;
      const released = Date.now();
      const result = await pass;
      const after = Date.now() - released;
      note(`N2: held for ${released - started} ms of the pass; put in force ${after} ms after the release; pass ${JSON.stringify(result)}`);
      expect(after).toBeLessThan(1_500);
      expect(result.outcomes.busy).toBe(0);
      for (const w of [held, free]) {
        expect(await ledger(w.b)).toMatchObject({
          requests: [expect.objectContaining({ status: 'paid', effectiveAt: w.T.toISOString() })],
          branches: ['Main', 'B'],
          periods: [expect.objectContaining({ total: 1000 })],
          activations: 1,
          expiries: 1,
        });
      }
    });
  });

  describe('supporting — an approval decided under the lock', () => {
    it('ten times: two approvals at once, neither naming a version — one transition, one first period, the other applied: false', async () => {
      for (let i = 0; i < 10; i += 1) {
        const { s, b } = await inTrial();
        const outcomes = await Promise.all([approve(s, b), approve(s, b)]);
        expect(outcomes.map((o) => o.applied).sort()).toEqual([false, true]);
        expect(await root.billingPeriod.count({ where: { companyId: b.companyId } })).toBe(1);
        expect(await root.subscriptionEvent.count({ where: { companyId: b.companyId, kind: 'approved' } })).toBe(1);
        expect(await root.subscriptionEvent.count({ where: { companyId: b.companyId, kind: 'renewed' } })).toBe(1);
      }
    });
  });

  describe('13. trial claim racing an add-on request', () => {
    const delay = (i: number) => new Promise((r) => setTimeout(r, (i % 6) * 3));

    it('twenty-four times each: a store request, a seat request, a payment confirmation — against the claim', async () => {
      const outcomes: string[] = [];
      for (let i = 0; i < 24; i += 1) {
        for (const kind of ['store', 'seat', 'confirm'] as const) {
          const clock = new TestClock();
          clock.set(new Date(Math.floor(Date.now() / 1000) * 1000 + 123));
          const s = servicesAt(clock);
          const b = await business();
          if (kind === 'seat') await person(b, { name: 'Ali', store: 'Main', active: true, invitedAt: clock.now() });
          const pending = kind === 'confirm' ? (await s.seats.requestStore(b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id : null;
          const counts = async () => ({
            requests: await root.seatAllocation.count({ where: { companyId: b.companyId } }),
            payments: await root.subscriptionPayment.count({ where: { companyId: b.companyId } }),
            periods: await root.billingPeriod.count({ where: { companyId: b.companyId } }),
          });
          const before = await counts();
          const other: () => Promise<{ allocation: { status: string; effectiveAt: string | null } }> =
            kind === 'store'
              ? () => s.seats.requestStore(b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })
              : kind === 'seat'
                ? () => s.seats.requestSeat(b.companyId, { branchId: b.stores.Main, requestedBy: 'owner' })
                : () => confirm(s, pending as string, 500, 'BK-1');
          const [claimed, asked] = await Promise.allSettled([delay(i).then(() => claim(s, b, `race-${i}`)), delay(i + 3).then(other)]);
          expect(claimed.status).toBe('fulfilled');
          const claimRow = await root.trialClaim.findUniqueOrThrow({ where: { companyId: b.companyId } });
          expect(claimRow.endsAt.getTime() - claimRow.startedAt.getTime()).toBe(TRIAL_DURATION_MS);
          expect(await root.trialClaim.count({ where: { companyId: b.companyId } })).toBe(1);
          expect(await root.branch.count({ where: { companyId: b.companyId } })).toBe(1);
          const after = await counts();
          if (kind !== 'confirm') {
            expect(asked.status).toBe('fulfilled');
            // The claim changed no count; the request added its one pending row.
            expect(after).toEqual({ ...before, requests: before.requests + 1 });
            expect(await root.seatAllocation.findMany({ where: { companyId: b.companyId } })).toEqual([expect.objectContaining({ status: 'pending_payment' })]);
            outcomes.push(`${kind}:ok`);
          } else if (asked.status === 'fulfilled') {
            expect(asked.value.allocation).toMatchObject({ status: 'scheduled', effectiveAt: claimRow.endsAt.toISOString() });
            expect(after).toEqual({ ...before, payments: 1 });
            outcomes.push('confirm:claim-first');
          } else {
            expect(asked.reason).toBeInstanceOf(ConflictException);
            expect((asked.reason as ConflictException).getResponse()).toMatchObject({ code: 'paid_period_not_started' });
            expect(after).toEqual(before);
            outcomes.push('confirm:confirmation-first');
          }
        }
      }
      const tally = outcomes.reduce<Record<string, number>>((m, o) => ({ ...m, [o]: (m[o] ?? 0) + 1 }), {});
      note(`13. outcomes ${JSON.stringify(tally)}`);
    });
  });

  describe('14. correct company/store isolation', () => {
    it('one business’s end, while another’s subscription row is held: only its own lock taken, only its own rows changed', async () => {
      const a = await inTrial({ approve: true });
      const later = new Date(a.clock.now().getTime() + 5 * HOUR);
      const b = await inTrial({ approve: true, claimedAt: later });
      for (const w of [a, b]) {
        const store = (await w.s.seats.requestStore(w.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
        await confirm(w.s, store, 500, `BK-${w.b.id.slice(-4)}`);
      }
      const betaBefore = await ledger(b.b);
      // Beta's row is held by another writer the whole time Alpha's end is processed: Alpha never waits for it.
      const holder = hold(Prisma.sql`SELECT id FROM subscriptions WHERE company_id = ${b.b.companyId} FOR UPDATE`);
      await holder.held;
      a.clock.set(new Date(a.T.getTime() + 1_000));
      const lazy = await timed(() => a.s.entitlement.forCompany(a.b.companyId));
      const trigger = await timed(() => a.s.trialEnd.applyIfDue(a.b.companyId));
      holder.release();
      await holder.done;
      note(`14. Alpha's evaluation ${lazy.ms.toFixed(1)} ms, trigger ${trigger.ms.toFixed(1)} ms, with Beta's row held`);
      expect(lazy.ms).toBeLessThan(1_000);
      expect(await ledger(a.b)).toMatchObject({ branches: ['Main', 'B'], activations: 1, expiries: 1, periods: [{ total: 1000 }] });
      expect(await ledger(b.b)).toEqual(betaBefore);

      // Beta's own end, later: its own rows.
      const alphaAfter = await ledger(a.b);
      b.clock.set(new Date(b.T.getTime() + 1_000));
      await b.s.entitlement.forCompany(b.b.companyId);
      expect(await ledger(b.b)).toMatchObject({ branches: ['Main', 'B'], activations: 1, periods: [{ total: 1000 }] });
      expect(await ledger(a.b)).toEqual(alphaAfter);
    });

    it('a request of another business: the Owner cannot withdraw it — not found', async () => {
      const a = await inTrial();
      const b = await inTrial();
      const theirs = (await b.s.seats.requestStore(b.b.companyId, { name: 'B', activity: 'electronics', requestedBy: 'owner' })).allocation.id;
      const before = await ledger(b.b);
      await expect(a.s.seats.withdraw(a.b.companyId, bin(theirs), 'owner')).rejects.toBeInstanceOf(NotFoundException);
      expect(await ledger(b.b)).toEqual(before);
    });
  });
});
