import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { maskDestination } from './channels';
import { RecipientHasher } from './recipient-hash';
import { CONSENT_PURPOSES, WHATSAPP_CONSENT_VERSION } from './whatsapp-consent';
import type { DeliveryResult, E164, MessageLanguage } from './whatsapp-channel';
import type { TemplateUse } from './templates';

/**
 * The WhatsApp records (0098; D181): message statuses, what is known about a number (opt-out, the 24-hour window,
 * undeliverability) and the consent history. Every number is stored as a keyed hash and a masked form; no variable,
 * code, token or message text is ever written here.
 */

export type OptOutScope = 'none' | 'optional' | 'all';

export interface ContactState {
  optOutScope: OptOutScope;
  /** A grant is on record and no withdrawal came after it. */
  consented: boolean;
  lastInboundAt: Date | null;
  undeliverableAt: Date | null;
}

const NO_CONTACT: ContactState = { optOutScope: 'none', consented: false, lastInboundAt: null, undeliverableAt: null };

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
    const [contact, consent] = await Promise.all([
      this.prisma.whatsAppContact.findUnique({ where: { numberHash } }),
      this.prisma.whatsAppConsent.findFirst({
        where: { numberHash, event: { in: ['granted', 'withdrawn'] } },
        orderBy: { createdAt: 'desc' },
        select: { event: true },
      }),
    ]);
    if (!contact && !consent) return NO_CONTACT;
    return {
      optOutScope: (contact?.optOutScope as OptOutScope | undefined) ?? 'none',
      consented: consent?.event === 'granted',
      lastInboundAt: contact?.lastInboundAt ?? null,
      undeliverableAt: contact?.undeliverableAt ?? null,
    };
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
      await this.prisma.whatsAppContact.updateMany({
        where: { numberHash: senderHash, optOutScope: 'none' },
        data: { optOutScope: 'optional', optOutAt: at, optOutSource: 'inbound_keyword' },
      });
    } else if (signal === 'start') {
      // START restores optional notices only; a withdrawn account channel comes back only through a new consent.
      await this.prisma.whatsAppContact.updateMany({
        where: { numberHash: senderHash, optOutScope: 'optional' },
        data: { optOutScope: 'none', optOutAt: at, optOutSource: 'inbound_keyword' },
      });
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
   * Record a grant of the current consent copy (D181 §5), clear any opt-out, and audit it — in one transaction. A
   * stale or unknown version is refused by the caller before this is reached; checked again here.
   */
  async recordConsent(p: {
    number: E164;
    version: string;
    companyId: Buffer | null;
    userId: Buffer | null;
    source: 'owner_registration' | 'phone_verification' | 'account';
  }): Promise<void> {
    if (p.version !== WHATSAPP_CONSENT_VERSION) throw new Error('Unknown WhatsApp consent version');
    const numberHash = this.hasher.hash(p.number);
    const numberMasked = maskDestination(p.number);
    const id = newUuidV7Bin();
    await this.ensureContact(numberHash, numberMasked);
    await this.prisma.$transaction(async (tx) => {
      await tx.whatsAppConsent.create({
        data: {
          id,
          numberHash,
          numberMasked,
          event: 'granted',
          version: p.version,
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
            after: { event: 'granted', version: p.version, purposes: [...CONSENT_PURPOSES], number: numberMasked, source: p.source },
            reason: 'WhatsApp consent granted',
          },
        });
      }
    });
  }

  /**
   * The person's own opt-out from the application: `optional` stops optional notices, `all` withdraws WhatsApp as
   * the account contact. Audited. An `optional` request never relaxes a withdrawal — that takes a new consent.
   */
  async optOut(p: { number: E164; scope: 'optional' | 'all'; companyId: Buffer; userId: Buffer }): Promise<OptOutScope> {
    const numberHash = this.hasher.hash(p.number);
    const numberMasked = maskDestination(p.number);
    const id = newUuidV7Bin();
    await this.ensureContact(numberHash, numberMasked);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.whatsAppConsent.create({
        data: {
          id,
          numberHash,
          numberMasked,
          event: p.scope === 'all' ? 'withdrawn' : 'opted_out_optional',
          actorCompanyId: p.companyId,
          actorUserId: p.userId,
          source: 'account',
        },
      });
      await tx.whatsAppContact.updateMany({
        where: { numberHash, ...(p.scope === 'optional' ? { optOutScope: 'none' } : {}) },
        data: { optOutScope: p.scope, optOutAt: now, optOutSource: 'account' },
      });
      await tx.auditLog.create({
        data: {
          companyId: p.companyId,
          userId: p.userId,
          entityType: 'WhatsAppConsent',
          entityId: id,
          action: 'update',
          after: { event: p.scope === 'all' ? 'withdrawn' : 'opted_out_optional', number: numberMasked },
          reason: p.scope === 'all' ? 'WhatsApp withdrawn as the account contact' : 'Optional WhatsApp notifications stopped',
        },
      });
    });
    return (await this.contactStateByHash(numberHash)).optOutScope;
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
