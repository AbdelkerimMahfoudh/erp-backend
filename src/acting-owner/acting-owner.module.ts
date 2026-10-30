import { Module } from '@nestjs/common';
import { ActingOwnerController } from './acting-owner.controller';
import { ActingOwnerService } from './acting-owner.service';

@Module({
  controllers: [ActingOwnerController],
  providers: [ActingOwnerService],
  exports: [ActingOwnerService],
})
export class ActingOwnerModule {}
