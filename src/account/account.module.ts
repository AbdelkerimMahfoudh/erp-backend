import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountDeletionService } from './account-deletion.service';

/**
 * The signed-in person's own account: identity, WhatsApp verification and
 * account deletion (docs/64). Prisma, hashing and the messaging channel are
 * global; the OTP service comes from the auth module, and the free trial's
 * setup instructions (sent once a verified number completes an Owner's
 * contacts, 0095) from the platform module.
 */
@Module({
  imports: [AuthModule, PlatformModule],
  controllers: [AccountController],
  providers: [AccountService, AccountDeletionService],
  exports: [AccountDeletionService],
})
export class AccountModule {}
