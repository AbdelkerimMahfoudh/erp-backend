import { Prisma, PrismaClient } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { GraceRoll } from '../billing/grace-roll';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { EntitlementService } from '../entitlement/entitlement.service';
import { graceWindowStart } from '../entitlement/grace-rules';
import { TestWhatsAppChannel } from '../messaging/channels';
import { SUBSCRIPTION_TEMPLATES } from '../messaging/templates';
import { TestEmailChannel } from '../platform/__testing__/trial-world';
import { PlatformAuditService } from '../platform/platform-audit.service';
import { SubscriptionLifecycleService } from '../platform/subscription-lifecycle.service';
import { TrialService } from '../platform/trial/trial.service';
import { TrialSetupService } from '../platform/trial/trial-setup.service';
import { TrialRefusal } from '../platform/trial/trial-refusal';
import { TRIAL_TERMS_VERSION } from '../platform/trial/trial-rules';
import { NoticeService } from './notice.service';

/**
 * The limited grace, the subscription notice outbox and the portal claim (0099) on REAL MySQL — what the in-memory
 * world cannot show: InnoDB's locks (FOR UPDATE, NOWAIT) across separate connection pools, the UNIQUE identities, the
 * triggers and CHECKs of 0099 as written, MySQL's own calendar arithmetic, and DATETIME(6) instants.
 *
 * Env-gated, and skipped otherwise (CI runs `npx jest --ci` with no database): set GRACE_ROOT_URL (root: the fixtures)
 * and GRACE_APP_URL (phonestore_app: every service under test, so the triggers see the application account) to a
 * DISPOSABLE database with 0099 applied — both naming the same database, whose name starts with `grace_`. It writes
 * businesses and never removes them: drop the database afterwards. CI runs it on a fresh server in the database gates
 * (`deploy/ci-database-gates.sh`, step 6); the rehearsal ran it on a restored copy of the realistic data (docs/101 §9).
 *
 * Each PrismaClient is a process of its own (its own pool); the services are constructed by hand over the application
 * account with an injected clock.
 */

const ROOT_URL = process.env.GRACE_ROOT_URL ?? '';
const APP_URL = process.env.GRACE_APP_URL ?? '';
const run = ROOT_URL !== '' && APP_URL !== '' ? describe : describe.skip;

jest.setTimeout(300_000);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Printed beside the results: how each race came out. */
const note = (line: string) => process.stdout.write(`[lifecycle.mysql] ${line}\n`);

class TestClock {
  private at: Date;
  constructor(at: Date) {
    this.at = at;
  }
  now = (): Date => new Date(this.at.getTime());
  set(at: Date): void {
    this.at = at;
  }
}

let root: PrismaClient;
const apps: PrismaClient[] = [];
const ADMIN = { id: newUuidV7Bin(), email: `lifecycle-mysql-${Date.now().toString(36)}@example.test`, name: 'Lifecycle' };
const CTX = { admin: ADMIN, ip: '127.0.0.1' } as never;

const config = {
  whatsappMode: 'test',
  portalSubscriptionUrl: 'https://dukan.tsxmr.com/subscription',
  templates: Object.fromEntries(SUBSCRIPTION_TEMPLATES.map((x) => [x.configKey, `erp_${x.key.replace('.', '_')}`])) as Record<string, string>,
  whatsappTemplateName(configKey: string): string {
    return this.templates[configKey] ?? '';
  },
};
// Every Owner here registered with the operational WhatsApp consent (D213): the consent rule has its own spec.
const records = {
  contactState: async () => ({ optOutScope: 'none', consented: true, consent: 'granted', consentVersion: null, consentedAt: null, withdrawnAt: null, lastInboundAt: null, undeliverableAt: null }),
};
const hasher = { hash: (value: string) => `hash:${value.trim().toLowerCase()}` };

/** Everything one API process would hold, over the application account. */
function processOn(client: PrismaClient, clock: TestClock, whatsapp = new TestWhatsAppChannel()) {
  const db = client as never;
  const audit = new PlatformAuditService(db);
  const billing = new BillingService(db, clock);
  const entitlement = new EntitlementService(db, {} as never, clock);
  const notices = new NoticeService(db, config as never, entitlement, records as never, hasher as never, whatsapp, new TestEmailChannel(), clock);
  const lifecycle = new SubscriptionLifecycleService(db, audit, billing, clock, notices);
  const setup = new TrialSetupService(db, entitlement, audit, notices, clock);
  const trial = new TrialService(db, entitlement, audit, setup, clock);
  const graceRoll = new GraceRoll(db, clock);
  return { notices, lifecycle, trial, graceRoll, whatsapp, entitlement };
}

// ── fixtures, as root ───────────────────────────────────────────────────────
let seq = 0;
const tag = () => {
  seq += 1;
  return `${Date.now().toString(36).slice(-5)}${seq.toString(36)}`.toUpperCase().slice(-9);
};

interface Business {
  companyId: Buffer;
  id: string;
  ownerId: Buffer;
  subscriptionId: Buffer;
  phone: string;
}

async function business(o: { status?: 'activated' | 'pending_activation'; periodEnd?: Date | null; eligible?: boolean } = {}): Promise<Business> {
  const t = tag();
  const companyId = newUuidV7Bin();
  const ownerId = newUuidV7Bin();
  const roleId = newUuidV7Bin();
  const branchId = newUuidV7Bin();
  const subscriptionId = newUuidV7Bin();
  seq += 1;
  const phone = `+22238${String(100000 + (seq % 900000)).padStart(6, '0')}`;
  await root.company.create({ data: { id: companyId, name: `Lifecycle ${t}`, publicStoreId: `LC${t}`, settingsJson: {}, timezone: 'Africa/Nouakchott' } });
  await root.role.create({ data: { id: roleId, companyId, key: 'owner', name: 'Owner' } });
  await root.user.create({
    data: {
      id: ownerId, companyId, name: 'Owner', login: `owner-${t.toLowerCase()}`, personalId: `${t}${seq}`.slice(-10).padStart(10, '0'),
      phone, phoneVerifiedAt: new Date('2026-01-01T00:00:00.000Z'), passwordHash: 'x',
    },
  });
  await root.branch.create({ data: { id: branchId, companyId, name: 'Main' } });
  await root.userBranch.create({ data: { id: newUuidV7Bin(), companyId, userId: ownerId, branchId, roleId } });
  await root.subscription.create({
    data: { id: subscriptionId, companyId, status: o.status ?? 'activated', currentPeriodEnd: o.periodEnd === undefined ? null : o.periodEnd, subscribedBranchCount: 1 },
  });
  if (o.eligible) await root.trialEligibility.create({ data: { id: newUuidV7Bin(), companyId, ownerUserId: ownerId, registrationMethod: 'phone' } });
  return { companyId, id: binToUuid(companyId), ownerId, subscriptionId, phone };
}

/** A decision written straight into the table, as root — to give a company a history (the CHECKs still apply). */
async function priorGrace(b: Business, periodEnd: Date, decision: 'granted' | 'refused', usesBefore: number): Promise<void> {
  await root.$executeRaw`
    INSERT INTO grace_episodes (id, company_id, subscription_id, period_end, decision, started_at, ends_at, uses_before, window_start, recorded_at, recorded_by)
    VALUES (${newUuidV7Bin()}, ${b.companyId}, ${b.subscriptionId}, ${periodEnd}, ${decision}, ${periodEnd},
            ${decision === 'granted' ? new Date(periodEnd.getTime() + 72 * HOUR) : periodEnd}, ${usesBefore},
            ${periodEnd} - INTERVAL 12 MONTH, ${new Date(periodEnd.getTime() + 1000)}, 'sweeper')`;
}

const monthsBefore = (at: Date, months: number) => {
  const d = new Date(at.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
};

/** The MySQL error number of a failed raw statement (1644 for SIGNAL, 3819 for a CHECK). */
function mysqlCode(e: unknown): number | null {
  const meta = (e as { meta?: { code?: string } }).meta;
  const fromMeta = meta?.code ? Number(meta.code) : NaN;
  if (!Number.isNaN(fromMeta)) return fromMeta;
  const m = /Code: `?(\d{4})`?|\b(1644|3819|1062)\b/.exec(String((e as Error)?.message ?? ''));
  return m ? Number(m[1] ?? m[2]) : null;
}
async function refusedWith(promise: Promise<unknown>): Promise<{ code: number | null; message: string } | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    return { code: mysqlCode(e), message: String((e as Error).message) };
  }
}

run('0099 on real MySQL', () => {
  beforeAll(async () => {
    const rootDb = new URL(ROOT_URL).pathname;
    const appDb = new URL(APP_URL).pathname;
    if (!/^\/grace_[a-z0-9_]+$/.test(rootDb) || rootDb !== appDb) throw new Error('Refusing: GRACE_ROOT_URL and GRACE_APP_URL must name the same disposable grace_* database.');
    root = new PrismaClient({ datasources: { db: { url: ROOT_URL } } });
    for (let i = 0; i < 3; i++) apps.push(new PrismaClient({ datasources: { db: { url: APP_URL } } }));
    const [{ n }] = await root.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM _prisma_migrations WHERE migration_name = '0099_grace_and_notices' AND finished_at IS NOT NULL`;
    if (Number(n) !== 1) throw new Error('Refusing: 0099 is not applied to this database.');
    // The administrator the lifecycle's audit rows name (their admin_id is a foreign key).
    await root.platformAdmin.create({ data: { id: ADMIN.id, email: ADMIN.email, name: ADMIN.name, passwordHash: 'x' } });
  });
  afterAll(async () => {
    await Promise.all([root, ...apps].map((c) => c?.$disconnect()));
  });

  describe('grace decisions', () => {
    it('three processes race the sweeper and the first evaluation for one period end: one decision, one event, one audit row', async () => {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const b = await business({ periodEnd: new Date(now.getTime() - HOUR) });
      const clock = new TestClock(now);
      const procs = apps.map((c) => processOn(c, clock));
      const outcomes = await Promise.all([
        ...procs.map((p) => p.graceRoll.recordIfDue(b.companyId, 'sweeper')),
        ...procs.map((p) => p.graceRoll.onEvaluation(b.companyId).then((wrote) => (wrote ? 'recorded' : 'not this one'))),
      ]);
      note(`six writers: ${outcomes.join(', ')}`);
      expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
      const episodes = await root.graceEpisode.findMany({ where: { companyId: b.companyId } });
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toMatchObject({ decision: 'granted', usesBefore: 0, startedAt: new Date(now.getTime() - HOUR), endsAt: new Date(now.getTime() + 71 * HOUR) });
      expect(await root.subscriptionEvent.count({ where: { companyId: b.companyId, kind: 'grace_started' } })).toBe(1);
      expect(await root.platformAuditEvent.count({ where: { targetId: b.companyId, action: 'grace.started' } })).toBe(1);
    });

    it('a renewal racing the sweeper: one decision, recorded before the end moves — and the period counts from the original expiry', async () => {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const end = new Date(now.getTime() - 2 * HOUR);
      const b = await business({ periodEnd: end });
      const clock = new TestClock(now);
      const [p1, p2] = apps.map((c) => processOn(c, clock));
      const [renewed, swept] = await Promise.all([p1.lifecycle.extend(b.id, { months: 1, reason: 'mysql race' }, CTX), p2.graceRoll.recordIfDue(b.companyId, 'sweeper')]);
      note(`renewal vs sweeper: sweeper ${swept}`);
      const expected = new Date(end.getTime());
      expected.setUTCMonth(expected.getUTCMonth() + 1);
      expect(renewed.subscription.currentPeriodEnd).toEqual(expected);
      const episodes = await root.graceEpisode.findMany({ where: { companyId: b.companyId } });
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toMatchObject({ periodEnd: end, decision: 'granted' });
      expect(['lifecycle', 'sweeper']).toContain(episodes[0].recordedBy);
    });

    it('the application account can neither edit nor delete a decision — the triggers refuse it by name', async () => {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const b = await business({ periodEnd: new Date(now.getTime() - HOUR) });
      await processOn(apps[0], new TestClock(now)).graceRoll.recordIfDue(b.companyId, 'sweeper');
      const update = await refusedWith(apps[0].$executeRaw`UPDATE grace_episodes SET recorded_by = 'evaluation' WHERE company_id = ${b.companyId}`);
      const remove = await refusedWith(apps[0].$executeRaw`DELETE FROM grace_episodes WHERE company_id = ${b.companyId}`);
      expect(update?.message).toMatch(/grace_episodes is immutable: a grace decision is never edited/);
      expect(remove?.message).toMatch(/grace_episodes is immutable: a used grace period is never given back/);
      expect(await root.graceEpisode.count({ where: { companyId: b.companyId, recordedBy: 'sweeper' } })).toBe(1);
    });

    it('the CHECKs hold whatever writes the row: no fourth grant, no short or late grace, no other window, no record before the end', async () => {
      const end = new Date('2026-06-15T10:00:00.000Z');
      const plus = (ms: number) => new Date(end.getTime() + ms);
      const attempts: Record<string, (b: Business) => Prisma.Sql> = {
        'a fourth grant': (b) => Prisma.sql`(${newUuidV7Bin()}, ${b.companyId}, ${b.subscriptionId}, ${end}, 'granted', ${end}, ${plus(72 * HOUR)}, 3, ${end} - INTERVAL 12 MONTH, ${plus(1000)}, 'sweeper')`,
        'a refusal with uses left': (b) => Prisma.sql`(${newUuidV7Bin()}, ${b.companyId}, ${b.subscriptionId}, ${end}, 'refused', ${end}, ${end}, 2, ${end} - INTERVAL 12 MONTH, ${plus(1000)}, 'sweeper')`,
        '71 hours': (b) => Prisma.sql`(${newUuidV7Bin()}, ${b.companyId}, ${b.subscriptionId}, ${end}, 'granted', ${end}, ${plus(71 * HOUR)}, 0, ${end} - INTERVAL 12 MONTH, ${plus(1000)}, 'sweeper')`,
        'a late start': (b) => Prisma.sql`(${newUuidV7Bin()}, ${b.companyId}, ${b.subscriptionId}, ${end}, 'granted', ${plus(HOUR)}, ${plus(73 * HOUR)}, 0, ${end} - INTERVAL 12 MONTH, ${plus(1000)}, 'sweeper')`,
        'an 11-month window': (b) => Prisma.sql`(${newUuidV7Bin()}, ${b.companyId}, ${b.subscriptionId}, ${end}, 'granted', ${end}, ${plus(72 * HOUR)}, 0, ${end} - INTERVAL 11 MONTH, ${plus(1000)}, 'sweeper')`,
        'recorded before the end': (b) => Prisma.sql`(${newUuidV7Bin()}, ${b.companyId}, ${b.subscriptionId}, ${end}, 'granted', ${end}, ${plus(72 * HOUR)}, 0, ${end} - INTERVAL 12 MONTH, ${plus(-1000)}, 'sweeper')`,
      };
      const insert = (values: Prisma.Sql) =>
        apps[0].$executeRaw`INSERT INTO grace_episodes (id, company_id, subscription_id, period_end, decision, started_at, ends_at, uses_before, window_start, recorded_at, recorded_by) VALUES ${values}`;
      for (const [name, values] of Object.entries(attempts)) {
        const b = await business({ periodEnd: end });
        const refused = await refusedWith(insert(values(b)));
        expect({ name, code: refused?.code ?? null }).toEqual({ name, code: 3819 });
      }
      // The same row done right is accepted — once.
      const b = await business({ periodEnd: end });
      const good = Prisma.sql`(${newUuidV7Bin()}, ${b.companyId}, ${b.subscriptionId}, ${end}, 'granted', ${end}, ${plus(72 * HOUR)}, 0, ${end} - INTERVAL 12 MONTH, ${plus(1000)}, 'sweeper')`;
      await insert(good);
      const again = await refusedWith(insert(Prisma.sql`(${newUuidV7Bin()}, ${b.companyId}, ${b.subscriptionId}, ${end}, 'granted', ${end}, ${plus(72 * HOUR)}, 0, ${end} - INTERVAL 12 MONTH, ${plus(1000)}, 'sweeper')`));
      expect(again?.message).toMatch(/ux_grace_episode_company_period|Duplicate entry|Unique constraint/);
    });

    it('the window is MySQL’s own calendar arithmetic: the application writes the same instant on month ends and leap days', async () => {
      for (const iso of ['2028-02-29T10:00:00.000Z', '2027-03-31T23:59:59.999Z', '2027-05-31T00:00:00.000Z', '2026-12-31T12:30:00.500Z']) {
        const end = new Date(iso);
        const b = await business({ periodEnd: end });
        const outcome = await processOn(apps[0], new TestClock(new Date(end.getTime() + HOUR))).graceRoll.recordIfDue(b.companyId, 'sweeper');
        const [row] = await root.$queryRaw<{ w: Date; m: Date }[]>`SELECT window_start AS w, period_end - INTERVAL 12 MONTH AS m FROM grace_episodes WHERE company_id = ${b.companyId}`;
        expect({ iso, outcome, w: row?.w?.toISOString(), app: graceWindowStart(end).toISOString() }).toEqual({ iso, outcome: 'recorded', w: row?.m?.toISOString(), app: row?.m?.toISOString() });
      }
    });

    it('three granted activations started inside the 12 months before the end refuse the fourth; one exactly 12 months before does not count', async () => {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const end = new Date(now.getTime() - HOUR);
      const full = await business({ periodEnd: end });
      for (const m of [11, 6, 1]) await priorGrace(full, monthsBefore(end, m), 'granted', 0);
      const edge = await business({ periodEnd: end });
      for (const m of [12, 6, 1]) await priorGrace(edge, monthsBefore(end, m), 'granted', 0);
      const proc = processOn(apps[0], new TestClock(now));
      expect(await proc.graceRoll.recordIfDue(full.companyId, 'sweeper')).toBe('recorded');
      expect(await proc.graceRoll.recordIfDue(edge.companyId, 'sweeper')).toBe('recorded');
      const decided = async (b: Business) => root.graceEpisode.findFirstOrThrow({ where: { companyId: b.companyId, periodEnd: end } });
      expect(await decided(full)).toMatchObject({ decision: 'refused', usesBefore: 3, endsAt: end });
      expect(await decided(edge)).toMatchObject({ decision: 'granted', usesBefore: 2 });
      expect(await root.subscriptionEvent.count({ where: { companyId: full.companyId, kind: 'grace_unavailable' } })).toBe(1);
      const state = await proc.entitlement.forCompany(full.companyId);
      expect(state).toMatchObject({ state: 'expired', canWrite: false, grace: expect.objectContaining({ status: 'unavailable', usesRemaining: 0 }) });
    });
  });

  describe('the notice outbox', () => {
    it('two processes refresh one timeline at once, ten times: one row per identity', async () => {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const b = await business({ periodEnd: new Date(now.getTime() + 71 * HOUR) });
      const clock = new TestClock(now);
      const procs = apps.slice(0, 2).map((c) => processOn(c, clock));
      await Promise.all(Array.from({ length: 10 }, (_, i) => procs[i % 2].notices.refresh(b.companyId)));
      const rows = await root.subscriptionNotice.findMany({ where: { companyId: b.companyId } });
      expect(rows.map((r) => `${r.kind}:${r.threshold}:${r.state}`)).toEqual(['paid_reminder:h72:pending']);
    });

    it('two processes deliver at once: every message sent exactly once, its lease released', async () => {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const clock = new TestClock(now);
      const shops = await Promise.all(Array.from({ length: 8 }, (_, i) => business({ periodEnd: new Date(now.getTime() + (23 - i) * HOUR) })));
      const a = processOn(apps[0], clock);
      const b = processOn(apps[1], clock);
      for (const s of shops) await a.notices.refresh(s.companyId);
      for (let round = 0; round < 3; round++) await Promise.all([a.notices.deliverNow(), b.notices.deliverNow()]);
      const phones = new Set(shops.map((s) => s.phone));
      const sent = [...a.whatsapp.messages, ...b.whatsapp.messages].filter((m) => phones.has(m.to));
      note(`deliveries: process A ${a.whatsapp.messages.filter((m) => phones.has(m.to)).length}, process B ${b.whatsapp.messages.filter((m) => phones.has(m.to)).length}`);
      expect(sent).toHaveLength(8);
      expect(new Set(sent.map((m) => m.to)).size).toBe(8);
      const rows = await root.subscriptionNotice.findMany({ where: { companyId: { in: shops.map((s) => s.companyId) } } });
      expect(rows).toHaveLength(8);
      expect(rows.every((r) => r.state === 'accepted' && r.channel === 'whatsapp' && r.claimToken === null && r.claimedUntil === null && r.attempts === 1)).toBe(true);
    });
  });

  describe('the portal claim', () => {
    it('two processes claim at once with one key: one trial — the other answer replays it', async () => {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const b = await business({ status: 'pending_activation', periodEnd: null, eligible: true });
      const clock = new TestClock(now);
      const [p1, p2] = apps.slice(0, 2).map((c) => processOn(c, clock));
      const who = { companyId: b.companyId, userId: b.ownerId };
      const key = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
      const answers = await Promise.all([p1.trial.claim(who, { idempotencyKey: key, termsVersion: TRIAL_TERMS_VERSION }), p2.trial.claim(who, { idempotencyKey: key, termsVersion: TRIAL_TERMS_VERSION })]);
      expect(answers.map((x) => x.replayed).sort()).toEqual([false, true]);
      expect(answers[0].trial.endsAt).toEqual(answers[1].trial.endsAt);
      const claims = await root.trialClaim.findMany({ where: { companyId: b.companyId } });
      expect(claims).toHaveLength(1);
      expect(claims[0].endsAt.getTime() - claims[0].startedAt.getTime()).toBe(168 * HOUR);
    });

    it('two processes claim at once with different keys: one trial, the other refused — it cannot be restarted', async () => {
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const b = await business({ status: 'pending_activation', periodEnd: null, eligible: true });
      const clock = new TestClock(now);
      const [p1, p2] = apps.slice(0, 2).map((c) => processOn(c, clock));
      const who = { companyId: b.companyId, userId: b.ownerId };
      const settled = await Promise.allSettled([
        p1.trial.claim(who, { idempotencyKey: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d', termsVersion: TRIAL_TERMS_VERSION }),
        p2.trial.claim(who, { idempotencyKey: '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e', termsVersion: TRIAL_TERMS_VERSION }),
      ]);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const refused = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(TrialRefusal);
      expect({ code: refused.reason.code, status: refused.reason.getStatus() }).toEqual({ code: 'trial_already_claimed', status: 409 });
      expect(await root.trialClaim.count({ where: { companyId: b.companyId } })).toBe(1);
      // A day later, nothing restarts it either.
      clock.set(new Date(now.getTime() + DAY));
      await expect(p2.trial.claim(who, { idempotencyKey: '2c3d4e5f-6a7b-4c8d-ae9f-0a1b2c3d4e5f', termsVersion: TRIAL_TERMS_VERSION })).rejects.toMatchObject({ code: 'trial_already_claimed' });
    });
  });
});
