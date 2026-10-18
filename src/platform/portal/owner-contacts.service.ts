import { ConflictException, ForbiddenException, BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CLOCK, type Clock } from '../../entitlement/clock';
import { ContactVerificationService } from '../contact-verification.service';
import { TrialSetupService } from '../trial/trial-setup.service';
import { maskForOwner } from '../trial/trial-rules';
import type { TrialPrincipal } from '../trial/trial-facts';

/**
 * The Owner's optional email address, verified from the portal (0099; docs/101 §6).
 *
 * The WhatsApp number is the contact the registration verifies; an email address given beside it stays unverified
 * until its Owner proves it here — and only a verified address may carry a subscription message when WhatsApp cannot.
 * The code goes to the address already on the account, never to one a request names, so this can neither change the
 * address nor be aimed at somebody else's.
 */
@Injectable()
export class OwnerContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: ContactVerificationService,
    private readonly trialSetup: TrialSetupService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Send the code. Refused for anybody but the Owner, without an address, or once it is verified. */
  async startEmailVerification(who: TrialPrincipal, language: 'en' | 'fr' | 'ar'): Promise<{ destination: string; delivery: 'sent' | 'outbox' }> {
    const email = await this.unverifiedEmailOf(who);
    const started = await this.verification.start(email, language);
    return { destination: maskForOwner('email', email), delivery: started.delivery };
  }

  /** Check the code; the address becomes verified, and the trial's portal instructions follow if they were waiting for it. */
  async confirmEmailVerification(who: TrialPrincipal, code: string): Promise<{ emailVerified: true }> {
    const email = await this.unverifiedEmailOf(who);
    if (!(await this.verification.confirm(email, code))) {
      throw new BadRequestException({ code: 'invalid_code', message: 'That code is not right, or it has expired. Ask for a new one.' });
    }
    const now = this.clock.now();
    // Conditional on the address the code went to: an address changed meanwhile is not verified by it.
    await this.prisma.user.updateMany({ where: { id: who.userId, companyId: who.companyId, email, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
    await this.prisma.auditLog.create({
      data: {
        companyId: who.companyId,
        userId: who.userId,
        entityType: 'User',
        entityId: who.userId,
        action: 'update',
        after: { email: maskForOwner('email', email), emailVerifiedAt: now.toISOString() },
        reason: 'Email address verified by its holder from the Dukan ERP portal',
      },
    });
    // A business registered with an email address only, before the number was mandatory, waits for this one.
    await this.trialSetup.onContactsVerified(who.companyId, who.userId);
    return { emailVerified: true };
  }

  private async unverifiedEmailOf(who: TrialPrincipal): Promise<string> {
    const owner = await this.prisma.user.findFirst({
      where: { id: who.userId, companyId: who.companyId, isActive: true, deletedAt: null, userBranches: { some: { role: { key: 'owner' } } } },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!owner) throw new ForbiddenException({ code: 'owner_only', message: 'Only the business owner can do this.' });
    if (!owner.email) throw new ConflictException({ code: 'email_missing', message: 'There is no email address on this account.' });
    if (owner.emailVerifiedAt) throw new ConflictException({ code: 'email_already_verified', message: 'This email address is already verified.' });
    return owner.email;
  }
}
