import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EntitlementModule } from '../entitlement/entitlement.module';
import { PlatformModule } from '../platform/platform.module';
import { HashingService } from '../common/security/hashing.service';
import { StaffInvitationService } from './staff-invitation.service';
import { StaffActivationController, StaffController } from './staff.controller';

/**
 * Team accounts that wait to be activated (docs/21, 2026-10-05).
 *
 * Its own module rather than part of `UsersModule`: it needs the platform's
 * contact verification, delivery and seat services, and `AuthModule` already
 * imports `UsersModule` — importing the platform from there would close a
 * cycle.
 */
@Module({
  imports: [PrismaModule, EntitlementModule, PlatformModule],
  controllers: [StaffController, StaffActivationController],
  providers: [HashingService, StaffInvitationService],
})
export class StaffModule {}
