import { Global, Module } from '@nestjs/common';
import { CLOCK, systemClock } from './clock';
import { EntitlementController } from './entitlement.controller';
import { EntitlementInterceptor } from './entitlement.interceptor';
import { EntitlementService } from './entitlement.service';
import { ProvisioningController } from './provisioning.controller';

/**
 * Subscription entitlement (Milestone K).
 *
 * Global because the guard is global: every module's mutations pass through it,
 * and making each feature module import this would be the scattered arrangement
 * the design exists to avoid.
 */
@Global()
@Module({
  controllers: [EntitlementController, ProvisioningController],
  providers: [
    EntitlementService,
    EntitlementInterceptor,
    { provide: CLOCK, useValue: systemClock },
  ],
  exports: [EntitlementService, EntitlementInterceptor, CLOCK],
})
export class EntitlementModule {}
