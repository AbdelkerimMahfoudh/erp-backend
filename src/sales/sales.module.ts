import { Module } from '@nestjs/common';
import { DiscountApprovalsModule } from '../discount-approvals/discount-approvals.module';
import { PricingModule } from '../pricing/pricing.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SalesPolicyService } from './sales-policy.service';
import { SalePaymentsService } from './sale-payments.service';
import { SaleSelectionService } from './sale-selection.service';

@Module({
  imports: [DiscountApprovalsModule, PricingModule],
  controllers: [SalesController],
  providers: [SalesService, SalesPolicyService, SalePaymentsService, SaleSelectionService],
  exports: [SalesService],
})
export class SalesModule {}
