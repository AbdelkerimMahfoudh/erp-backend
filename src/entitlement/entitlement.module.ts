import { Global, Module } from '@nestjs/common';
import { CLOCK, systemClock } from './clock';
import { EntitlementController } from './entitlement.controller';
import { EntitlementGuard } from './entitlement.guard';
import { EntitlementService } from './entitlement.service';

/**
 * Subscription entitlement (Milestone K).
 *
 * Global because the guard is global: every module's mutations pass through it,
 * and making each feature module import this would be the scattered arrangement
 * the design exists to avoid.
 */
@Global()
@Module({
  controllers: [EntitlementController],
  providers: [
    EntitlementService,
    EntitlementGuard,
    { provide: CLOCK, useValue: systemClock },
  ],
  exports: [EntitlementService, EntitlementGuard, CLOCK],
})
export class EntitlementModule {}
