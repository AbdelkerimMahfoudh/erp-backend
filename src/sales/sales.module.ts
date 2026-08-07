import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SalesPolicyService } from './sales-policy.service';

@Module({
  imports: [PricingModule],
  controllers: [SalesController],
  providers: [SalesService, SalesPolicyService],
  exports: [SalesService],
})
export class SalesModule {}
