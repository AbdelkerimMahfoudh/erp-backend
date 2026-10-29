import { Module, OnModuleInit } from '@nestjs/common';
import { PlatformMfaService } from './platform-mfa.service';
import { PlatformMfaController } from './platform-mfa.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { HashingService } from '../common/security/hashing.service';
import { PlatformController } from './platform.controller';
import { SeatRequestsController } from './seat-requests.controller';
import { SeatAllocationService } from './seat-allocation.service';
import { StaffActivationService } from './staff-activation.service';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAuditService } from './platform-audit.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { RegistrationService } from './registration.service';
import { BillingService } from '../billing/billing.service';
import { ContactVerificationService } from './contact-verification.service';
import { EntitlementModule } from '../entitlement/entitlement.module';
import { AuthModule } from '../auth/auth.module';
import { PortalHandoffService } from './portal-handoff.service';
import { RegistrationContinuationService } from './registration-continuation.service';
import { OwnerInvitationService } from './owner-invitation.service';
import { ProvisioningService } from './provisioning.service';
import { RegistrationFlowService } from './registration-flow.service';
import { AppRegistrationController } from './app-registration.controller';
import { AppOwnerSetupController } from './app-owner-setup.controller';
import { TrialService } from './trial/trial.service';
import { TrialController } from './trial/trial.controller';
import { TrialSetupService } from './trial/trial-setup.service';
import { TrialSetupController } from './trial/trial-setup.controller';
import { TrialEndSweeper } from './trial/trial-end.sweeper';
import { PortalSessionController } from './portal/portal-session.controller';
import { PortalSessionService } from './portal/portal-session.service';
import { PortalAccountController } from './portal/portal-account.controller';
import { OwnerContactsService } from './portal/owner-contacts.service';
import { PlatformOversightController } from './oversight/oversight.controller';
import { PlatformOversightService } from './oversight/oversight.service';
import {
  ContactDeliveryProvider,
  outboxAllowed,
  OutboxDeliveryProvider,
  SelectedContactDelivery,
  UnconfiguredDeliveryProvider,
  WhatsAppContactDeliveryProvider,
  isRealChannel,
} from './contact-delivery';
import { WHATSAPP_CHANNEL, WhatsAppChannel } from '../messaging/whatsapp-channel';
import { AcquisitionService } from '../acquisition/acquisition.service';
import { LookupLimiter } from '../acquisition/lookup-limiter';
import { PromoterService } from '../acquisition/promoter.service';
import { ReferralInvitationService } from '../acquisition/referral-invitation.service';
import {
  AppAcquisitionController,
  PromotersController,
  ReferralInvitationsController,
  WebsiteAcquisitionController,
} from '../acquisition/acquisition.controllers';
import { EMAIL_CHANNEL, EmailChannel } from '../messaging/email-channel';
import { AccountSetupCodeService } from './account-setup-code.service';
import { AccountProvisioningService } from './account-provisioning.service';
import { AccountProvisioningController } from './account-provisioning.controller';

/**
 * Which delivery provider is real is an environment decision, and the unsafe
 * combination is refused rather than defaulted: production with nothing
 * configured gets a provider that throws, never the outbox. An outbox in
 * production would tell every new shop a code was on its way and strand all
 * of them.
 *
 * Order of preference:
 *  1. a real channel — WhatsApp (`cloud-api`) or email (`resend`) — codes go out as messages, and a contact of
 *     the other kind is refused honestly;
 *  2. the development outbox, where it is allowed;
 *  3. the honest refusal.
 *
 * The development-log channel is deliberately NOT treated as real: it prints
 * codes to a log sink, which is what the outbox already does more safely.
 *
 * Asked on every call, never once at boot (F11, `SelectedContactDelivery`):
 * whether WhatsApp is open in production depends on delivery proofs that load
 * after the module is built.
 */
export function selectContactDelivery(
  channel: WhatsAppChannel,
  whatsapp: WhatsAppContactDeliveryProvider,
  outbox: OutboxDeliveryProvider,
  unconfigured: UnconfiguredDeliveryProvider,
  allowOutbox: boolean = outboxAllowed(),
  email?: EmailChannel,
): ContactDeliveryProvider {
  if (isRealChannel(channel) || (email && isRealChannel(email))) return whatsapp;
  if (allowOutbox) return outbox;
  return unconfigured;
}

/**
 * Platform control.
 *
 * Note what this module does NOT import: the tenant Prisma client. Everything
 * here uses the unscoped {@link PrismaService}, because none of it belongs to a
 * company — and because a tenant-scoped client would silently filter the very
 * cross-business queries an administration portal exists to run.
 *
 * The guard is provided, never registered globally. Platform routes opt in with
 * `@UseGuards`, so no tenant route can accidentally start accepting an
 * administrator session.
 */
@Module({
  imports: [PrismaModule, EntitlementModule, AuthModule],
  controllers: [
    PlatformController,
    AccountProvisioningController,
    SeatRequestsController,
    PlatformMfaController,
    AppRegistrationController,
    // An Owner's setup code spent from the app (D217): the same act as platform/owner-invitation/accept.
    AppOwnerSetupController,
    TrialController,
    TrialSetupController,
    // The Dukan ERP portal (0099): its own sign-in on the app's identity, and the Owner's routes beside the subscription.
    PortalSessionController,
    PortalAccountController,
    // The console's oversight of the lifecycle (0099): messages, grace decisions, trial claims — reads only.
    PlatformOversightController,
    // Where a self-registered business came from (0103, D221): promoters, user invitations, the public lookups by both
    // doors, and the console's reports. Here because the registration that writes the attribution lives here.
    WebsiteAcquisitionController,
    AppAcquisitionController,
    PromotersController,
    ReferralInvitationsController,
  ],
  providers: [
    HashingService,
    AccountSetupCodeService,
    AccountProvisioningService,
    PlatformAdminService,
    PlatformMfaService,
    PlatformAdminGuard,
    PlatformAuditService,
    SubscriptionLifecycleService,
    RegistrationService,
    BillingService,
    ContactVerificationService,
    PortalHandoffService,
    RegistrationContinuationService,
    RegistrationFlowService,
    OwnerInvitationService,
    TrialService,
    TrialSetupService,
    PortalSessionService,
    OwnerContactsService,
    PlatformOversightService,
    // Mandatory (D176): what was paid for during a free trial is put in force when it ends, looked at or not.
    TrialEndSweeper,
    SeatAllocationService,
    StaffActivationService,
    // Test businesses, the customer-activation gate and the console's stores (D217).
    ProvisioningService,
    AcquisitionService,
    LookupLimiter,
    PromoterService,
    ReferralInvitationService,
    {
      provide: ContactDeliveryProvider,
      /*
       * A factory over the REGISTERED instances, never `useClass`.
       *
       * useClass makes Nest build a SECOND instance, so the outbox that
       * stored a code and the outbox something later reads are different
       * objects — and the code is silently never found. Selecting among the
       * single registered instances is what makes the development flow work
       * at all.
       *
       * And the selection runs per call, not here (F11): built now, it would
       * be made before the WhatsApp delivery proofs are read, and a
       * WhatsApp-only production deployment would refuse every code until it
       * was restarted.
       */
      inject: [WHATSAPP_CHANNEL, WhatsAppContactDeliveryProvider, OutboxDeliveryProvider, UnconfiguredDeliveryProvider, EMAIL_CHANNEL],
      useFactory: (
        channel: WhatsAppChannel,
        real: WhatsAppContactDeliveryProvider,
        outbox: OutboxDeliveryProvider,
        unconfigured: UnconfiguredDeliveryProvider,
        email: EmailChannel,
      ) => new SelectedContactDelivery(() => selectContactDelivery(channel, real, outbox, unconfigured, outboxAllowed(), email)),
    },
    WhatsAppContactDeliveryProvider,
    OutboxDeliveryProvider,
    UnconfiguredDeliveryProvider,
  ],
  exports: [
    PlatformAdminService,
    PlatformMfaService,
    SubscriptionLifecycleService,
    RegistrationService,
    BillingService,
    // For the staff module (docs/21, 2026-10-05): verification, delivery, seats and activation.
    ContactVerificationService,
    ContactDeliveryProvider,
    OutboxDeliveryProvider,
    SeatAllocationService,
    StaffActivationService,
    // For the account module (0095): the free trial's setup instructions follow a WhatsApp number verified in the app.
    TrialSetupService,
  ],
})
export class PlatformModule implements OnModuleInit {
  constructor(
    private readonly admins: PlatformAdminService,
    private readonly mfa: PlatformMfaService,
  ) {}

  /** Every step-up confirmation checks the session's password-and-code step-up (0094). */
  onModuleInit(): void {
    this.admins.useStepUpCheck(this.mfa);
  }
}
