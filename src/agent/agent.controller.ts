import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AgentPositionsService } from './agent-positions.service';
import { AgentProvidersService } from './agent-providers.service';
import { AgentReportsService } from './agent-reports.service';
import { AgentTransactionsService } from './agent-transactions.service';
import { DismissAgentMistakeDto, ListAgentMistakesDto, ReportAgentMistakeDto } from './dto/mistake.dto';
import { SetAgentPositionDto } from './dto/position.dto';
import { CreateAgentProviderConfigDto, CreateAgentProviderDto, UpdateAgentProviderDto } from './dto/provider.dto';
import { CreateAgentRebalancingDto, ListAgentRebalancingsDto } from './dto/rebalancing.dto';
import { AgentReportQueryDto } from './dto/report.dto';
import { CreateAgentTransactionDto, ListAgentTransactionsDto, ReverseAgentTransactionDto } from './dto/transaction.dto';

/**
 * The Money Services Agent counter (docs/73, D154–D157). Every route is gated
 * by one of the activity's nine keys (§7); the branch's activity is checked
 * again in each service (D156), and the actor of every record is the session's.
 */
@ApiTags('agent')
@ApiBearerAuth()
@Controller({ path: 'agent', version: '1' })
export class AgentController {
  constructor(
    private readonly providers: AgentProvidersService,
    private readonly positions: AgentPositionsService,
    private readonly transactions: AgentTransactionsService,
    private readonly reports: AgentReportsService,
  ) {}

  // ── Providers and their configuration (the Owner's) ─────────────────────

  /** Any of the nine keys may read the list: the counter needs to know which providers exist. Gated in the service. */
  @Get('providers')
  @ApiOperation({ summary: 'The company’s providers, each with its configuration in force and whether it may post' })
  listProviders() {
    return this.providers.list();
  }

  @Post('providers')
  @RequirePermissions('agent.provider.manage')
  @ApiOperation({ summary: 'Add a provider (Owner)' })
  createProvider(@Body() dto: CreateAgentProviderDto) {
    return this.providers.create(dto);
  }

  @Patch('providers/:id')
  @RequirePermissions('agent.provider.manage')
  @ApiOperation({ summary: 'Rename, reorder or switch a provider off or on (Owner)' })
  updateProvider(@Param('id') id: string, @Body() dto: UpdateAgentProviderDto) {
    return this.providers.update(id, dto);
  }

  @Post('providers/:id/configs')
  @RequirePermissions('agent.provider.manage')
  @ApiOperation({ summary: 'Record a new configuration version — rates, settlement, reference rule — in force from now (Owner)' })
  addProviderConfig(@Param('id') id: string, @Body() dto: CreateAgentProviderConfigDto) {
    return this.providers.addConfig(id, dto);
  }

  @Get('providers/:id/configs')
  @RequirePermissions('agent.provider.manage')
  @ApiOperation({ summary: 'Every configuration version of a provider, newest first (Owner)' })
  listProviderConfigs(@Param('id') id: string) {
    return this.providers.listConfigs(id);
  }

  // ── Positions ───────────────────────────────────────────────────────────

  @Get('positions')
  @RequirePermissions('agent.transaction.view')
  @ApiOperation({ summary: 'The drawer, each provider float and each held commission at this branch now' })
  positionsView() {
    return this.positions.view();
  }

  @Post('positions')
  @RequirePermissions('agent.position.set')
  @ApiOperation({ summary: 'Set what a provider float holds now (Owner)' })
  setPosition(@Body() dto: SetAgentPositionDto) {
    return this.positions.set(dto);
  }

  // ── Exchanges ───────────────────────────────────────────────────────────

  @Post('transactions')
  @RequirePermissions('agent.transaction.record')
  @ApiOperation({ summary: 'Record a cash / digital-credit exchange at the counter' })
  recordTransaction(@Body() dto: CreateAgentTransactionDto) {
    return this.transactions.record(dto);
  }

  @Get('transactions')
  @RequirePermissions('agent.transaction.view')
  @ApiOperation({ summary: 'The branch’s exchanges, masked, newest first' })
  listTransactions(@Query() query: ListAgentTransactionsDto) {
    return this.transactions.list(query);
  }

  @Get('transactions/:id')
  @RequirePermissions('agent.transaction.view')
  @ApiOperation({ summary: 'One exchange; the customer’s number only with agent.customer.reveal' })
  getTransaction(@Param('id') id: string) {
    return this.transactions.detail(id);
  }

  @Post('transactions/:id/reverse')
  @RequirePermissions('agent.transaction.reverse')
  @ApiOperation({ summary: 'Reverse an exchange exactly once, countering every leg (Owner, Manager)' })
  reverseTransaction(@Param('id') id: string, @Body() dto: ReverseAgentTransactionDto) {
    return this.transactions.reverse(id, dto);
  }

  @Post('transactions/:id/mistakes')
  @RequirePermissions('agent.mistake.report')
  @ApiOperation({ summary: 'Report a mistake on a recorded exchange; moves nothing' })
  reportMistake(@Param('id') id: string, @Body() dto: ReportAgentMistakeDto) {
    return this.transactions.reportMistake(id, dto);
  }

  @Get('mistakes')
  @RequirePermissions('agent.transaction.reverse')
  @ApiOperation({ summary: 'The branch’s mistake reports, by status' })
  listMistakes(@Query() query: ListAgentMistakesDto) {
    return this.transactions.listMistakes(query);
  }

  @Post('mistakes/:id/dismiss')
  @RequirePermissions('agent.transaction.reverse')
  @ApiOperation({ summary: 'Dismiss a mistake report: the exchange stands' })
  dismissMistake(@Param('id') id: string, @Body() dto: DismissAgentMistakeDto) {
    return this.transactions.dismissMistake(id, dto);
  }

  // ── Rebalancing ─────────────────────────────────────────────────────────

  @Post('rebalancings')
  @RequirePermissions('agent.rebalance')
  @ApiOperation({ summary: 'Move money between the drawer, the floats and the outside; never a transaction' })
  createRebalancing(@Body() dto: CreateAgentRebalancingDto) {
    return this.transactions.rebalance(dto);
  }

  @Get('rebalancings')
  @RequirePermissions('agent.rebalance')
  @ApiOperation({ summary: 'The branch’s rebalancings over a range of business dates' })
  listRebalancings(@Query() query: ListAgentRebalancingsDto) {
    return this.transactions.listRebalancings(query);
  }

  // ── Reports ─────────────────────────────────────────────────────────────

  @Get('reports')
  @RequirePermissions('agent.report.view')
  @ApiOperation({ summary: 'A day, week, month or year of the counter: by provider and by employee, reversals and rebalancings apart' })
  report(@Query() query: AgentReportQueryDto) {
    return this.reports.report(query);
  }
}
