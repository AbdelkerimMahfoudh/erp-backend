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

/** Where a number's consent stands, from its newest grant or withdrawal. */
export type ConsentState = 'none' | 'granted' | 'outdated' | 'withdrawn';

export interface ContactState {
  optOutScope: OptOutScope;
  /** The newest grant or withdrawal is a grant of the copy in force — the only state that lets a message go. */
  consented: boolean;
  consent: ConsentState;
  /** The version of the newest grant, whatever came after it. */
  consentVersion: string | null;
  /** When the consent in force was given; null unless `consented`. */
  consentedAt: Date | null;
  /** When it was withdrawn; null unless the newest event is a withdrawal. */
  withdrawnAt: Date | null;
  lastInboundAt: Date | null;
  undeliverableAt: Date | null;
}

const NO_CONTACT: ContactState = {
  optOutScope: 'none',
  consented: false,
  consent: 'none',
  consentVersion: null,
  consentedAt: null,
  withdrawnAt: null,
  lastInboundAt: null,
  undeliverableAt: null,
};

/** One event of a number's consent history, as its owner is shown it: masked, never the hash. */
export interface ConsentEvent {
  event: 'granted' | 'withdrawn' | 'opted_out_optional';
  version: string | null;
  locale: string | null;
  source: string;
  at: Date;
}

/** Whether a grant or withdrawal was written, or the same one was already the newest (a replay). */
export type ConsentWrite = 'recorded' | 'unchanged';

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

  async contactStateByHash(numberHash: string): Promise<ContactState> {
    const [contact, newest, grant] = await Promise.all([
      this.prisma.whatsAppContact.findUnique({ where: { numberHash } }),
      this.newestDecision(this.prisma, numberHash),
      this.prisma.whatsAppConsent.findFirst({
        where: { numberHash, event: 'granted' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { version: true },
      }),
    ]);
    if (!contact && !newest) return NO_CONTACT;
    const granted = newest?.event === 'granted';
    const current = granted && isCurrentConsentVersion(newest.version);
    return {
      optOutScope: (contact?.optOutScope as OptOutScope | undefined) ?? 'none',
      consented: current,
      consent: !newest ? 'none' : newest.event === 'withdrawn' ? 'withdrawn' : current ? 'granted' : 'outdated',
      consentVersion: grant?.version ?? null,
      consentedAt: current ? newest.createdAt : null,
      withdrawnAt: newest?.event === 'withdrawn' ? newest.createdAt : null,
      lastInboundAt: contact?.lastInboundAt ?? null,
      undeliverableAt: contact?.undeliverableAt ?? null,
    };
  }

  /**
   * A number's consent history, newest first — the events this person made, and the keyword withdrawals nobody made
   * from an account. Another business's actions on the same number decide the state but are not listed here.
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

  /** The newest grant or withdrawal of a number: what its consent is now. */
  private newestDecision(db: Pick<Prisma.TransactionClient, 'whatsAppConsent'>, numberHash: string) {
    return db.whatsAppConsent.findFirst({
      where: { numberHash, event: { in: ['granted', 'withdrawn'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { event: true, version: true, actorUserId: true, createdAt: true },
    });
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
      await this.withdraw({ numberHash: senderHash, numberMasked: senderMasked, companyId: null, userId: null, source: 'inbound_keyword', at });
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
   * Record a grant of the copy in force (D213), clear any opt-out, and audit it — in one transaction. A replay (the
   * newest decision is already this person's grant of this version) writes nothing. The caller refuses any other
   * version before this is reached; checked again here.
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
      // The contact row, locked: two grants or a grant and a withdrawal of one number are decided one after the other.
      await tx.$queryRaw`SELECT id FROM whatsapp_contacts WHERE number_hash = ${numberHash} FOR UPDATE`;
      const newest = await this.newestDecision(tx, numberHash);
      if (
        newest?.event === 'granted' &&
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
          event: 'granted',
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
            after: { event: 'granted', version: p.version, locale: p.locale, purposes: [...CONSENT_PURPOSES], number: numberMasked, source: p.source },
            reason: 'Operational WhatsApp consent granted',
            ip: p.ip ?? null,
          },
        });
      }
      return 'recorded';
    });
  }

  /**
   * Withdraw a number's operational consent (D213): from the app, by a STOP keyword, or because the number stopped
   * being the person's verified contact. Proactive messages stop; the history keeps every earlier event. A number
   * already withdrawn writes nothing.
   */
  async withdrawConsent(p: { number: E164; companyId: Buffer; userId: Buffer; source: ConsentSource; ip?: string | null }): Promise<ConsentWrite> {
    return this.withdraw({
      numberHash: this.hasher.hash(p.number),
      numberMasked: maskDestination(p.number),
      companyId: p.companyId,
      userId: p.userId,
      source: p.source,
      ip: p.ip ?? null,
      at: new Date(),
    });
  }

  private async withdraw(p: {
    numberHash: string;
    numberMasked: string;
    companyId: Buffer | null;
    userId: Buffer | null;
    source: ConsentSource;
    ip?: string | null;
    at: Date;
  }): Promise<ConsentWrite> {
    await this.ensureContact(p.numberHash, p.numberMasked);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM whatsapp_contacts WHERE number_hash = ${p.numberHash} FOR UPDATE`;
      await tx.whatsAppContact.updateMany({
        where: { numberHash: p.numberHash },
        data: { optOutScope: 'all', optOutAt: p.at, optOutSource: p.source === 'inbound_keyword' ? 'inbound_keyword' : 'account' },
      });
      // Ordered by when it is recorded, not when a keyword was typed: a late STOP still wins over an earlier grant.
      const newest = await this.newestDecision(tx, p.numberHash);
      if (newest?.event === 'withdrawn') return 'unchanged';
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
            reason: p.source === 'number_changed' ? 'Operational WhatsApp consent ended: the number was replaced' : 'Operational WhatsApp consent withdrawn',
            ip: p.ip ?? null,
          },
        });
      }
      return 'recorded';
    });
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
