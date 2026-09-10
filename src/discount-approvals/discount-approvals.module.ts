import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { DiscountApprovalsController } from './discount-approvals.controller';
import { DiscountApprovalsService } from './discount-approvals.service';

/** Owner-approved exceptions to the configured selling price (A2). */
@Module({
  // Notifications are written here as typed rows with a link and a dedupe key,
  // the same as transfers and returns — see `notify()` for why the service's
  // generic `emit` was the wrong door.
  imports: [PricingModule],
  controllers: [DiscountApprovalsController],
  providers: [DiscountApprovalsService],
  exports: [DiscountApprovalsService],
})
export class DiscountApprovalsModule {}
