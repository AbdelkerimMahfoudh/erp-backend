import { Module } from '@nestjs/common';
import { DeviceCatalogueController } from './device-catalogue.controller';
import { DeviceCatalogueService } from './device-catalogue.service';
import { TrackingModule } from '../tracking/tracking.module';
import { RecognitionModule } from '../scanner/recognition.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [TrackingModule, RecognitionModule],
  controllers: [CatalogController, DeviceCatalogueController],
  providers: [CatalogService, DeviceCatalogueService],
  exports: [CatalogService, DeviceCatalogueService],
})
export class CatalogModule {}
