import { Module } from '@nestjs/common';
import { OtpService } from '../auth/otp/otp.service';
import { ActingOwnerController } from './acting-owner.controller';
import { ActingOwnerService } from './acting-owner.service';
import { ActingOwnerStepUp } from './acting-owner-step-up';

/**
 * `OtpService` is provided here rather than imported from `AuthModule`, which itself imports this module (the
 * `/auth/me` banner): the same class over the same `otp_challenges` rows, so the same hashing, expiry, attempt lock and
 * per-person and per-number send limits. Its dependencies (Prisma, configuration, audit, the WhatsApp channel) are
 * global.
 */
@Module({
  controllers: [ActingOwnerController],
  providers: [ActingOwnerService, ActingOwnerStepUp, OtpService],
  exports: [ActingOwnerService],
})
export class ActingOwnerModule {}
