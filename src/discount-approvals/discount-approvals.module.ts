import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PricingModule } from '../pricing/pricing.module';
import { DiscountApprovalsController } from './discount-approvals.controller';
import { DiscountApprovalsService } from './discount-approvals.service';

/** Owner-approved exceptions to the configured selling price (A2). */
@Module({
  imports: [NotificationsModule, PricingModule],
  controllers: [DiscountApprovalsController],
  providers: [DiscountApprovalsService],
  exports: [DiscountApprovalsService],
})
export class DiscountApprovalsModule {}
