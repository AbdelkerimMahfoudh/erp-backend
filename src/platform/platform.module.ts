import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HashingService } from '../common/security/hashing.service';
import { PlatformController } from './platform.controller';
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
import {
  ContactDeliveryProvider,
  outboxAllowed,
  OutboxDeliveryProvider,
  UnconfiguredDeliveryProvider,
} from './contact-delivery';

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
  controllers: [PlatformController],
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
    {
      /*
       * Which delivery provider is real is an environment decision, and the
       * unsafe combination is refused rather than defaulted: production with
       * nothing configured gets a provider that throws, never the outbox. An
       * outbox in production would tell every new shop a code was on its way
       * and strand all of them.
       */
      provide: ContactDeliveryProvider,
      /*
       * useExisting, NOT useClass.
       *
       * useClass makes Nest build a SECOND instance, so the outbox that
       * stored a code and the outbox something later reads are different
       * objects — and the code is silently never found. Aliasing the single
       * registered instance is what makes the development flow work at all.
       */
      useExisting: outboxAllowed() ? OutboxDeliveryProvider : UnconfiguredDeliveryProvider,
    },
    OutboxDeliveryProvider,
    UnconfiguredDeliveryProvider,
  ],
  exports: [PlatformAdminService, SubscriptionLifecycleService, RegistrationService, BillingService],
})
export class PlatformModule {}
