import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountDeletionService } from './account-deletion.service';

/**
 * The signed-in person's own account: identity, WhatsApp verification and
 * account deletion (docs/64). Prisma, hashing and the messaging channel are
 * global; the OTP service comes from the auth module.
 */
@Module({
  imports: [AuthModule],
  controllers: [AccountController],
  providers: [AccountService, AccountDeletionService],
  exports: [AccountDeletionService],
})
export class AccountModule {}
