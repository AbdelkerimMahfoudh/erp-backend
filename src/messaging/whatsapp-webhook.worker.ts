import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { OtpDeliveryState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { WhatsAppReadiness } from './delivery-readiness';
import { WhatsAppRecords } from './whatsapp-records';
import type { WebhookItem } from './whatsapp-webhook.controller';

/**
 * Works the stored webhook items (0098; D181 §8) — the same guarantees as the other outboxes, obtained the same way
 * (`analytics/rollup-outbox.service.ts`):
 *
 *  - **Nothing acknowledged is lost.** An item exists only if the delivery that carried it was signed and stored;
 *    the controller answers 200 only after that.
 *  - **No stuck work.** A claim is a lease; a worker that dies lets it expire and the next pass takes the item again.
 *  - **Idempotent.** Working an item twice changes nothing: statuses move forward only (`nextStatus`), a delivery
 *    proof is completed only while `delivered_at` is empty, an opt-out is a state, not a counter.
 *  - **D166 unchanged.** Only a signed `delivered` (or `read`) completes a delivery proof, and a failure is recorded,
 *    never a delivery.
 *
 * A processed item keeps its key (so a late provider retry still collapses on it) and loses its sender fields; every
 * item is deleted after WHATSAPP_WEBHOOK_RETENTION_DAYS. The same sweep deletes message metadata older than
 * MESSAGE_LOG_RETENTION_DAYS (D181 §7).
 */
const LEASE_MS = 60_000;
const BATCH_SIZE = 100;
const SWEEP_INTERVAL_MS = 15_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 30 * 60_000;
/** After this many failed attempts an item is parked as `failed` (still visible, still retained for its period). */
export const MAX_ATTEMPTS = 10;
const PURGE_INTERVAL_MS = 60 * 60_000;
/** How long a status for a message not recorded yet is retried before it is applied as an unknown message. */
export const UNKNOWN_MESSAGE_GRACE_MS = 120_000;

class MessageNotYetRecorded extends Error {
  override name = 'MessageNotYetRecorded';
}
const DAY_MS = 24 * 60 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

export interface SweepResult {
  done: number;
  failed: number;
}

@Injectable()
export class WhatsAppWebhookWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(WhatsAppWebhookWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private purgedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly records: WhatsAppRecords,
    private readonly readiness: WhatsAppReadiness,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.processNow();
    this.timer = setInterval(() => void this.processNow(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Store a delivery's items in one statement; a provider retry's duplicates are skipped by the unique key. */
  async enqueue(items: WebhookItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.prisma.whatsAppWebhookEvent.createMany({
      data: items.map((i) => ({
        id: newUuidV7Bin(),
        dedupeKey: i.dedupeKey,
        kind: i.kind,
        providerMessageId: i.providerMessageId,
        status: i.status,
        errorCode: i.errorCode,
        senderHash: i.senderHash,
        senderMasked: i.senderMasked,
        optOutSignal: i.optOutSignal,
        occurredAt: i.occurredAt,
      })),
      skipDuplicates: true,
    });
  }

  /** One pass at a time in this process; a request during a pass gets one more pass after it. Never rejects. */
  processNow(): Promise<void> {
    this.again = true;
    if (!this.running) {
      this.running = (async () => {
        try {
          while (this.again) {
            this.again = false;
            try {
              await this.sweep();
              await this.purgeIfDue();
            } catch {
              this.log.error('WhatsApp webhook sweep failed; the items stay queued for the next pass');
            }
          }
        } finally {
          this.running = null;
        }
      })();
    }
    return this.running;
  }

  async sweep(): Promise<SweepResult> {
    const result: SweepResult = { done: 0, failed: 0 };
    for (;;) {
      const now = new Date();
      const due = await this.prisma.whatsAppWebhookEvent.findMany({
        where: {
          OR: [
            { state: 'pending', nextAttemptAt: { lte: now } },
            { state: 'processing', claimedUntil: { lt: now } },
          ],
        },
        orderBy: { receivedAt: 'asc' },
        take: BATCH_SIZE,
      });
      if (due.length === 0) return result;
      let progressed = false;
      for (const event of due) {
        const outcome = await this.work(event);
        if (outcome === 'done') {
          result.done += 1;
          progressed = true;
        } else if (outcome === 'failed') {
          result.failed += 1;
        }
      }
      if (due.length < BATCH_SIZE || !progressed) return result;
    }
  }

  private async work(event: {
    id: Buffer;
    kind: string;
    providerMessageId: string;
    status: string | null;
    errorCode: number | null;
    senderHash: string | null;
    senderMasked: string | null;
    optOutSignal: string | null;
    occurredAt: Date | null;
    receivedAt: Date;
    attempts: number;
  }): Promise<'done' | 'failed' | 'skipped'> {
    const now = new Date();
    const token = newUuidV7Bin();
    const claim = await this.prisma.whatsAppWebhookEvent.updateMany({
      where: {
        id: event.id,
        OR: [
          { state: 'pending', nextAttemptAt: { lte: now } },
          { state: 'processing', claimedUntil: { lt: now } },
        ],
      },
      data: { state: 'processing', claimToken: token, claimedUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (claim.count === 0) return 'skipped';

    try {
      if (event.kind === 'status' && event.status) {
        await this.applyStatus(event.providerMessageId, event.status, event.errorCode, event.occurredAt ?? event.receivedAt, event.receivedAt);
      } else if (event.kind === 'inbound' && event.senderHash) {
        const signal = event.optOutSignal === 'stop' || event.optOutSignal === 'start' ? event.optOutSignal : null;
        await this.records.applyInbound(event.senderHash, event.senderMasked ?? '***', event.occurredAt ?? event.receivedAt, signal);
      }
      await this.prisma.whatsAppWebhookEvent.updateMany({
        where: { claimToken: token, state: 'processing' },
        // Minimised once processed: the key stays for deduplication, the sender does not.
        data: { state: 'done', processedAt: new Date(), claimedUntil: null, lastError: null, senderHash: null, senderMasked: null, optOutSignal: null },
      });
      return 'done';
    } catch (e) {
      const attempts = event.attempts + 1;
      const parked = attempts >= MAX_ATTEMPTS;
      await this.prisma.whatsAppWebhookEvent.updateMany({
        where: { claimToken: token, state: 'processing' },
        data: {
          state: parked ? 'failed' : 'pending',
          claimedUntil: null,
          lastError: describe(e).slice(0, 200),
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        },
      });
      if (!(e instanceof MessageNotYetRecorded)) {
        this.log.warn(`WhatsApp webhook item (${event.kind}) failed, attempt ${attempts}${parked ? ', parked' : ', will retry'}`);
      }
      return 'failed';
    }
  }

  /**
   * A signed status: the message record moves forward only, and the existing effects follow the record — the code's
   * delivery state (support's "did it arrive?") and the operator's delivery proof (D166).
   *
   * The effects are decided by where the record STANDS after this event, not by whether this event moved it: an
   * attempt that moved the record and then failed on an effect is retried, and the retry must still complete the
   * proof. Every effect is idempotent (a proof completes only while `delivered_at` is empty), so applying one twice
   * is harmless — and an event the record has already passed (a late `failed` after delivery) applies none.
   */
  private async applyStatus(providerMessageId: string, status: string, errorCode: number | null, at: Date, receivedAt: Date): Promise<void> {
    const outcome = await this.records.applyProviderStatus(providerMessageId, status, errorCode, at);
    /*
     * The provider can report "sent" before the send that caused it has finished recording itself. A fresh status
     * for a message not recorded yet waits (the item's backoff) rather than being applied to nothing; after the grace
     * period it is applied as a message this table does not know (sent before 0098, or not through the policy).
     */
    if (!outcome.known && Date.now() - receivedAt.getTime() < UNKNOWN_MESSAGE_GRACE_MS) {
      throw new MessageNotYetRecorded();
    }
    const current = outcome.known ? outcome.status : status;
    const failed = status === 'failed';
    // This event is where the record stands: its own effects apply.
    const standing = current === status;
    // A delivery the record has reached or passed (delivered, then read) still completes the proof.
    const deliveredOrPast = (status === 'delivered' || status === 'read') && (current === 'delivered' || current === 'read');

    if (failed && standing && errorCode === 131026 && outcome.recipientHash) {
      await this.records.markUndeliverableByHash(outcome.recipientHash);
    }
    if (standing && (failed || status === 'sent' || status === 'delivered' || status === 'read')) {
      await this.prisma.otpChallenge.updateMany({
        where: { providerMessageId, provider: 'cloud-api' },
        data: failed
          ? {
              deliveryState: OtpDeliveryState.rejected,
              deliveryDetail: `Provider reported failure${errorCode !== null ? ` (code ${errorCode})` : ''}`,
            }
          : { deliveryDetail: `Provider reported: ${status}` },
      });
    }
    if (deliveredOrPast) {
      const done = await this.prisma.messagingDeliveryProof.updateMany({
        where: { provider: 'cloud-api', providerMessageId, deliveredAt: null },
        data: { deliveredAt: new Date() },
      });
      if (done.count > 0) {
        await this.readiness.refresh();
        this.log.log(`WhatsApp delivery proofs completed: ${done.count}; still to prove: ${this.readiness.missing.join(', ') || 'none'}`);
      }
    } else if (failed && standing) {
      await this.prisma.messagingDeliveryProof.updateMany({
        where: { provider: 'cloud-api', providerMessageId, deliveredAt: null },
        data: { failureDetail: `Provider reported failure${errorCode !== null ? ` (code ${errorCode})` : ''}` },
      });
    }
  }

  /** Retention (D181 §7), at most hourly. */
  private async purgeIfDue(): Promise<void> {
    if (Date.now() - this.purgedAt < PURGE_INTERVAL_MS) return;
    this.purgedAt = Date.now();
    await this.purgeExpired(new Date());
  }

  async purgeExpired(now: Date): Promise<{ events: number; whatsapp: number; email: number }> {
    const eventsBefore = new Date(now.getTime() - this.config.whatsappWebhookRetentionDays * DAY_MS);
    const messagesBefore = new Date(now.getTime() - this.config.messageLogRetentionDays * DAY_MS);
    const [events, whatsapp, email] = await Promise.all([
      this.prisma.whatsAppWebhookEvent.deleteMany({ where: { receivedAt: { lt: eventsBefore }, state: { in: ['done', 'failed'] } } }),
      this.prisma.whatsAppMessage.deleteMany({ where: { createdAt: { lt: messagesBefore } } }),
      this.prisma.emailMessage.deleteMany({ where: { createdAt: { lt: messagesBefore } } }),
    ]);
    return { events: events.count, whatsapp: whatsapp.count, email: email.count };
  }
}

/** The error's class and Prisma code only — never a message that could carry data. */
function describe(e: unknown): string {
  const err = e as { name?: string; code?: string } | null;
  return [err?.name ?? 'Error', err?.code].filter(Boolean).join(' ');
}
