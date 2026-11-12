import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WHATSAPP_CHANNEL, type WhatsAppChannel } from '../messaging/whatsapp-channel';
import { ADMIN_OVERDUE_TEMPLATE, ADMIN_PROOF_TEMPLATE, type TemplateDefinition } from '../messaging/templates';
import { binToUuid } from '../common/utils/uuid.util';

export interface SubmittedProof {
  id: string;
  companyId: Buffer;
  submittedBy: Buffer;
  amount: string;
  months: number | null;
  stores: readonly string[];
}

/** "3 months — Tevragh Zeina, Ksar": the duration and the stores it pays for (kept for the console's own wording). */
export function durationText(months: number | null, stores: readonly string[]): string {
  const span = months === null ? 'an unstated duration' : months === 1 ? '1 month' : `${months} months`;
  const names = stores.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  return (list ? `${span} — ${list}` : span).slice(0, 200);
}

/** 0138: how often the overdue review check runs, and after how long an opened proof is overdue (the 24-hour target). */
const OVERDUE_CHECK_MS = 10 * 60_000;
export const REVIEW_OVERDUE_AFTER_MS = 24 * 60 * 60_000;

/**
 * The administrators' WhatsApp alerts about payment proofs (owner, 2026-11-05; 0138, 2026-11-12).
 *
 * To the administrators' own numbers (`PAYMENT_ALERT_NUMBERS`, the server's environment only), through approved utility
 * templates that carry no variable: no link, no customer or money details. A new proof alerts once; a correction never
 * does (it is not a new payment). A proof whose access was opened and not decided 24 hours later alerts once as overdue;
 * the access stays open until a decision. Each is marked on the proof before it is sent, in one conditional update, so a
 * retry, a second instance or a restart cannot send it twice. Without the template or the numbers nothing is sent — and
 * nothing is marked, so the alert is not lost by a template still waiting for Meta.
 */
@Injectable()
export class PaymentAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentAlertService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(WHATSAPP_CHANNEL) private readonly whatsapp: WhatsAppChannel,
    @Optional() @Inject('PAYMENT_ALERT_CLOCK') private readonly clock: { now: () => Date } = { now: () => new Date() },
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.alertOverdue().catch(() => undefined), OVERDUE_CHECK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** A new proof: "A payment proof was submitted. Please verify it in the admin portal." — once. */
  async proofSubmitted(proof: Pick<SubmittedProof, 'id'> & Partial<SubmittedProof>): Promise<{ sent: number; skipped?: 'no_numbers' | 'no_template' | 'already' }> {
    return this.once(proof.id, 'alertedAt', ADMIN_PROOF_TEMPLATE, 'proof');
  }

  /** Every opened proof past the review target with no decision: "review overdue" — once each. Access stays open. */
  async alertOverdue(): Promise<number> {
    const due = await this.prisma.paymentProof.findMany({
      where: { status: 'under_review', openedAt: { lte: new Date(this.clock.now().getTime() - REVIEW_OVERDUE_AFTER_MS) }, overdueAlertedAt: null },
      select: { id: true },
      take: 50,
    });
    let alerted = 0;
    for (const p of due) if ((await this.once(binToUuid(p.id), 'overdueAlertedAt', ADMIN_OVERDUE_TEMPLATE, 'overdue')).sent > 0) alerted++;
    return alerted;
  }

  private async once(id: string, mark: 'alertedAt' | 'overdueAlertedAt', template: TemplateDefinition, kind: string) {
    const numbers = this.config.paymentAlertNumbers;
    if (numbers.length === 0) {
      this.logger.warn(`Payment ${kind} alert not sent: PAYMENT_ALERT_NUMBERS is empty`);
      return { sent: 0, skipped: 'no_numbers' as const };
    }
    if (!this.config.whatsappTemplateName(template.configKey)) {
      this.logger.warn(`Payment ${kind} alert not sent: ${template.configKey} is not set (template not approved yet)`);
      return { sent: 0, skipped: 'no_template' as const };
    }
    const proofId = Buffer.from(id.replace(/-/g, ''), 'hex');
    // Taken before sending: whoever takes it sends, nobody else ever does.
    const taken = await this.prisma.paymentProof.updateMany({ where: { id: proofId, [mark]: null }, data: { [mark]: this.clock.now() } });
    if (!taken.count) return { sent: 0, skipped: 'already' as const };
    let sent = 0;
    for (const [i, to] of numbers.entries()) {
      try {
        const result = await this.whatsapp.send({ to, template: template.key, language: 'en', variables: {}, idempotencyKey: `${template.key}:${id}:${i}` });
        if (result.status === 'failed') this.logger.warn(`Payment ${kind} alert ${i + 1}/${numbers.length} not delivered: ${result.reason}`);
        else sent++;
      } catch {
        this.logger.warn(`Payment ${kind} alert ${i + 1}/${numbers.length} raised an unexpected error`);
      }
    }
    return { sent };
  }
}
