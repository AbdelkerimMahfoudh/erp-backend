import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

/**
 * Money loans (Milestone I).
 *
 * Its own module rather than part of consignment: a loan has no goods, no
 * custody and no disposition. It shares `Counterparty` and the ledger SHAPE,
 * which is why both were designed to be shared in 0049 rather than retrofitted
 * here.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [LoansController],
  providers: [LoansService],
  exports: [LoansService],
})
export class LoansModule {}
