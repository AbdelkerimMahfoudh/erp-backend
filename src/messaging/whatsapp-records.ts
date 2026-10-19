import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { maskDestination } from './channels';
import { RecipientHasher } from './recipient-hash';
import { CONSENT_PURPOSES, isCurrentConsentVersion, type ConsentLocale, type ConsentSource } from './whatsapp-consent';
import type { DeliveryResult, E164, MessageLanguage } from './whatsapp-channel';
import type { TemplateUse } from './templates';

/**
 * The WhatsApp records (0098; D181): message statuses, what is known about a number (opt-out, the 24-hour window,
 * undeliverability) and the consent history. Every number is stored as a keyed hash and a masked form; no variable,
 * code, token or message text is ever written here.
 */

/** `optional` is a STOP recorded before D213 (2026-10-19); a withdrawal is `all`. Both stop proactive messages. */
export type OptOutScope = 'none' | 'optional' | 'all';

/**
 * Where a number's consent stands (D213):
 *  - `none` — never agreed (an account from before D213 included);
 *  - `pending` — the box was ticked and a code asked for, within 24 hours, and the number is not verified yet;
 *  - `active` — agreed to the copy in force, for a verified number: the only state that lets an operational message go;
 *  - `outdated` — agreed to an earlier copy;
 *  - `withdrawn` — withdrawn in the app or by STOP;
 *  - `superseded` — the number stopped being the person's verified number.
 */
export type ConsentState = 'none' | 'pending' | 'active' | 'outdated' | 'withdrawn' | 'superseded';

export interface ContactState {
  optOutScope: OptOutScope;
  /** The newest decision is an activation of the copy in force. */
  consented: boolean;
  consent: ConsentState;
  /**
   * A pending agreement for this number: the copy in force, under {@link PENDING_CONSENT_TTL_MS}, not concluded, and
   * newer than the newest decision. It authorises only the code that verifies the number — nothing proactive.
   */
  pendingLive: boolean;
  /** The version of the newest agreement (pending or active), whatever came after it. */
  consentVersion: string | null;
  /** When the consent in force became active; null unless `consented`. */
  consentedAt: Date | null;
  /** When it was withdrawn; null unless the newest decision is a withdrawal. */
  withdrawnAt: Date | null;
  lastInboundAt: Date | null;
  undeliverableAt: Date | null;
}

const NO_CONTACT: ContactState = {
  optOutScope: 'none',
  consented: false,
  consent: 'none',
  pendingLive: false,
  consentVersion: null,
  consentedAt: null,
  withdrawnAt: null,
  lastInboundAt: null,
  undeliverableAt: null,
};

/**
 * How long a ticked box waits for its number to be verified: 24 hours. Every code that could verify it lives far less
 * (registration and contact codes 10 minutes, a registration's continuation 15, an OTP its configured minutes), so a
 * pending agreement outlives any code it was asked with, and an abandoned one stops authorising anything a day later.
 */
export const PENDING_CONSENT_TTL_MS = 24 * 60 * 60 * 1000;

/** The events that decide whether a number has a consent in force; a pending agreement is not one of them. */
const DECISIONS = ['active', 'granted', 'withdrawn', 'superseded'];

/** One event of a number's consent history, as its owner is shown it: masked, never the hash. */
export interface ConsentEvent {
  event: 'pending_unverified' | 'active' | 'withdrawn' | 'superseded' | 'expired' | 'cancelled' | 'granted' | 'opted_out_optional';
  version: string | null;
  locale: string | null;
  source: string;
  at: Date;
}

/** Whether an agreement, a withdrawal or a replacement was written, or the same one was already there (a replay). */
export type ConsentWrite = 'recorded' | 'unchanged';

/** What verifying a number did to its pending agreement. */
export type ActivationOutcome = 'activated' | 'unchanged' | 'no_pending';

/** A pending agreement written or found: whether it is new, and its row (what an employee invitation is bound to). */
export interface PendingWrite {
  write: ConsentWrite;
  pendingId: Buffer;
}

/** The input of a pending agreement. */
export interface PendingInput {
  number: E164;
  version: string;
  locale: ConsentLocale;
  companyId: Buffer | null;
  userId: Buffer | null;
  source: ConsentSource;
  ip?: string | null;
}

type ConsentDb = Pick<Prisma.TransactionClient, 'whatsAppConsent' | 'whatsAppContact' | 'auditLog' | '$queryRaw'>;

/** The customer-service window (D181): 24 hours from the person's last inbound message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function serviceWindowOpen(lastInboundAt: Date | null, now: Date = new Date()): boolean {
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS && now >= lastInboundAt;
}

/** The provider's statuses, in the only order they may be recorded. */
const RANK: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3 };

/**
 * The next recorded status, or null to ignore the event: statuses move forward only, `failed` only before
 * delivery (a late failure never overwrites delivered or read), and nothing moves a failed or refused send.
 */
export function nextStatus(current: string, incoming: string): string | null {
  if (current === 'failed' || current === 'refused') return null;
  const from = RANK[current];
  if (from === undefined) return null;
  if (incoming === 'failed') return from < RANK.delivered ? 'failed' : null;
  const to = RANK[incoming];
  if (to === undefined || to === RANK.accepted) return null;
  return to > from ? incoming : null;
}

export interface SendRecord {
  idempotencyKey: string;
  to: E164;
  template: string;
  use: TemplateUse;
  language: MessageLanguage;
  mode: 'test' | 'live';
  phoneNumberId: string;
  result: DeliveryResult;
  /** Refused by the policy before any provider was called. */
  refused: boolean;
}

export interface StatusOutcome {
  /** Whether the record moved. Unknown messages (sent before 0098, or by another system) are not recorded here. */
  applied: boolean;
  known: boolean;
  status: string | null;
  recipientHash: string | null;
}

@Injectable()
export class WhatsAppRecords {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: RecipientHasher,
  ) {}

  hashOf(number: E164): string {
    return this.hasher.hash(number);
  }

  async contactState(number: E164): Promise<ContactState> {
    return this.contactStateByHash(this.hasher.hash(number));
  }

  async contactStateByHash(numberHash: string, now: Date = new Date()): Promise<ContactState> {
    const [contact, newest, pending] = await Promise.all([
      this.prisma.whatsAppContact.findUnique({ where: { numberHash } }),
      this.newestDecision(this.prisma, numberHash),
      this.prisma.whatsAppConsent.findFirst({
        where: { numberHash, event: 'pending_unverified' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, version: true, createdAt: true },
      }),
    ]);
    if (!contact && !newest && !pending) return NO_CONTACT;
    const pendingLive =
      pending !== null &&
      (await this.isLive(this.prisma, pending, now)) &&
      (!newest || pending.createdAt.getTime() >= newest.createdAt.getTime());
    const agreed = newest?.event === 'active' || newest?.event === 'granted';
    const current = agreed && isCurrentConsentVersion(newest.version);
    const decided: ConsentState = !newest
      ? 'none'
      : agreed
        ? current
          ? 'active'
          : 'outdated'
        : (newest.event as 'withdrawn' | 'superseded');
    const agreements: { version: string | null; createdAt: Date }[] = [];
    if (pending) agreements.push(pending);
    if (agreed) agreements.push(newest);
    const latestAgreement = agreements.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0];
    return {
      optOutScope: (contact?.optOutScope as OptOutScope | undefined) ?? 'none',
      consented: current,
      consent: !current && pendingLive ? 'pending' : decided,
      pendingLive,
      consentVersion: latestAgreement?.version ?? null,
      consentedAt: current ? newest.createdAt : null,
      withdrawnAt: newest?.event === 'withdrawn' ? newest.createdAt : null,
      lastInboundAt: contact?.lastInboundAt ?? null,
      undeliverableAt: contact?.undeliverableAt ?? null,
    };
  }

  /**
   * A number's consent history, newest first — the events this person made or that concern their own agreements, and
   * the keyword withdrawals nobody made from an account. Another business's actions on the same number decide the state
   * but are not listed here.
   */
  async consentHistory(number: E164, actorUserId: Buffer, take = 20): Promise<ConsentEvent[]> {
    const rows = await this.prisma.whatsAppConsent.findMany({
      where: { numberHash: this.hasher.hash(number), OR: [{ actorUserId }, { actorUserId: null }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { event: true, version: true, locale: true, source: true, createdAt: true },
    });
    return rows.map((r) => ({ event: r.event as ConsentEvent['event'], version: r.version ?? null, locale: r.locale ?? null, source: r.source, at: r.createdAt }));
  }

  /** The newest decision about a number — activation, withdrawal or replacement: what its consent is now. */
  private newestDecision(db: Pick<ConsentDb, 'whatsAppConsent'>, numberHash: string) {
    return db.whatsAppConsent.findFirst({
      where: { numberHash, event: { in: DECISIONS } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { event: true, version: true, actorUserId: true, createdAt: true },
    });
  }

  /** A pending agreement still waiting: the copy in force, under 24 hours, and neither activated nor expired. */
  private async isLive(db: Pick<ConsentDb, 'whatsAppConsent'>, pending: { id: Buffer; version: string | null; createdAt: Date }, now: Date): Promise<boolean> {
    if (!isCurrentConsentVersion(pending.version)) return false;
    if (now.getTime() - pending.createdAt.getTime() >= PENDING_CONSENT_TTL_MS) return false;
    const concluded = await db.whatsAppConsent.findFirst({ where: { pendingId: pending.id }, select: { event: true } });
    return concluded === null;
  }

  async messageExists(idempotencyKey: string): Promise<boolean> {
    const row = await this.prisma.whatsAppMessage.findUnique({ where: { idempotencyKey }, select: { id: true } });
    return row !== null;
  }

  /**
   * One row per logical message. A retry (same key) adds an attempt and may replace a failure or a refusal; it never
   * moves a message the provider already accepted.
   */
  async recordSend(r: SendRecord): Promise<void> {
    const now = new Date();
    const outcome =
      r.result.status === 'accepted'
        ? { status: 'accepted', providerMessageId: r.result.providerMessageId, failureReason: null, errorCode: null, detail: null }
        : {
            status: r.refused ? 'refused' : 'failed',
            providerMessageId: null,
            failureReason: r.result.reason,
            errorCode: r.result.providerCode ?? null,
            detail: r.result.detail.slice(0, 200),
          };
    const touched = await this.prisma.whatsAppMessage.updateMany({
      where: { idempotencyKey: r.idempotencyKey, status: { in: ['failed', 'refused'] } },
      data: { ...outcome, attempts: { increment: 1 }, statusAt: now, failedAt: outcome.status === 'failed' ? now : null },
    });
    if (touched.count > 0) return;
    try {
      await this.prisma.whatsAppMessage.create({
        data: {
          id: newUuidV7Bin(),
          idempotencyKey: r.idempotencyKey,
          phoneNumberId: r.phoneNumberId.slice(0, 40),
          mode: r.mode,
          template: r.template,
          templateUse: r.use,
          language: r.language,
          recipientHash: this.hasher.hash(r.to),
          recipientMasked: maskDestination(r.to),
          attempts: 1,
          statusAt: now,
          failedAt: outcome.status === 'failed' ? now : null,
          ...outcome,
        },
      });
    } catch (e) {
      // The key exists and is past `failed` (accepted, delivered…): the earlier record stands.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
  }

  /** A signed status from the webhook, applied forward-only. */
  async applyProviderStatus(providerMessageId: string, incoming: string, errorCode: number | null, at: Date): Promise<StatusOutcome> {
    const row = await this.prisma.whatsAppMessage.findUnique({
      where: { providerMessageId },
      select: { id: true, status: true, recipientHash: true },
    });
    if (!row) return { applied: false, known: false, status: null, recipientHash: null };
    const next = nextStatus(row.status, incoming);
    if (!next) return { applied: false, known: true, status: row.status, recipientHash: row.recipientHash };
    const moved = await this.prisma.whatsAppMessage.updateMany({
      // Conditional on the status read, so two workers racing on one message cannot move it backwards.
      where: { id: row.id, status: row.status },
      data: {
        status: next,
        statusAt: at,
        ...(next === 'delivered' ? { deliveredAt: at } : {}),
        ...(next === 'read' ? { readAt: at } : {}),
        ...(next === 'failed'
          ? { failedAt: at, errorCode, failureReason: 'rejected', detail: `Provider reported failure${errorCode !== null ? ` (code ${errorCode})` : ''}` }
          : {}),
      },
    });
    return { applied: moved.count === 1, known: true, status: moved.count === 1 ? next : row.status, recipientHash: row.recipientHash };
  }

  /** An inbound message: the window moves, and a STOP/START keyword (decided in memory, text discarded) applies. */
  async applyInbound(senderHash: string, senderMasked: string, at: Date, signal: 'stop' | 'start' | null): Promise<void> {
    await this.ensureContact(senderHash, senderMasked);
    await this.prisma.whatsAppContact.updateMany({
      where: { numberHash: senderHash, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }] },
      data: { lastInboundAt: at },
    });
    if (signal === 'stop') {
      // STOP withdraws the operational consent (D213): recorded in the history like the app's withdrawal, by nobody's
      // account. START grants nothing — a consent is given only with the copy in front of the person.
      await this.withdraw({ numberHash: senderHash, numberMasked: senderMasked, companyId: null, userId: null, source: 'inbound_keyword' });
    }
  }

  async markUndeliverable(number: E164): Promise<void> {
    await this.markUndeliverableByHash(this.hasher.hash(number), maskDestination(number));
  }

  async markUndeliverableByHash(numberHash: string, numberMasked = '***'): Promise<void> {
    await this.ensureContact(numberHash, numberMasked);
    await this.prisma.whatsAppContact.updateMany({ where: { numberHash }, data: { undeliverableAt: new Date() } });
  }

  /**
   * The box ticked and a code asked for (D213): a `pending_unverified` agreement for this number, by this person, with
   * the version, the language shown, the source and an audit event — never the consent in force. It authorises only the
   * code that verifies the number; the number's verification activates it ({@link activatePending}). A replay (this
   * person's pending agreement to this version, still waiting) writes nothing.
   */
  async recordPending(p: PendingInput): Promise<ConsentWrite> {
    return (await this.pending(p)).write;
  }

  /**
   * {@link recordPending}, answering with the pending row — written now, or this person's own still waiting — and, given
   * a transaction, writing in it: an employee invitation is bound to the row in the same commit (0101, D214).
   */
  async pending(p: PendingInput, tx?: Prisma.TransactionClient): Promise<PendingWrite> {
    if (!isCurrentConsentVersion(p.version)) throw new Error('Unknown WhatsApp consent version');
    const numberHash = this.hasher.hash(p.number);
    const numberMasked = maskDestination(p.number);
    await this.ensureContact(numberHash, numberMasked);
    const run = async (db: ConsentDb): Promise<PendingWrite> => {
      await this.lock(db, numberHash);
      const mine = await db.whatsAppConsent.findFirst({
        where: { numberHash, event: 'pending_unverified', actorUserId: p.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, version: true, createdAt: true },
      });
      const newest = await this.newestDecision(db, numberHash);
      if (mine && mine.version === p.version && (await this.isLive(db, mine, new Date())) && (!newest || mine.createdAt >= newest.createdAt)) {
        return { write: 'unchanged', pendingId: mine.id };
      }
      const id = newUuidV7Bin();
      await db.whatsAppConsent.create({
        data: {
          id,
          numberHash,
          numberMasked,
          event: 'pending_unverified',
          version: p.version,
          locale: p.locale,
          purposes: CONSENT_PURPOSES.join(','),
          actorCompanyId: p.companyId,
          actorUserId: p.userId,
          source: p.source,
        },
      });
      if (p.companyId) {
        await db.auditLog.create({
          data: {
            companyId: p.companyId,
            userId: p.userId,
            entityType: 'WhatsAppConsent',
            entityId: id,
            action: 'create',
            after: { event: 'pending_unverified', version: p.version, locale: p.locale, purposes: [...CONSENT_PURPOSES], number: numberMasked, source: p.source },
            reason: 'Operational WhatsApp consent given; waiting for the number to be verified',
            ip: p.ip ?? null,
          },
        });
      }
      return { write: 'recorded', pendingId: id };
    };
    return tx ? run(tx) : this.prisma.$transaction((t) => run(t));
  }

  /** Whether this exact pending agreement still waits: the copy in force, under 24 hours, concluded by nothing. */
  async pendingIsLive(pendingId: Buffer, now: Date = new Date(), tx?: Prisma.TransactionClient): Promise<boolean> {
    const db = tx ?? this.prisma;
    const row = await db.whatsAppConsent.findUnique({ where: { id: pendingId }, select: { id: true, event: true, version: true, createdAt: true } });
    return row !== null && row.event === 'pending_unverified' && (await this.isLive(db, row, now));
  }

  /**
   * An employee invitation ended before its number was verified — the Owner cancelled the account or issued a new
   * invitation (0101, D214): its pending agreement is concluded `cancelled`, with the Owner as the actor, so nothing it
   * authorised outlives the invitation. Already concluded (activated, expired, cancelled) writes nothing; UNIQUE
   * (`pending_id`) and the contact lock keep it to one conclusion.
   */
  async cancelPending(
    p: { pendingId: Buffer; companyId: Buffer; userId: Buffer; source: Extract<ConsentSource, 'invitation_cancelled' | 'invitation_replaced'> },
    tx?: Prisma.TransactionClient,
  ): Promise<ConsentWrite> {
    const run = async (db: ConsentDb): Promise<ConsentWrite> => {
      const pending = await db.whatsAppConsent.findUnique({ where: { id: p.pendingId } });
      if (!pending || pending.event !== 'pending_unverified') return 'unchanged';
      await this.lock(db, pending.numberHash);
      const concluded = await db.whatsAppConsent.findFirst({ where: { pendingId: pending.id }, select: { id: true } });
      if (concluded) return 'unchanged';
      const id = newUuidV7Bin();
      await db.whatsAppConsent.create({
        data: {
          id,
          numberHash: pending.numberHash,
          numberMasked: pending.numberMasked,
          event: 'cancelled',
          version: pending.version,
          pendingId: pending.id,
          purposes: pending.purposes,
          actorCompanyId: p.companyId,
          actorUserId: p.userId,
          source: p.source,
        },
      });
      await db.auditLog.create({
        data: {
          companyId: p.companyId,
          userId: p.userId,
          entityType: 'WhatsAppConsent',
          entityId: id,
          action: 'update',
          after: { event: 'cancelled', number: pending.numberMasked, source: p.source },
          reason: 'Pending operational WhatsApp consent ended: its employee invitation was withdrawn',
        },
      });
      return 'recorded';
    };
    return tx ? run(tx) : this.prisma.$transaction((t) => run(t));
  }

  /**
   * The number was verified (D213): this person's pending agreement for it becomes the consent in force — a new
   * `active` row naming the pending row it concludes, with its version, language and source. Pass the transaction that
   * records the verification so both commit together. Idempotent: an agreement already activated answers `unchanged`;
   * UNIQUE (`pending_id`) refuses a second conclusion of one pending row, and the contact row's lock orders the rest.
   * Nothing pending (never ticked, expired, cancelled, or an earlier copy) activates nothing: `no_pending`. Given
   * `pendingId`, only that exact agreement may be activated.
   */
  async activatePending(
    p: { number: E164; userId: Buffer; companyId: Buffer; ip?: string | null; pendingId?: Buffer },
    tx?: Prisma.TransactionClient,
  ): Promise<ActivationOutcome> {
    const run = async (db: ConsentDb): Promise<ActivationOutcome> => {
      const numberHash = this.hasher.hash(p.number);
      await this.lock(db, numberHash);
      // Given a pending row (an employee invitation's), exactly that one — this person's, for this number — or nothing.
      const pending = await db.whatsAppConsent.findFirst({
        where: { numberHash, event: 'pending_unverified', actorUserId: p.userId, ...(p.pendingId ? { id: p.pendingId } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (!pending) return 'no_pending';
      const concluded = await db.whatsAppConsent.findFirst({ where: { pendingId: pending.id }, select: { event: true } });
      if (concluded) return concluded.event === 'active' ? 'unchanged' : 'no_pending';
      if (!isCurrentConsentVersion(pending.version) || Date.now() - pending.createdAt.getTime() >= PENDING_CONSENT_TTL_MS) return 'no_pending';
      const id = newUuidV7Bin();
      await db.whatsAppConsent.create({
        data: {
          id,
          numberHash,
          numberMasked: pending.numberMasked,
          event: 'active',
          version: pending.version,
          locale: pending.locale,
          pendingId: pending.id,
          purposes: pending.purposes,
          actorCompanyId: p.companyId,
          actorUserId: p.userId,
          source: pending.source,
        },
      });
      await db.whatsAppContact.updateMany({ where: { numberHash }, data: { optOutScope: 'none', optOutAt: null, optOutSource: null } });
      await db.auditLog.create({
        data: {
          companyId: p.companyId,
          userId: p.userId,
          entityType: 'WhatsAppConsent',
          entityId: id,
          action: 'update',
          after: { event: 'active', version: pending.version, number: pending.numberMasked, source: pending.source },
          reason: 'Operational WhatsApp consent active: the number was verified',
          ip: p.ip ?? null,
        },
      });
      return 'activated';
    };
    return tx ? run(tx) : this.prisma.$transaction((t) => run(t));
  }

  /**
   * An agreement to the copy in force for a number the person has ALREADY verified (re-consent from the account):
   * active at once, as a new row. Ends a withdrawal. A replay (this person's activation of this version is already the
   * newest decision) writes nothing.
   */
  async recordConsent(p: {
    number: E164;
    version: string;
    locale: ConsentLocale;
    companyId: Buffer | null;
    userId: Buffer | null;
    source: ConsentSource;
    ip?: string | null;
  }): Promise<ConsentWrite> {
    if (!isCurrentConsentVersion(p.version)) throw new Error('Unknown WhatsApp consent version');
    const numberHash = this.hasher.hash(p.number);
    const numberMasked = maskDestination(p.number);
    await this.ensureContact(numberHash, numberMasked);
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, numberHash);
      const newest = await this.newestDecision(tx, numberHash);
      if (
        newest?.event === 'active' &&
        newest.version === p.version &&
        (newest.actorUserId === null ? p.userId === null : p.userId !== null && Buffer.compare(newest.actorUserId, p.userId) === 0)
      ) {
        return 'unchanged';
      }
      const id = newUuidV7Bin();
      await tx.whatsAppConsent.create({
        data: {
          id,
          numberHash,
          numberMasked,
          event: 'active',
          version: p.version,
          locale: p.locale,
          purposes: CONSENT_PURPOSES.join(','),
          actorCompanyId: p.companyId,
          actorUserId: p.userId,
          source: p.source,
        },
      });
      await tx.whatsAppContact.updateMany({
        where: { numberHash },
        data: { optOutScope: 'none', optOutAt: null, optOutSource: null },
      });
      if (p.companyId) {
        await tx.auditLog.create({
          data: {
            companyId: p.companyId,
            userId: p.userId,
            entityType: 'WhatsAppConsent',
            entityId: id,
            action: 'create',
            after: { event: 'active', version: p.version, locale: p.locale, purposes: [...CONSENT_PURPOSES], number: numberMasked, source: p.source },
            reason: 'Operational WhatsApp consent granted for a verified number',
            ip: p.ip ?? null,
          },
        });
      }
      return 'recorded';
    });
  }

  /**
   * Withdraw a number's operational WhatsApp consent (D213): from the app or by a STOP keyword. WhatsApp stops; email,
   * a separate channel, is not withdrawn by it. The history keeps every earlier event. A number already withdrawn, with
   * nothing agreed since, writes nothing.
   */
  async withdrawConsent(p: { number: E164; companyId: Buffer; userId: Buffer; source: ConsentSource; ip?: string | null }): Promise<ConsentWrite> {
    return this.withdraw({
      numberHash: this.hasher.hash(p.number),
      numberMasked: maskDestination(p.number),
      companyId: p.companyId,
      userId: p.userId,
      source: p.source,
      ip: p.ip ?? null,
    });
  }

  /**
   * The person's verified number was replaced (D213): the old number's consent is `superseded` — it never carries over,
   * nor reaches whoever holds that number next. Nothing to supersede (no consent in force) writes nothing.
   */
  async supersede(p: { number: E164; companyId: Buffer; userId: Buffer }, tx?: Prisma.TransactionClient): Promise<ConsentWrite> {
    const run = async (db: ConsentDb): Promise<ConsentWrite> => {
      const numberHash = this.hasher.hash(p.number);
      await this.lock(db, numberHash);
      const newest = await this.newestDecision(db, numberHash);
      if (newest?.event !== 'active' && newest?.event !== 'granted') return 'unchanged';
      const id = newUuidV7Bin();
      const numberMasked = maskDestination(p.number);
      await db.whatsAppConsent.create({
        data: { id, numberHash, numberMasked, event: 'superseded', purposes: CONSENT_PURPOSES.join(','), actorCompanyId: p.companyId, actorUserId: p.userId, source: 'number_changed' },
      });
      await db.auditLog.create({
        data: {
          companyId: p.companyId,
          userId: p.userId,
          entityType: 'WhatsAppConsent',
          entityId: id,
          action: 'update',
          after: { event: 'superseded', number: numberMasked, source: 'number_changed' },
          reason: 'Operational WhatsApp consent ended: the number was replaced',
        },
      });
      return 'recorded';
    };
    return tx ? run(tx) : this.prisma.$transaction((t) => run(t));
  }

  /**
   * Abandoned agreements (D213): every pending row older than {@link PENDING_CONSENT_TTL_MS} that nothing concluded gets
   * its `expired` row, so the history says what became of it. An expired agreement never counted — this only records
   * it. Idempotent: UNIQUE (`pending_id`) and the contact lock keep it to one conclusion, even racing a verification.
   */
  async expireStalePending(now: Date = new Date(), batch = 500): Promise<number> {
    const cutoff = new Date(now.getTime() - PENDING_CONSENT_TTL_MS);
    const stale = await this.prisma.whatsAppConsent.findMany({
      where: { event: 'pending_unverified', createdAt: { lt: cutoff } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: batch,
    });
    let expired = 0;
    for (const pending of stale) {
      const wrote = await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, pending.numberHash);
        const concluded = await tx.whatsAppConsent.findFirst({ where: { pendingId: pending.id }, select: { id: true } });
        if (concluded) return false;
        await tx.whatsAppConsent.create({
          data: {
            id: newUuidV7Bin(),
            numberHash: pending.numberHash,
            numberMasked: pending.numberMasked,
            event: 'expired',
            version: pending.version,
            pendingId: pending.id,
            purposes: pending.purposes,
            actorCompanyId: pending.actorCompanyId,
            actorUserId: pending.actorUserId,
            source: 'expiry',
          },
        });
        return true;
      });
      if (wrote) expired += 1;
    }
    return expired;
  }

  private async withdraw(p: {
    numberHash: string;
    numberMasked: string;
    companyId: Buffer | null;
    userId: Buffer | null;
    source: ConsentSource;
    ip?: string | null;
  }): Promise<ConsentWrite> {
    await this.ensureContact(p.numberHash, p.numberMasked);
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, p.numberHash);
      await tx.whatsAppContact.updateMany({
        where: { numberHash: p.numberHash },
        data: { optOutScope: 'all', optOutAt: new Date(), optOutSource: p.source === 'inbound_keyword' ? 'inbound_keyword' : 'account' },
      });
      // Ordered by when it is recorded, not when a keyword was typed: a late STOP still wins over an earlier agreement.
      const newest = await this.newestDecision(tx, p.numberHash);
      const pending = await tx.whatsAppConsent.findFirst({
        where: { numberHash: p.numberHash, event: 'pending_unverified' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true },
      });
      const agreedSince = pending && newest && pending.createdAt > newest.createdAt;
      if (newest?.event === 'withdrawn' && !agreedSince) return 'unchanged';
      const id = newUuidV7Bin();
      await tx.whatsAppConsent.create({
        data: {
          id,
          numberHash: p.numberHash,
          numberMasked: p.numberMasked,
          event: 'withdrawn',
          purposes: CONSENT_PURPOSES.join(','),
          actorCompanyId: p.companyId,
          actorUserId: p.userId,
          source: p.source,
        },
      });
      if (p.companyId) {
        await tx.auditLog.create({
          data: {
            companyId: p.companyId,
            userId: p.userId,
            entityType: 'WhatsAppConsent',
            entityId: id,
            action: 'update',
            after: { event: 'withdrawn', purposes: [...CONSENT_PURPOSES], number: p.numberMasked, source: p.source },
            reason: 'Operational WhatsApp consent withdrawn',
            ip: p.ip ?? null,
          },
        });
      }
      return 'recorded';
    });
  }

  /** The contact row, locked: two decisions about one number are made one after the other. */
  private async lock(db: Pick<ConsentDb, '$queryRaw'>, numberHash: string): Promise<void> {
    await db.$queryRaw(Prisma.sql`SELECT id FROM whatsapp_contacts WHERE number_hash = ${numberHash} FOR UPDATE`);
  }

  /** Create the contact row if it does not exist; a concurrent creation is not an error. */
  private async ensureContact(numberHash: string, numberMasked: string): Promise<void> {
    try {
      await this.prisma.whatsAppContact.upsert({
        where: { numberHash },
        create: { id: newUuidV7Bin(), numberHash, numberMasked },
        update: {},
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
  }
}
