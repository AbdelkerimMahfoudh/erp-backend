import { Module } from '@nestjs/common';
import { TrackingModule } from '../tracking/tracking.module';
import { CatalogModule } from '../catalog/catalog.module';
import { RecognitionModule } from './recognition.module';
import { ScannerController } from './scanner.controller';
import { ScannerService } from './scanner.service';

@Module({
  imports: [TrackingModule, CatalogModule, RecognitionModule],
  controllers: [ScannerController],
  providers: [ScannerService],
})
export class ScannerModule {}
