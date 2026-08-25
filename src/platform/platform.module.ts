import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HashingService } from '../common/security/hashing.service';
import { PlatformController } from './platform.controller';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAuditService } from './platform-audit.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { RegistrationService } from './registration.service';
import {
  ContactDeliveryProvider,
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
  imports: [PrismaModule],
  controllers: [PlatformController],
  providers: [
    HashingService,
    PlatformAdminService,
    PlatformAdminGuard,
    PlatformAuditService,
    SubscriptionLifecycleService,
    RegistrationService,
    {
      /*
       * Which delivery provider is real is an environment decision, and the
       * unsafe combination is refused rather than defaulted: production with
       * nothing configured gets a provider that throws, never the outbox. An
       * outbox in production would tell every new shop a code was on its way
       * and strand all of them.
       */
      provide: ContactDeliveryProvider,
      useClass:
        process.env.NODE_ENV === 'production'
          ? UnconfiguredDeliveryProvider
          : OutboxDeliveryProvider,
    },
    OutboxDeliveryProvider,
  ],
  exports: [PlatformAdminService, SubscriptionLifecycleService, RegistrationService],
})
export class PlatformModule {}
