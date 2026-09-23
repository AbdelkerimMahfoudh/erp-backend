import { Global, Module } from '@nestjs/common';
import { BusinessDayService } from './business-day.service';

/**
 * Global on purpose: every module that writes a money record needs the same
 * assignment, and a module that had to import it could forget to.
 */
@Global()
@Module({
  providers: [BusinessDayService],
  exports: [BusinessDayService],
})
export class BusinessDayModule {}
