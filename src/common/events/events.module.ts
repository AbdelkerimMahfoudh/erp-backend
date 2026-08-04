import { Global, Module } from '@nestjs/common';
import { SpineEventBus } from './spine-event-bus';

@Global()
@Module({
  providers: [SpineEventBus],
  exports: [SpineEventBus],
})
export class EventsModule {}
