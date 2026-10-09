import { Module } from '@nestjs/common';
import { ClosingModule } from '../closing/closing.module';
import { AgentController } from './agent.controller';
import { AgentPositionsService } from './agent-positions.service';
import { AgentProvidersService } from './agent-providers.service';
import { AgentReportsService } from './agent-reports.service';
import { AgentTransactionsService } from './agent-transactions.service';

/**
 * The Money Services Agent activity (docs/73). The closing module is imported
 * for one reason: the agent's cash IS the branch's drawer — its position is the
 * closing's own figure, and an exchange obeys the same open-first rule a sale
 * does. The closing never imports this module; it reads the ledger's tables
 * through the shared float reads.
 */
@Module({
  imports: [ClosingModule],
  controllers: [AgentController],
  providers: [AgentProvidersService, AgentPositionsService, AgentTransactionsService, AgentReportsService],
})
export class AgentModule {}
