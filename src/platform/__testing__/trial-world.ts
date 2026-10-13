import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { EntitlementService } from '../../entitlement/entitlement.service';
import { binToUuid, newUuidV7Bin } from '../../common/utils/uuid.util';
import { TestWhatsAppChannel } from '../../messaging/channels';
import type { EmailChannel, EmailMessage } from '../../messaging/email-channel';
import { TRIAL_SETUP_TEMPLATE } from '../../messaging/templates';
import type { DeliveryResult, WhatsAppChannel } from '../../messaging/whatsapp-channel';
import { PlatformAuditService } from '../platform-audit.service';
import { TrialService } from '../trial/trial.service';
import { TrialSetupService } from '../trial/trial-setup.service';
import type { TrialPrincipal } from '../trial/trial-facts';
import { TRIAL_SETUP_LINK_TTL_HOURS, setupTokenHash, type TrialContact } from '../trial/trial-rules';

/**
 * Businesses, their people, their subscriptions and their free trial rows, held in memory — with the REAL
 * `TrialService` and `TrialSetupService`, the real platform audit and the real entitlement's zone rule running on top
 * (0095; docs/76). The setup instructions go through a recording email channel and the test WhatsApp channel, both
 * real providers by default; a test swaps either for another channel to make it fail, close or disappear.
 *
 * What a database does that a claim leans on is reproduced:
 *
 *  - **one transaction at a time** — `$transaction` runs its callbacks in turn, which is what the subscription row's
 *    `FOR UPDATE` gives every claim (each takes it first); reads outside a transaction interleave freely;
 *  - **all or nothing** — a callback that throws leaves every table as it found it;
 *  - **the unique keys** — one claim per company, one link per token hash — refuse a duplicate with P2002, and a
 *    stale version on the subscription refuses an update with P2025, as MySQL and Prisma would;
 *  - **newest first** — rows ordered by `createdAt` descending, ties by insertion (what time-ordered ids give).
 *
 * Payments, billing periods and seat allocations exist only to be counted: nothing a claim does may add to them.
 */

type Row = Record<string, any>;

export const OWNER_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$owner$hash';
export const REGISTERED_AT = new Date('2026-10-10T09:00:00.000Z');
export const NOW = new Date('2026-10-13T10:00:00.123Z');
/** A fixture pepper, in `.secret-scan-allow` with the others. */
const PEPPER = 'test-pepper-at-least-32-characters-long!!';

interface Tables {
  companies: Row[];
  users: Row[];
  subscriptions: Row[];
  eligibilities: Row[];
  claims: Row[];
  links: Row[];
  /** `trial_setup_messages`: every send attempt, append-only. */
  messages: Row[];
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

/** Equality, `not`, `gt` on an instant and `OR` — what the trial's queries filter on. Anything else is refused loudly. */
function matches(row: Row, where: Row): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(want as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const have = row[key] ?? null;
    if (want !== null && typeof want === 'object' && !Buffer.isBuffer(want) && !(want instanceof Date)) {
      if ('not' in want) {
        if (same(have, want.not)) return false;
      } else if ('gt' in want && want.gt instanceof Date) {
        if (!(have instanceof Date && have.getTime() > want.gt.getTime())) return false;
      } else {
        throw new Error(`trial-world: unsupported filter on ${key}: ${JSON.stringify(want)}`);
      }
    } else if (!same(have, want)) {
      return false;
    }
  }
  return true;
}

/** Newest first: `createdAt` descending, ties by insertion — the only order the trial's queries ask for. */
function newestFirst(rows: Row[], orderBy: unknown): Row[] {
  const order = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
  if (order[0]?.createdAt !== 'desc') throw new Error(`trial-world: unsupported order ${JSON.stringify(orderBy)}`);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime() || b.index - a.index)
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

export interface BusinessOptions {
  name?: string;
  /** The contacts given at registration — and so the ones the Owner must have verified. */
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
  /** The email channel the instructions go through; a recording real provider by default. */
  email?: EmailChannel;
  /** The WhatsApp channel; the test channel (a real provider) by default. */
  whatsapp?: WhatsAppChannel;
  /** PUBLIC_SITE_ORIGIN; `''` means no link can be built. */
  siteOrigin?: string;
  /** WHATSAPP_TEMPLATE_TRIAL_SETUP; `''` means WhatsApp cannot carry the instructions. */
  whatsappTemplate?: string;
}

export const SITE_ORIGIN = 'https://dukan.example.test';

export function makeTrialWorld(options: WorldOptions = {}) {
  let now = options.now ?? NOW;
  const clock = { now: () => now };
  const t: Tables = {
    companies: [],
    users: [],
    subscriptions: [],
    eligibilities: [],
    claims: [],
    links: [],
    messages: [],
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
        out.trialEligibility = pick(t.eligibilities.find((x) => same(x.companyId, c.id)), select.trialEligibility?.select);
        out.trialClaim = pick(claim, select.trialClaim?.select);
        return out;
      },
    },
    user: {
      // The Owner lookup: an active person of the company holding the Owner role. The relation filter is the one
      // shape the service sends; anything else is refused, so a changed query cannot pass here by accident.
      findFirst: async ({ where, select }: Row) => {
        if (where.userBranches?.some?.role?.key !== 'owner') throw new Error('trial-world: unexpected user query');
        const u = t.users.find(
          (x) =>
            same(x.id, where.id) &&
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
        for (const [k, v] of Object.entries(data as Row)) {
          s[k] = v !== null && typeof v === 'object' && 'increment' in v ? s[k] + v.increment : v;
        }
        return pick(s, select);
      },
    },
    trialClaim: {
      create: async ({ data }: Row) => {
        if (t.claims.some((x) => same(x.companyId, data.companyId))) throw duplicate('ux_trial_claim_company');
        t.claims.push({ expiryRecordedAt: null, ...data });
        return { ...data };
      },
    },
    trialSetupLink: {
      findUnique: async ({ where, select }: Row) => pick(t.links.find((x) => x.tokenHash === where.tokenHash), select),
      findFirst: async ({ where, orderBy, select }: Row) => pick(newestFirst(t.links.filter((x) => matches(x, where)), orderBy)[0], select),
      create: async ({ data }: Row) => {
        if (t.links.some((x) => x.tokenHash === data.tokenHash)) throw duplicate('ux_trial_setup_link_token');
        t.links.push({ consumedAt: null, revokedAt: null, revokedReason: null, ...data });
        return { ...data };
      },
      updateMany: async ({ where, data }: Row) => {
        const hits = t.links.filter((x) => matches(x, where));
        for (const h of hits) Object.assign(h, data);
        return { count: hits.length };
      },
    },
    trialSetupMessage: {
      // Append-only, as its triggers keep it: no update, no delete.
      create: async ({ data }: Row) => (t.messages.push({ ...data }), data),
      findFirst: async ({ where, orderBy, select }: Row) =>
        pick(newestFirst(t.messages.filter((x) => matches(x, where)), orderBy ?? { createdAt: 'desc' })[0], select),
      findMany: async ({ where, orderBy, take, select }: Row) =>
        newestFirst(t.messages.filter((x) => matches(x, where)), orderBy ?? { createdAt: 'desc' })
          .slice(0, take ?? undefined)
          .map((r) => pick(r, select)),
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
    otpPepper: PEPPER as string | null,
    publicSiteOrigin: options.siteOrigin ?? SITE_ORIGIN,
    templates: { [TRIAL_SETUP_TEMPLATE.configKey]: options.whatsappTemplate ?? 'erp_trial_setup' } as Record<string, string>,
    whatsappTemplateName(configKey: string): string {
      return this.templates[configKey] ?? '';
    },
  };
  const email = options.email ?? new TestEmailChannel();
  const whatsapp = options.whatsapp ?? new TestWhatsAppChannel();
  const setup = new TrialSetupService(db as never, entitlement, audit, config as never, whatsapp, email, clock);
  const service = new TrialService(db as never, entitlement, audit, config as never, setup, clock);

  let counter = 0;
  /** A business as registration (or the console) leaves it, with its Owner. */
  function business(opts: BusinessOptions = {}): Business {
    counter += 1;
    const companyId = newUuidV7Bin();
    const ownerId = newUuidV7Bin();
    const contacts = opts.contacts ?? 'email';
    const verified = opts.verified ?? (contacts === 'both' ? ['email', 'phone'] : [contacts]);
    const email = contacts !== 'phone' ? `owner${counter}@shop.test` : null;
    const phone = contacts !== 'email' ? `+22236${String(100000 + counter).padStart(6, '0')}` : null;
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
        registrationMethod: contacts,
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
    });
    return { companyId: b.companyId, userId: id };
  }

  /**
   * A setup link as the sending would issue it: a fresh token, only its hash stored, bound to the Owner as they are
   * now, 24 hours. Returns the token — which, outside a test, exists only in the message sent.
   */
  function issueLink(b: Business, opts: { issuedAt?: Date } = {}): string {
    const token = randomBytes(32).toString('base64url');
    const owner = t.users.find((x) => same(x.id, b.ownerId))!;
    const issuedAt = opts.issuedAt ?? now;
    t.links.push({
      id: newUuidV7Bin(),
      companyId: b.companyId,
      userId: b.ownerId,
      tokenHash: setupTokenHash(token),
      bindingDigest: service.bindingDigestFor(owner as never),
      expiresAt: new Date(issuedAt.getTime() + TRIAL_SETUP_LINK_TTL_HOURS * 3600_000),
      consumedAt: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: issuedAt,
    });
    return token;
  }

  const of = (rows: Row[], b: Business) => rows.filter((r) => same(r.companyId, b.companyId));

  return {
    service,
    setup,
    email,
    whatsapp,
    db,
    t,
    locks,
    hooks,
    config,
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
    issueLink,
    owner: (b: Business) => t.users.find((x) => same(x.id, b.ownerId))!,
    subscription: (b: Business) => t.subscriptions.find((x) => same(x.companyId, b.companyId))!,
    eligibility: (b: Business) => t.eligibilities.find((x) => same(x.companyId, b.companyId)) ?? null,
    claims: (b: Business) => of(t.claims, b),
    links: (b: Business) => of(t.links, b),
    link: (token: string) => t.links.find((x) => x.tokenHash === setupTokenHash(token))!,
    messages: (b: Business) => of(t.messages, b),
    events: (b: Business) => of(t.events, b),
    audits: (b: Business) => t.audits.filter((r) => same(r.targetId, b.companyId)),
  };
}

export type TrialWorld = ReturnType<typeof makeTrialWorld>;
