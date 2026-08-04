import { Module } from '@nestjs/common';
import { TrackingModule } from '../tracking/tracking.module';
import { RecognitionModule } from '../scanner/recognition.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [TrackingModule, RecognitionModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
