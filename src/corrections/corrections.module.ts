import { Module } from '@nestjs/common';
import { CorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';

@Module({
  controllers: [CorrectionsController],
  providers: [CorrectionsService],
  exports: [CorrectionsService],
})
export class CorrectionsModule {}
