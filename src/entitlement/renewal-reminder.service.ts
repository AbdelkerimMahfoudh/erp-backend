import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfigService } from '../common/config/app-config.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { PrismaService } from '../prisma/prisma.service';
import { CLOCK, type Clock } from './clock';
import { EntitlementService } from './entitlement.service';
import { reminderDaysLeft, reminderDedupeKey, renewableEnd, type ReminderDays, type ReminderKind } from './renewal-reminder';

export const RENEWAL_REMINDER_TYPE = 'subscription.renewal_reminder';

export interface RenewalReminderView {
  /** The notification that carries it: marking it read (`POST /notifications/:id/read`) hides it on every device. */
  id: string;
  kind: ReminderKind;
  days: ReminderDays;
  /** UTC ISO instant the access ends, and the business's zone to show it in. */
  endsAt: string;
  timeZone: string;
  /** The Owner's subscription page on the portal — no token, no identifier. Empty when no portal is configured. */
  link: string;
  /** Already shown on one of this Owner's devices: the app does not show it again. */
  seen: boolean;
}

/**
 * The in-app 3/2/1-day renewal reminder (owner's brief, 2026-11-05).
 *
 * The Owner only — never a Manager, an Employee or an acting Owner, who cannot renew. The server decides whether one is
 * due and how many days are left (`renewal-reminder.ts`); the phone only shows it. Each milestone is one notification for
 * this Owner (a natural `dedupeKey`, so two devices asking at once still make one), and reading it on any device hides
 * it on all of them. Nothing is due while a payment proof waits for review: the Owner has acted, and the reminder would
 * only press them to pay twice.
 */
@Injectable()
export class RenewalReminderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly entitlement: EntitlementService,
    private readonly config: AppConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async current(): Promise<{ reminder: RenewalReminderView | null }> {
    const companyId = this.tenant.companyId();
    const userId = this.tenant.requireUserId();
    const owner = await this.prisma.userBranch.count({ where: { userId, companyId, role: { key: 'owner' } } });
    if (owner === 0) throw new ForbiddenException({ code: 'owner_only', message: 'Only the Owner sees the renewal reminder.' });

    const e = await this.entitlement.forCompany(companyId);
    const subject = renewableEnd(e);
    if (!subject) return { reminder: null };
    const now = this.clock.now();
    const days = reminderDaysLeft(subject.end, now);
    if (!days) return { reminder: null };
    const pending = await this.prisma.paymentProof.count({ where: { companyId, status: { in: ['submitted', 'under_review'] } } });
    if (pending > 0) return { reminder: null };

    const dedupeKey = reminderDedupeKey(companyId.toString('hex'), userId.toString('hex'), subject.end, days);
    const link = this.config.portalSubscriptionUrl;
    let row = await this.prisma.notification.findFirst({ where: { companyId, targetUserId: userId, dedupeKey }, select: { id: true } });
    if (!row) {
      try {
        row = await this.prisma.notification.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            targetUserId: userId,
            type: RENEWAL_REMINDER_TYPE,
            // The fallback sentence; the app composes its own from the payload, in the reader's language.
            title: days === 1 ? 'Your access ends in 1 day' : `Your access ends in ${days} days`,
            body: 'Open your subscription page to review or renew it.',
            actionLink: link || null,
            dedupeKey,
            payload: { kind: subject.kind, days, endsAt: subject.end.toISOString() },
            createdAt: now,
          },
          select: { id: true },
        });
      } catch (err) {
        // Another device made it first: the unique index decided, and it is the same reminder.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        row = await this.prisma.notification.findFirstOrThrow({ where: { companyId, targetUserId: userId, dedupeKey }, select: { id: true } });
      }
    }
    const seen = (await this.prisma.notificationRead.count({ where: { notificationId: row.id, userId } })) > 0;
    return {
      reminder: { id: binToUuid(row.id), kind: subject.kind, days, endsAt: subject.end.toISOString(), timeZone: e.timeZone, link, seen },
    };
  }
}
