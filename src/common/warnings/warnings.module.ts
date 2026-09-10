import { Global, Module } from '@nestjs/common';
import { MagnitudeService } from './magnitude.service';
import { WarningGate } from './warning-gate.service';

/**
 * The shared warning engine (A1, A3).
 *
 * Global because the mutations that raise warnings are spread across sales,
 * pricing, intake, expenses and debt — importing a module into each of them
 * would be five identical import lines and one more place to forget.
 */
@Global()
@Module({
  providers: [MagnitudeService, WarningGate],
  exports: [MagnitudeService, WarningGate],
})
export class WarningsModule {}
