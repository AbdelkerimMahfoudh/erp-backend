import { Module } from '@nestjs/common';
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
import {
  ContactDeliveryProvider,
  outboxAllowed,
  OutboxDeliveryProvider,
  UnconfiguredDeliveryProvider,
  WhatsAppContactDeliveryProvider,
} from './contact-delivery';
import { WHATSAPP_CHANNEL, WhatsAppChannel } from '../messaging/whatsapp-channel';

/**
 * Which delivery provider is real is an environment decision, and the unsafe
 * combination is refused rather than defaulted: production with nothing
 * configured gets a provider that throws, never the outbox. An outbox in
 * production would tell every new shop a code was on its way and strand all
 * of them.
 *
 * Order of preference:
 *  1. a real WhatsApp channel (`cloud-api`) — codes go out as messages;
 *  2. the development outbox, where it is allowed;
 *  3. the honest refusal.
 *
 * The development-log channel is deliberately NOT treated as real: it prints
 * codes to a log sink, which is what the outbox already does more safely.
 */
export function selectContactDelivery(
  channel: WhatsAppChannel,
  whatsapp: WhatsAppContactDeliveryProvider,
  outbox: OutboxDeliveryProvider,
  unconfigured: UnconfiguredDeliveryProvider,
  allowOutbox: boolean = outboxAllowed(),
): ContactDeliveryProvider {
  if (channel.isEnabled && channel.name !== 'development-log') return whatsapp;
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
  controllers: [PlatformController, SeatRequestsController],
  providers: [
    HashingService,
    PlatformAdminService,
    PlatformAdminGuard,
    PlatformAuditService,
    SubscriptionLifecycleService,
    RegistrationService,
    BillingService,
    ContactVerificationService,
    PortalHandoffService,
    RegistrationContinuationService,
    OwnerInvitationService,
    SeatAllocationService,
    StaffActivationService,
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
       */
      inject: [WHATSAPP_CHANNEL, WhatsAppContactDeliveryProvider, OutboxDeliveryProvider, UnconfiguredDeliveryProvider],
      useFactory: selectContactDelivery,
    },
    WhatsAppContactDeliveryProvider,
    OutboxDeliveryProvider,
    UnconfiguredDeliveryProvider,
  ],
  exports: [
    PlatformAdminService,
    SubscriptionLifecycleService,
    RegistrationService,
    BillingService,
    // For the staff module (docs/21, 2026-10-05): verification, delivery, seats and activation.
    ContactVerificationService,
    ContactDeliveryProvider,
    OutboxDeliveryProvider,
    SeatAllocationService,
    StaffActivationService,
  ],
})
export class PlatformModule {}
