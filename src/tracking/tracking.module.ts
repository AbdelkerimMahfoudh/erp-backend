import { Module } from '@nestjs/common';
import { TrackingStrategyRegistry } from './tracking-strategy.registry';
import { ProductAttributesService } from './product-attributes.service';

/**
 * Standalone, dependency-free behavior layer for tracking types and adaptive
 * attributes. Exported for catalog (now) and inventory/sales/transfers/scanner
 * (2C.5c–d) to consume without duplicating type logic.
 */
@Module({
  providers: [TrackingStrategyRegistry, ProductAttributesService],
  exports: [TrackingStrategyRegistry, ProductAttributesService],
})
export class TrackingModule {}
