import { Prisma } from '@prisma/client';
import { EntitlementService } from '../../entitlement/entitlement.service';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import { TestWhatsAppChannel } from '../../messaging/channels';
import type { EmailChannel, EmailMessage } from '../../messaging/email-channel';
import { SUBSCRIPTION_TEMPLATES } from '../../messaging/templates';
import type { DeliveryResult, WhatsAppChannel } from '../../messaging/whatsapp-channel';
import type { ContactState } from '../../messaging/whatsapp-records';
import { NoticeService } from '../../notices/notice.service';
import { PlatformAuditService } from '../platform-audit.service';
import { TrialService } from '../trial/trial.service';
import { TrialSetupService } from '../trial/trial-setup.service';
import type { TrialPrincipal } from '../trial/trial-facts';
import type { TrialContact } from '../trial/trial-rules';

/**
 * Businesses, their people, their subscriptions, their free trial rows and their subscription messages, held in memory
 * — with the REAL `TrialService`, `TrialSetupService` and `NoticeService`, the real platform audit and the real
 * entitlement's zone rule running on top (0095, 0099; docs/76, docs/101). The portal instructions go through the test
 * WhatsApp channel and a recording email channel, both real providers by default; a test swaps either for another
 * channel to make it fail, close or hang, and sets what the WhatsApp records know about a number.
 *
 * What a database does that a claim or a message leans on is reproduced:
 *
 *  - **one transaction at a time** — `$transaction` runs its callbacks in turn, which is what the subscription row's
 *    `FOR UPDATE` gives every claim and every request (each takes it first); reads outside a transaction interleave;
 *  - **all or nothing** — a callback that throws leaves every table as it found it;
 *  - **the unique keys** — one claim per company, one message per identity — refuse a duplicate with P2002, and a
 *    stale version on the subscription refuses an update with P2025, as MySQL and Prisma would;
 *  - **ordered reads** — newest first by `createdAt` (ties by insertion, what time-ordered ids give), or by the one
 *    other column a query names.
 *
 * Payments, billing periods and seat allocations exist only to be counted: nothing a claim does may add to them.
 */

type Row = Record<string, any>;

export const OWNER_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$owner$hash';
export const REGISTERED_AT = new Date('2026-10-10T09:00:00.000Z');
export const NOW = new Date('2026-10-13T10:00:00.123Z');
export const PORTAL_URL = 'https://dukan.tsxmr.com/subscription';

interface Tables {
  companies: Row[];
  users: Row[];
  subscriptions: Row[];
  eligibilities: Row[];
  claims: Row[];
  /** `subscription_notices`: the outbox. */
  notices: Row[];
  /** `whatsapp_messages`: only the status a message reached, by its idempotency key. */
  whatsappMessages: Row[];
  /** `grace_episodes`: the decision recorded at a paid period end (0099). */
  graces: Row[];
  /** `registration_attempts`: only the language the business registered in. */
  registrations: Row[];
  events: Row[];
  audits: Row[];
  payments: Row[];
  periods: Row[];
  seats: Row[];
}

function same(a: unknown, b: unknown): boolean {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

const time = (v: unknown): number | null => (v instanceof Date ? v.getTime() : null);

/** Equality, `not`, `in`, the four comparisons on an instant, `OR` and `NOT` — what the queries here filter on. Anything else is refused loudly. */
function matches(row: Row, where: Row): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(want as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matches(row, want as Row)) return false;
      continue;
    }
    const have = row[key] ?? null;
    if (want !== null && typeof want === 'object' && !Buffer.isBuffer(want) && !(want instanceof Date)) {
      for (const [op, value] of Object.entries(want as Row)) {
        const t = time(have);
        const ok =
          op === 'not' ? !same(have, value) :
          op === 'in' ? (value as unknown[]).some((v) => same(have, v)) :
          op === 'gt' ? t !== null && t > time(value)! :
          op === 'gte' ? t !== null && t >= time(value)! :
          op === 'lt' ? t !== null && t < time(value)! :
          op === 'lte' ? t !== null && t <= time(value)! :
          (() => {
            throw new Error(`trial-world: unsupported filter on ${key}: ${JSON.stringify(want)}`);
          })();
        if (!ok) return false;
      }
    } else if (!same(have, want)) {
      return false;
    }
  }
  return true;
}

/** Ordered by the first column named — `createdAt` (ties by insertion), `acceptedAt` or `nextAttemptAt` — the only orders asked for. */
function ordered(rows: Row[], orderBy: unknown): Row[] {
  const first = ((Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[])[0] ?? { createdAt: 'desc' };
  const [column, direction] = Object.entries(first)[0] as [string, 'asc' | 'desc'];
  if (!['createdAt', 'acceptedAt', 'nextAttemptAt'].includes(column)) throw new Error(`trial-world: unsupported order ${JSON.stringify(orderBy)}`);
  const sign = direction === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => sign * ((time(a.row[column]) ?? 0) - (time(b.row[column]) ?? 0)) || sign * (a.index - b.index))
    .map(({ row }) => row);
}

/**
 * An email provider that records what it was asked to send and answers as a test needs: accepted unless `next` says
 * otherwise. Named `resend`, so the sending treats it as the real provider it stands for.
 */
export class TestEmailChannel implements EmailChannel {
  readonly name: string = 'resend';
  readonly isEnabled: boolean = true;
  readonly sent: EmailMessage[] = [];
  next: DeliveryResult | null = null;

  async send(message: EmailMessage): Promise<DeliveryResult> {
    this.sent.push(message);
    return this.next ?? { status: 'accepted', providerMessageId: `em-${this.sent.length}`, provider: this.name };
  }
}

/**
 * A WhatsApp provider that answers only when told to — what a provider that hangs looks like from the sending, for as
 * long as a test needs it to (C14). `called` settles at its first request.
 */
export class HangingWhatsAppChannel implements WhatsAppChannel {
  readonly name = 'test';
  readonly isEnabled = true;
  readonly calls: unknown[] = [];
  private readonly waiting: ((r: DeliveryResult) => void)[] = [];
  private arrived: () => void = () => undefined;
  readonly called = new Promise<void>((resolve) => {
    this.arrived = resolve;
  });

  send(message: unknown): Promise<DeliveryResult> {
    this.calls.push(message);
    this.arrived();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  answer(result: DeliveryResult = { status: 'accepted', providerMessageId: `wa-${this.calls.length}`, provider: this.name }): void {
    this.waiting.shift()!(result);
  }
}

/** Fake timers for the bounded waits: only the timers — promises, the world's clock and everything else run as they do. */
export const TIMERS_ONLY: Parameters<typeof jest.useFakeTimers>[0] = {
  doNotFake: ['Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate'],
};

function pick(row: Row | null | undefined, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k] ?? null;
  return out;
}

function duplicate(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target } });
}

function notFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record to update not found', { code: 'P2025', clientVersion: 'test' });
}

/** What an update's data does to a row: values set, `{ increment }` added. */
function apply(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) row[k] = v !== null && typeof v === 'object' && 'increment' in v ? (row[k] ?? 0) + v.increment : v;
}

export interface BusinessOptions {
  name?: string;
  /** The contacts given at registration. */
  contacts?: 'email' | 'phone' | 'both';
  /** Which of them the Owner has verified. */
  verified?: TrialContact[];
  /** Registered itself (eligible) or created from the console (not). */
  eligible?: boolean;
  eligibilityClosed?: 'approved' | 'granted' | 'paid_period' | 'refused' | 'cancelled';
  status?: 'pending_activation' | 'activated' | 'suspended' | 'cancelled' | 'rejected';
  currentPeriodEnd?: Date | null;
  complimentaryUntil?: Date | null;
  timezone?: string;
  /** Closed by its Owner (account deletion): inactive, with a closure instant. */
  closed?: boolean;
  /** No subscription row at all — the demo company. */
  noSubscription?: boolean;
  /** The language it registered in. */
  language?: 'en' | 'fr' | 'ar';
}

export interface Business {
  companyId: Buffer;
  ownerId: Buffer;
  owner: TrialPrincipal;
  email: string | null;
  phone: string | null;
}

export interface WorldOptions {
  now?: Date;
  /** The email channel the fallback goes through; a recording real provider by default. */
  email?: EmailChannel;
  /** The WhatsApp channel; the test channel (a real provider) by default. */
  whatsapp?: WhatsAppChannel;
  /** The approved WhatsApp template names; every subscription template is named by default. */
  templates?: Record<string, string>;
  /** `<PORTAL_ORIGIN>/subscription`; `''` means no email can carry a message. */
  portalUrl?: string;
  /** WHATSAPP_MODE: `live` asks for a recorded consent before an optional message. */
  whatsappMode?: 'test' | 'live';
}

const NO_CONTACT: ContactState = { optOutScope: 'none', consented: false, lastInboundAt: null, undeliverableAt: null };

export function makeTrialWorld(options: WorldOptions = {}) {
  let now = options.now ?? NOW;
  const clock = { now: () => now };
  const t: Tables = {
    companies: [],
    users: [],
    subscriptions: [],
    eligibilities: [],
    claims: [],
    notices: [],
    whatsappMessages: [],
    graces: [],
    registrations: [],
    events: [],
    audits: [],
    payments: [],
    periods: [],
    seats: [],
  };
  /** Every subscription lock taken, in order, with the company it locked. */
  const locks: string[] = [];
  const hooks = {
    /** Runs when a lock is taken — a claim that waited for it, say. */
    onLock: null as null | (() => void),
    /** Hide the claims from the next N readings inside a transaction: a claim that read before another committed. */
    hideClaims: 0,
  };
  let inTransaction = false;
  /** What the WhatsApp records know about a number (opt-out, consent, undeliverable). */
  const contacts = new Map<string, ContactState>();

  const db: Row = {
    company: {
      findUnique: async ({ where, select }: Row) => {
        const c = t.companies.find((x) => same(x.id, where.id));
        if (!c) return null;
        const sub = t.subscriptions.find((x) => same(x.companyId, c.id));
        const hide = inTransaction && hooks.hideClaims > 0;
        if (hide) hooks.hideClaims -= 1;
        const claim = hide ? null : t.claims.find((x) => same(x.companyId, c.id));
        const out: Row = pick(c, { name: true, timezone: true, isActive: true, closedAt: true })!;
        out.subscription = pick(sub, select.subscription?.select);
        if (select.trialEligibility) out.trialEligibility = pick(t.eligibilities.find((x) => same(x.companyId, c.id)), select.trialEligibility.select);
        out.trialClaim = pick(claim, select.trialClaim?.select);
        return out;
      },
    },
    user: {
      // The Owner lookup: an active person of the company holding the Owner role — the given one, or the first. The
      // relation filter is the one shape the services send; anything else is refused, so a changed query cannot pass.
      findFirst: async ({ where, select }: Row) => {
        if (where.userBranches?.some?.role?.key !== 'owner') throw new Error('trial-world: unexpected user query');
        const u = t.users.find(
          (x) =>
            (where.id === undefined || same(x.id, where.id)) &&
            same(x.companyId, where.companyId) &&
            x.isActive === where.isActive &&
            x.deletedAt === where.deletedAt &&
            x.roleKey === 'owner',
        );
        return pick(u, select);
      },
      findUnique: async ({ where, select }: Row) => pick(t.users.find((x) => same(x.id, where.id)), select),
    },
    subscription: {
      findFirst: async ({ where }: Row) => {
        const s = t.subscriptions.find((x) => same(x.companyId, where.companyId));
        if (!s) return null;
        const c = t.companies.find((x) => same(x.id, s.companyId))!;
        return { ...s, company: { name: c.name, publicStoreId: 'ABCDEF1234' } };
      },
      update: async ({ where, data, select }: Row) => {
        const s = t.subscriptions.find((x) => same(x.companyId, where.companyId));
        if (!s || (where.version !== undefined && s.version !== where.version)) throw notFound();
        apply(s, data);
        return pick(s, select);
      },
    },
    // The company's grace history (0099): the decisions a test recorded; a trial never has any.
    graceEpisode: {
      findMany: async () => [],
      findFirst: async ({ where, select }: Row) => pick(t.graces.find((x) => matches(x, where)), select),
      count: async () => 0,
    },
    trialClaim: {
      create: async ({ data }: Row) => {
        if (t.claims.some((x) => same(x.companyId, data.companyId))) throw duplicate('ux_trial_claim_company');
        t.claims.push({ expiryRecordedAt: null, ...data });
        return { ...data };
      },
    },
    subscriptionNotice: {
      create: async ({ data }: Row) => {
        const identity = (x: Row) => same(x.companyId, data.companyId) && x.periodKey === data.periodKey && x.kind === data.kind && x.threshold === data.threshold;
        if (t.notices.some(identity)) throw duplicate('ux_subscription_notice_identity');
        const row = {
          state: 'pending',
          channel: null,
          variant: null,
          whatsappOutcome: null,
          emailOutcome: null,
          fallbackReason: null,
          failureReason: null,
          destinationMasked: null,
          destinationHash: null,
          requestedByUserId: null,
          attempts: 0,
          claimToken: null,
          claimedUntil: null,
          acceptedAt: null,
          completedAt: null,
          cancelReason: null,
          ...data,
        };
        t.notices.push(row);
        return { ...row };
      },
      findUnique: async ({ where, select }: Row) => pick(t.notices.find((x) => same(x.id, where.id)), select),
      findFirst: async ({ where, orderBy, select }: Row) => pick(ordered(t.notices.filter((x) => matches(x, where)), orderBy)[0], select),
      findMany: async ({ where, orderBy, take, select }: Row) =>
        ordered(t.notices.filter((x) => matches(x, where)), orderBy)
          .slice(0, take ?? undefined)
          .map((r) => pick(r, select)),
      updateMany: async ({ where, data }: Row) => {
        const hits = t.notices.filter((x) => matches(x, where));
        for (const h of hits) apply(h, data);
        return { count: hits.length };
      },
    },
    whatsAppMessage: {
      findMany: async ({ where, select }: Row) => t.whatsappMessages.filter((x) => matches(x, where)).map((r) => pick(r, select)),
    },
    trialEligibility: {
      findUnique: async ({ where, select }: Row) => pick(t.eligibilities.find((x) => same(x.companyId, where.companyId)), select),
    },
    registrationAttempt: {
      findFirst: async ({ where, select }: Row) => pick(t.registrations.find((x) => same(x.companyId, where.companyId)), select),
    },
    subscriptionEvent: {
      create: async ({ data }: Row) => (t.events.push({ ...data }), data),
    },
    platformAuditEvent: {
      create: async ({ data }: Row) => (t.audits.push({ ...data }), data),
    },
    $queryRaw: async (q: { strings?: readonly string[]; values?: unknown[] }) => {
      const text = (q.strings ?? []).join('?').replace(/\s+/g, ' ').trim();
      if (!/^SELECT id FROM subscriptions WHERE company_id = \? FOR UPDATE$/.test(text)) {
        throw new Error(`trial-world: unexpected raw query "${text}"`);
      }
      locks.push(binToUuid(q.values?.[0] as Buffer));
      hooks.onLock?.();
      return [];
    },
  };

  let queue: Promise<unknown> = Promise.resolve();
  db.$transaction = (fn: (tx: Row) => Promise<unknown>) => {
    const run = queue.then(async () => {
      const saved = Object.fromEntries(Object.entries(t).map(([k, rows]) => [k, (rows as Row[]).map((r) => ({ ...r }))]));
      inTransaction = true;
      try {
        return await fn(db);
      } catch (e) {
        for (const k of Object.keys(t) as (keyof Tables)[]) {
          t[k].length = 0;
          t[k].push(...(saved[k] as Row[]));
        }
        throw e;
      } finally {
        inTransaction = false;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const entitlement = new EntitlementService(db as never, {} as never, clock);
  const audit = new PlatformAuditService(db as never);
  const config = {
    whatsappMode: options.whatsappMode ?? 'test',
    portalSubscriptionUrl: options.portalUrl ?? PORTAL_URL,
    templates: options.templates ?? (Object.fromEntries(SUBSCRIPTION_TEMPLATES.map((x) => [x.configKey, `erp_${x.key.replace('.', '_')}`])) as Record<string, string>),
    whatsappTemplateName(configKey: string): string {
      return this.templates[configKey] ?? '';
    },
  };
  const records = { contactState: async (phone: string) => contacts.get(phone) ?? NO_CONTACT };
  const hasher = { hash: (value: string) => `hash:${value.trim().toLowerCase()}` };
  const email = options.email ?? new TestEmailChannel();
  const whatsapp = options.whatsapp ?? new TestWhatsAppChannel();
  const notices = new NoticeService(db as never, config as never, entitlement, records as never, hasher as never, whatsapp, email, clock);
  const setup = new TrialSetupService(db as never, entitlement, audit, notices, clock);
  const service = new TrialService(db as never, entitlement, audit, setup, clock);

  let counter = 0;
  /** A business as registration (or the console) leaves it, with its Owner. */
  function business(opts: BusinessOptions = {}): Business {
    counter += 1;
    const companyId = newUuidV7Bin();
    const ownerId = newUuidV7Bin();
    const contactsGiven = opts.contacts ?? 'phone';
    const verified = opts.verified ?? (contactsGiven === 'both' ? ['email', 'phone'] : [contactsGiven]);
    const email = contactsGiven !== 'phone' ? `owner${counter}@shop.test` : null;
    const phone = contactsGiven !== 'email' ? `+22236${String(100000 + counter).padStart(6, '0')}` : null;
    t.companies.push({
      id: companyId,
      name: opts.name ?? `Shop ${counter}`,
      timezone: opts.timezone ?? 'Africa/Nouakchott',
      isActive: !opts.closed,
      closedAt: opts.closed ? REGISTERED_AT : null,
    });
    t.registrations.push({ companyId, language: opts.language ?? 'en' });
    t.users.push({
      id: ownerId,
      companyId,
      roleKey: 'owner',
      email,
      phone,
      emailVerifiedAt: email && verified.includes('email') ? REGISTERED_AT : null,
      phoneVerifiedAt: phone && verified.includes('phone') ? REGISTERED_AT : null,
      passwordHash: OWNER_PASSWORD_HASH,
      isActive: !opts.closed,
      deletedAt: null,
      createdAt: REGISTERED_AT,
    });
    if (!opts.noSubscription) {
      t.subscriptions.push({
        id: newUuidV7Bin(),
        companyId,
        status: opts.status ?? 'pending_activation',
        currentPeriodEnd: opts.currentPeriodEnd ?? null,
        isComplimentary: !!opts.complimentaryUntil,
        complimentaryUntil: opts.complimentaryUntil ?? null,
        subscribedBranchCount: 1,
        additionalSeats: 0,
        version: 4,
      });
    }
    if (opts.eligible ?? true) {
      t.eligibilities.push({
        id: newUuidV7Bin(),
        companyId,
        ownerUserId: ownerId,
        registrationMethod: contactsGiven,
        basis: 'self_registration',
        createdAt: REGISTERED_AT,
        closedAt: opts.eligibilityClosed ? REGISTERED_AT : null,
        closedReason: opts.eligibilityClosed ?? null,
      });
    }
    return { companyId, ownerId, owner: { companyId, userId: ownerId }, email, phone };
  }

  /** Somebody else at the business: a Manager, an Employee, or a legacy administrator. */
  function staff(b: Business, roleKey: 'store_manager' | 'store_employee' | 'administrator'): TrialPrincipal {
    const id = newUuidV7Bin();
    t.users.push({
      id,
      companyId: b.companyId,
      roleKey,
      email: `${roleKey}.${binToUuid(id).slice(-6)}@shop.test`,
      phone: null,
      emailVerifiedAt: REGISTERED_AT,
      phoneVerifiedAt: null,
      passwordHash: OWNER_PASSWORD_HASH,
      isActive: true,
      deletedAt: null,
      createdAt: REGISTERED_AT,
    });
    return { companyId: b.companyId, userId: id };
  }

  const of = (rows: Row[], b: Business) => rows.filter((r) => same(r.companyId, b.companyId));

  return {
    service,
    setup,
    notices,
    email,
    whatsapp,
    db,
    t,
    locks,
    hooks,
    config,
    /** What the WhatsApp records know about a number. */
    contact: (phone: string, state: Partial<ContactState>) => contacts.set(phone, { ...NO_CONTACT, ...state }),
    /** The decision recorded at the business's current paid period end, as the sweeper would write it. */
    grace: (b: Business, decision: 'granted' | 'refused', usesBefore = 0) => {
      const sub = t.subscriptions.find((x) => same(x.companyId, b.companyId))!;
      const end = sub.currentPeriodEnd as Date;
      t.graces.push({
        companyId: b.companyId,
        periodEnd: end,
        decision,
        startedAt: end,
        endsAt: decision === 'granted' ? new Date(end.getTime() + 72 * 3600_000) : end,
        usesBefore,
      });
    },
    /** A provider status for a message sent under this idempotency key, as the webhook records it. */
    whatsappStatus: (idempotencyKey: string, status: string) => {
      const row = t.whatsappMessages.find((x) => x.idempotencyKey === idempotencyKey);
      if (row) row.status = status;
      else t.whatsappMessages.push({ idempotencyKey, status });
    },
    clock: {
      now: () => now,
      set: (d: Date) => {
        now = d;
      },
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    },
    business,
    staff,
    owner: (b: Business) => t.users.find((x) => same(x.id, b.ownerId))!,
    subscription: (b: Business) => t.subscriptions.find((x) => same(x.companyId, b.companyId))!,
    eligibility: (b: Business) => t.eligibilities.find((x) => same(x.companyId, b.companyId)) ?? null,
    claims: (b: Business) => of(t.claims, b),
    noticesOf: (b: Business) => of(t.notices, b),
    events: (b: Business) => of(t.events, b),
    audits: (b: Business) => t.audits.filter((r) => same(r.targetId, b.companyId)),
  };
}

export type TrialWorld = ReturnType<typeof makeTrialWorld>;
