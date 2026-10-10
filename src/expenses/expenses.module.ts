import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ClosingModule } from '../closing/closing.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  // ROLLUP_QUEUE for net-profit refresh; ClosingService for the day's lock a confirmation takes (D159).
  imports: [AnalyticsModule, ClosingModule],
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
