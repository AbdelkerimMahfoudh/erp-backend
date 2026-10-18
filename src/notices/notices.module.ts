import { Global, Module } from '@nestjs/common';
import { NoticeService } from './notice.service';
import { NoticeWorker } from './notice.worker';

/**
 * The subscription messages (0099; docs/101 §6): the outbox and its clock. Global, because the lifecycle, the trial's
 * setup and the portal each bring a business's timeline up to date or read it, as the messaging module's channels are.
 */
@Global()
@Module({
  providers: [NoticeService, NoticeWorker],
  exports: [NoticeService],
})
export class NoticesModule {}
