import { Module } from '@nestjs/common';
import { TrackingModule } from '../tracking/tracking.module';
import { CatalogModule } from '../catalog/catalog.module';
import { RecognitionModule } from './recognition.module';
import { ScannerController } from './scanner.controller';
import { TacMappingController } from './tac-mapping.controller';
import { TacMappingService } from './tac-mapping.service';
import { ScannerService } from './scanner.service';

@Module({
  imports: [TrackingModule, CatalogModule, RecognitionModule],
  controllers: [ScannerController, TacMappingController],
  providers: [ScannerService, TacMappingService],
})
export class ScannerModule {}
