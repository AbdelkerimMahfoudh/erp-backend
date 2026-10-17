import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import type { DeliveryResult } from './whatsapp-channel';
import { emailTemplateClass, maskEmail, type EmailChannel, type EmailMessage } from './email-channel';
import type { RecipientHasher } from './recipient-hash';

/**
 * Every real email, recorded and limited (D181 §7, §9).
 *
 *  - **One row per logical message** in `email_messages`: template, class, language, sender, provider, outcome,
 *    attempts — and the recipient only as a keyed hash and a masked form. Never a body, a code or a link.
 *  - **An internal daily safety limit** (EMAIL_DAILY_SAFETY_LIMIT per UTC day, 300 by default after Brevo's free
 *    plan) with a reserve (EMAIL_DAILY_RESERVE) only essential messages — codes — may use, and a per-recipient daily
 *    limit. It counts what this application sent; it is not Brevo's own account count, which other senders on the
 *    same account would also consume.
 *  - **A retry is the same message.** The same idempotency key adds an attempt to its row and is not counted again;
 *    a key already accepted is answered as accepted without sending a second time.
 *
 * The records are read before anything is sent: if they cannot be read, nothing is sent (a limit that cannot be
 * checked is not a limit). If the outcome cannot be written after a send, the send's true result still stands.
 */

export interface EmailLimits {
  dailyLimit: number;
  dailyReserve: number;
  recipientDailyLimit: number;
}

/** Why an internal limit refuses a new message, or null. Pure. */
export function limitRefusal(
  counts: { today: number; recipientToday: number },
  essential: boolean,
  limits: EmailLimits,
): string | null {
  if (counts.recipientToday >= limits.recipientDailyLimit) return 'Internal limit: too many emails to this recipient today';
  const ceiling = essential ? limits.dailyLimit : Math.max(0, limits.dailyLimit - limits.dailyReserve);
  if (counts.today >= ceiling) {
    return essential
      ? 'Internal daily safety limit reached'
      : 'Internal daily safety limit reached for non-essential email (the rest is kept for codes)';
  }
  return null;
}

/** 00:00 UTC of the given instant's day. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const COUNTED = ['sending', 'accepted', 'failed'];

export class LoggedEmailChannel implements EmailChannel {
  private readonly logger = new Logger(LoggedEmailChannel.name);

  constructor(
    private readonly inner: EmailChannel,
    private readonly prisma: Pick<PrismaService, 'emailMessage'>,
    private readonly hasher: Pick<RecipientHasher, 'hash'>,
    private readonly limits: EmailLimits,
    /** The From address a template goes out under, for the record. */
    private readonly senderOf: (template: EmailMessage['template']) => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get isEnabled(): boolean {
    return this.inner.isEnabled;
  }

  async send(message: EmailMessage): Promise<DeliveryResult> {
    const cls = emailTemplateClass(message.template);
    // An unknown template is refused by the provider channel itself; nothing to record.
    if (!cls) return this.inner.send(message);

    let rowId: Buffer;
    try {
      const existing = await this.prisma.emailMessage.findUnique({
        where: { idempotencyKey: message.idempotencyKey },
        select: { id: true, status: true, providerMessageId: true },
      });
      if (existing?.status === 'accepted') {
        return { status: 'accepted', providerMessageId: existing.providerMessageId, provider: this.inner.name };
      }
      if (existing?.status === 'refused') {
        return { status: 'failed', reason: 'rejected', detail: 'Refused earlier by an internal limit', provider: this.inner.name };
      }
      if (existing) {
        rowId = existing.id;
        await this.prisma.emailMessage.update({ where: { id: rowId }, data: { status: 'sending', attempts: { increment: 1 } } });
      } else {
        const hash = this.hasher.hash(message.to);
        const since = utcDayStart(this.now());
        const [today, recipientToday] = await Promise.all([
          this.prisma.emailMessage.count({ where: { createdAt: { gte: since }, status: { in: COUNTED } } }),
          this.prisma.emailMessage.count({ where: { recipientHash: hash, createdAt: { gte: since }, status: { in: COUNTED } } }),
        ]);
        const refusal = limitRefusal({ today, recipientToday }, cls.essential, this.limits);
        rowId = newUuidV7Bin();
        await this.prisma.emailMessage.create({
          data: {
            id: rowId,
            idempotencyKey: message.idempotencyKey,
            template: message.template,
            category: cls.sender,
            essential: cls.essential,
            language: message.language,
            sender: this.senderOf(message.template).slice(0, 191),
            recipientHash: hash,
            recipientMasked: maskEmail(message.to).slice(0, 80),
            provider: this.inner.name,
            status: refusal ? 'refused' : 'sending',
            failureReason: refusal ? 'rejected' : null,
            detail: refusal,
            attempts: refusal ? 0 : 1,
          },
        });
        if (refusal) {
          this.logger.warn(`Email "${message.template}" to ${maskEmail(message.to)} refused: ${refusal}`);
          return { status: 'failed', reason: 'rejected', detail: refusal, provider: this.inner.name };
        }
      }
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // The same message started concurrently: that send is the one; this one does not send a second copy.
        return { status: 'failed', reason: 'temporary', detail: 'The same message is already being sent', provider: this.inner.name };
      }
      this.logger.warn(`Email "${message.template}" held: the email records are unavailable`);
      return { status: 'failed', reason: 'temporary', detail: 'Email records are unavailable', provider: this.inner.name };
    }

    const result = await this.inner.send(message);
    try {
      await this.prisma.emailMessage.update({
        where: { id: rowId },
        data:
          result.status === 'accepted'
            ? { status: 'accepted', providerMessageId: result.providerMessageId, acceptedAt: this.now(), failureReason: null, detail: null }
            : { status: 'failed', failureReason: result.reason, detail: result.detail.slice(0, 200) },
      });
    } catch {
      this.logger.warn(`Email record for "${message.template}" could not be updated after the send`);
    }
    return result;
  }
}
