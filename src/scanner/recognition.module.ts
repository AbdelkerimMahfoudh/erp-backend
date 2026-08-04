import { Module } from '@nestjs/common';
import { RecognitionService } from './recognition.service';
import { CONFIDENCE_SCORER } from './confidence/confidence-scorer';
import { DefaultConfidenceScorer } from './confidence/default-confidence.scorer';

/**
 * Recognition memory + pluggable confidence. Exported so catalog (teach on
 * product create) and the scanner (resolve) share one instance. Swap the
 * CONFIDENCE_SCORER binding to change scoring globally.
 */
@Module({
  providers: [
    RecognitionService,
    { provide: CONFIDENCE_SCORER, useClass: DefaultConfidenceScorer },
  ],
  exports: [RecognitionService],
})
export class RecognitionModule {}
