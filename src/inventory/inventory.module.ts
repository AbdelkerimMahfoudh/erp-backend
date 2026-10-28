import { Module } from '@nestjs/common';
import { TrackingModule } from '../tracking/tracking.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { CostCompletionController } from './cost-completion.controller';
import { CostCompletionService } from './cost-completion.service';

@Module({
  imports: [TrackingModule],
  controllers: [InventoryController, CostCompletionController],
  providers: [InventoryService, CostCompletionService],
  exports: [InventoryService],
})
export class InventoryModule {}
