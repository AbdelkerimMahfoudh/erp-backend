import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { WHATSAPP_CHANNEL, type WhatsAppChannel } from '../messaging/whatsapp-channel';
import { assertLanguageSupported, getTemplate, validateTemplateVariables } from '../messaging/templates';
import type { Notice, NoticeContext } from './closing-notices';

export interface NoticeOutcome {
  /** Owners who received a NEW in-app notification (a retry counts as 0). */
  notified: number;
  /** Owners already told about this exact event — the retry was deduplicated. */
  deduplicated: number;
  /** WhatsApp deliveries the channel accepted. */
  sent: number;
  /** Provider-neutral reasons, one per owner who could not be sent to. */
  failures: string[];
}

/**
 * Delivers an Owner notice (docs/50 §3.4), and never lets a delivery problem
 * reach the sale or the close that caused it.
 *
 * Order matters: the in-app notification is inserted FIRST with the event's
 * stable `dedupeKey`, so a retried request finds the unique index already
 * taken and sends nothing again. Only a fresh insert goes on to WhatsApp, with
 * the same key as its idempotency reference. A shop with no provider gets the
 * in-app notice and a recorded `channel_unavailable`; an Owner with no phone
 * gets the in-app notice alone.
 */
@Injectable()
export class ClosingNoticeService {
  private readonly logger = new Logger(ClosingNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WHATSAPP_CHANNEL) private readonly channel: WhatsAppChannel,
  ) {}

  /** Branch name, zone, currency and the Owner's WhatsApp preferences. */
  async context(companyId: Buffer, branchId: Buffer): Promise<NoticeContext & { businessDate: string }> {
    const [branch, company, settings] = await Promise.all([
      this.prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }),
      this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true, currency: true } }),
      this.prisma.companySettings.findUnique({
        where: { companyId },
        select: { whatsappLanguage: true, whatsappIncludeAmounts: true },
      }),
    ]);
    return {
      branchName: branch?.name ?? '',
      timezone: company?.timezone || 'UTC',
      currency: company?.currency ?? '',
      language: settings?.whatsappLanguage ?? 'en',
      includeAmounts: settings?.whatsappIncludeAmounts ?? false,
      businessDate: '',
    };
  }

  /** Every active Owner of the company, with their WhatsApp number when they have one. */
  private async owners(companyId: Buffer): Promise<{ id: Buffer; phone: string | null }[]> {
    const rows = await this.prisma.userBranch.findMany({
      where: { companyId, role: { key: 'owner' }, user: { isActive: true, deletedAt: null } },
      select: { user: { select: { id: true, phone: true } } },
    });
    const seen = new Map<string, { id: Buffer; phone: string | null }>();
    for (const r of rows) seen.set(r.user.id.toString('hex'), r.user);
    return [...seen.values()];
  }

  async deliver(companyId: Buffer, branchId: Buffer, notice: Notice): Promise<NoticeOutcome> {
    const outcome: NoticeOutcome = { notified: 0, deduplicated: 0, sent: 0, failures: [] };
    try {
      const template = getTemplate(notice.template);
      const variables = validateTemplateVariables(template, notice.variables);
      const owners = await this.owners(companyId);
      const language = (notice.payload.language as 'en' | 'ar' | 'fr' | undefined) ?? 'en';

      for (const owner of owners) {
        let fresh = false;
        try {
          await this.prisma.notification.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              branchId,
              targetUserId: owner.id,
              type: notice.template,
              title: notice.title,
              body: notice.body,
              actionLink: '/closing',
              dedupeKey: notice.dedupeKey,
              payload: notice.payload as Prisma.InputJsonValue,
            },
          });
          fresh = true;
          outcome.notified += 1;
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            outcome.deduplicated += 1;
            continue;
          }
          throw e;
        }
        if (!fresh) continue;
        if (!owner.phone) {
          outcome.failures.push('owner_has_no_phone');
          continue;
        }
        try {
          assertLanguageSupported(template, language);
          const result = await this.channel.send({
            to: owner.phone,
            template: template.key,
            language,
            variables,
            idempotencyKey: `${notice.dedupeKey}:${owner.id.toString('hex')}`,
          });
          if (result.status === 'accepted') outcome.sent += 1;
          else outcome.failures.push(result.reason);
        } catch {
          outcome.failures.push('temporary');
        }
      }
    } catch (e) {
      // A notice must never become the sale's or the close's problem.
      this.logger.warn(`Closing notice ${notice.dedupeKey} could not be delivered: ${(e as Error).message}`);
      outcome.failures.push('notice_failed');
    }
    return outcome;
  }
}
