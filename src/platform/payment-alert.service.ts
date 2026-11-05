import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WHATSAPP_CHANNEL, type WhatsAppChannel } from '../messaging/whatsapp-channel';
import { PAYMENT_SUBMITTED_TEMPLATE } from '../messaging/templates';

export interface SubmittedProof {
  id: string;
  companyId: Buffer;
  submittedBy: Buffer;
  amount: string;
  months: number | null;
  stores: readonly string[];
}

/** "3 months — Tevragh Zeina, Ksar": the duration and the stores it pays for, short enough for one template variable. */
export function durationText(months: number | null, stores: readonly string[]): string {
  const span = months === null ? 'an unstated duration' : months === 1 ? '1 month' : `${months} months`;
  const names = stores.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  return (list ? `${span} — ${list}` : span).slice(0, 200);
}

/**
 * The administrators' WhatsApp alert of a portal payment proof (owner, 2026-11-05).
 *
 * Automatic: sent once the proof is saved, to every number in `PAYMENT_ALERT_NUMBERS`, through the approved
 * `dukan_payment_submitted` template (`WHATSAPP_TEMPLATE_PAYMENT_SUBMITTED`). An operator message — to our own numbers,
 * so no customer consent applies (`use: 'operator'`). It never decides anything and never blocks the Owner: a failure is
 * logged and the proof is still waiting in the console. One idempotency key per proof and number, so a retry cannot
 * repeat it. Without the template or the numbers it sends nothing and says so in the log.
 */
@Injectable()
export class PaymentAlertService {
  private readonly logger = new Logger(PaymentAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: WhatsAppChannel,
  ) {}

  async proofSubmitted(proof: SubmittedProof): Promise<{ sent: number; skipped?: 'no_numbers' | 'no_template' }> {
    const numbers = this.config.paymentAlertNumbers;
    if (numbers.length === 0) {
      this.logger.warn('Payment proof alert not sent: PAYMENT_ALERT_NUMBERS is empty');
      return { sent: 0, skipped: 'no_numbers' };
    }
    if (!this.config.whatsappTemplateName(PAYMENT_SUBMITTED_TEMPLATE.configKey)) {
      this.logger.warn('Payment proof alert not sent: WHATSAPP_TEMPLATE_PAYMENT_SUBMITTED is not set (template not approved yet)');
      return { sent: 0, skipped: 'no_template' };
    }
    const [company, owner] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: proof.companyId }, select: { name: true, publicStoreId: true } }),
      this.prisma.user.findUnique({ where: { id: proof.submittedBy }, select: { phone: true, phoneVerifiedAt: true } }),
    ]);
    const variables = {
      business: (company?.name?.trim() || proof.stores[0] || company?.publicStoreId || 'A business').slice(0, 100),
      phone: owner?.phoneVerifiedAt && owner.phone ? owner.phone : 'number not verified',
      amount: proof.amount,
      duration: durationText(proof.months, proof.stores),
    };
    let sent = 0;
    for (const [i, to] of numbers.entries()) {
      try {
        const result = await this.whatsapp.send({ to, template: PAYMENT_SUBMITTED_TEMPLATE.key, language: 'en', variables, idempotencyKey: `payment-proof:${proof.id}:${i}` });
        if (result.status === 'failed') this.logger.warn(`Payment proof alert ${i + 1}/${numbers.length} not delivered: ${result.reason}`);
        else sent++;
      } catch {
        this.logger.warn(`Payment proof alert ${i + 1}/${numbers.length} raised an unexpected error`);
      }
    }
    return { sent };
  }
}
