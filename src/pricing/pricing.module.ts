import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

/**
 * Exported so Sell and Transfers can use the same resolver and the same
 * invalidation, instead of each re-deriving what a thing costs.
 */
@Module({
  controllers: [PricingController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
