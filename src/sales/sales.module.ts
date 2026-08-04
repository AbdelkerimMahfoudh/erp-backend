import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SalesPolicyService } from './sales-policy.service';

@Module({
  controllers: [SalesController],
  providers: [SalesService, SalesPolicyService],
  exports: [SalesService],
})
export class SalesModule {}
