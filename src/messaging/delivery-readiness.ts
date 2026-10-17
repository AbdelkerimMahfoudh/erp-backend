import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import type { DeliveryResult, MessageLanguage, WhatsAppChannel, WhatsAppMessage } from './whatsapp-channel';

/**
 * Whether WhatsApp delivery is proven for this deployment (correction phase, 2026-10-12; docs/64).
 *
 * A configured channel is not a working one. A production deployment claims nothing — no code sent, no deletion
 * code, no invitation delivered — until the operator has proven, on this deployment, that:
 *
 *  - the WhatsApp Business account and the sending number work (the provider accepted a real send);
 *  - the templates are approved in each of English, French and Arabic (one send per language was delivered);
 *  - the delivery webhook is reachable and its signatures verify (the "delivered" status reached us through the
 *    signed webhook — it is the only thing that can set `delivered_at`).
 *
 * The proof is a row per language in `messaging_delivery_proofs`, written by `npm run whatsapp:prove` and completed
 * by the webhook. Nothing here is an attestation an operator can type into a variable.
 */
export const PROOF_LANGUAGES: readonly MessageLanguage[] = ['en', 'fr', 'ar'];

@Injectable()
export class WhatsAppReadiness implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppReadiness.name);
  private delivered = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    /** Present in the application: proofs count only for the configured sending number (0098). */
    @Optional() private readonly config?: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Read the proofs again. A database that cannot be read proves nothing. */
  async refresh(): Promise<void> {
    try {
      const rows = await this.prisma.messagingDeliveryProof.findMany({
        where: {
          channel: 'whatsapp',
          deliveredAt: { not: null },
          // A proof made with Meta's test number never opens the channel for the real one (0098).
          ...(this.config ? { phoneNumberId: this.config.whatsappPhoneNumberId } : {}),
        },
        select: { language: true },
      });
      this.delivered = new Set(rows.map((r) => r.language));
    } catch {
      this.delivered = new Set();
      this.logger.warn('WhatsApp delivery proofs could not be read: delivery is treated as unproven');
    }
  }

  /** The languages still to prove — empty when delivery is proven. */
  get missing(): MessageLanguage[] {
    return PROOF_LANGUAGES.filter((l) => !this.delivered.has(l));
  }

  get isProven(): boolean {
    return this.missing.length === 0;
  }
}

/**
 * The channel a production deployment sends through: the configured one, closed until delivery is proven. While it
 * is closed it says so — `isEnabled` false, every send `channel_unavailable` — so every caller already written for a
 * deployment without WhatsApp refuses honestly instead of claiming a message went out.
 */
export class ProvenWhatsAppChannel implements WhatsAppChannel {
  constructor(
    private readonly inner: WhatsAppChannel,
    private readonly readiness: Pick<WhatsAppReadiness, 'isProven' | 'missing'>,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get isEnabled(): boolean {
    return this.inner.isEnabled && this.readiness.isProven;
  }

  accepts(to: string): boolean {
    return this.isEnabled && (this.inner.accepts?.(to) ?? true);
  }

  async send(message: WhatsAppMessage): Promise<DeliveryResult> {
    if (!this.readiness.isProven) {
      return {
        status: 'failed',
        reason: 'channel_unavailable',
        detail: `WhatsApp delivery is not proven for this deployment (missing: ${this.readiness.missing.join(', ')})`,
        provider: this.inner.name,
      };
    }
    return this.inner.send(message);
  }
}
