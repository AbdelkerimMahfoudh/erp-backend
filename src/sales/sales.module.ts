import { Module } from '@nestjs/common';
import { DiscountApprovalsModule } from '../discount-approvals/discount-approvals.module';
import { PricingModule } from '../pricing/pricing.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SalesPolicyService } from './sales-policy.service';
import { SalePaymentsService } from './sale-payments.service';

@Module({
  imports: [DiscountApprovalsModule, PricingModule],
  controllers: [SalesController],
  providers: [SalesService, SalesPolicyService, SalePaymentsService],
  exports: [SalesService],
})
export class SalesModule {}
