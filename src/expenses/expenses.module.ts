import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  imports: [AnalyticsModule], // ROLLUP_QUEUE for net-profit refresh
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
