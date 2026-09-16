import { Module } from '@nestjs/common';
import { ReceivingFilesController } from './receiving-files.controller';
import { ReceivingFilesService } from './receiving-files.service';

@Module({
  controllers: [ReceivingFilesController],
  providers: [ReceivingFilesService],
})
export class ReceivingFilesModule {}
