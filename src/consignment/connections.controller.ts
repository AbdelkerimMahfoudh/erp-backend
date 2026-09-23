import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ConnectionsService } from './connections.service';
import { PartnerRankingService } from './partner-ranking.service';
import {
  BlockConnectionDto,
  ConnectionVersionDto,
  CreateCounterpartyDto,
  DecideConnectionDto,
  RequestConnectionDto,
} from './dto/connection.dto';

@ApiTags('connections')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly ranking: PartnerRankingService,
  ) {}

  /**
   * "Most business together" (0076): partners ranked by the value of the
   * trades this branch completed with them, all time. Readable with
   * `consignment.view`, like the list and the summary.
   */
  @Get('partners/ranking')
  @RequirePermissions('consignment.view')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false, description: '1–50, default 20' })
  @ApiOperation({ summary: 'Partners ranked by completed-trade value, all time, paginated' })
  partnerRanking(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.ranking.ranking(Number(page) || 1, Number(limit) || 20);
  }

  /**
   * Search for another shop.
   *
   * Gated on `connection.manage` — Owner only. Searching is the first step of
   * deciding who this business deals with, and it is also the endpoint an
   * attacker would use to enumerate the platform, so it is not left open to
   * every signed-in user.
   */
  @Get('stores/search')
  @RequirePermissions('connection.manage')
  @ApiQuery({ name: 'q', description: 'Store Account ID, phone number, or at least 3 letters of a name' })
  @ApiOperation({ summary: 'Find a store to connect with; returns name, city and logo only' })
  search(@Query('q') q: string) {
    return this.connections.search(q ?? '');
  }

  /**
   * Connections this shop has.
   *
   * Readable with `consignment.view`, which a Manager holds: a manager needs to
   * see who the shop is connected to in order to operate consignments. MANAGING
   * trust stays Owner-only on the routes below.
   */
  /**
   * One store by its exact code, so the person can see who a request would go
   * to before sending it. The same public preview as search, and the same
   * "no such store" for anything search would hide.
   */
  @Get('stores/lookup')
  @RequirePermissions('connection.manage')
  @ApiQuery({ name: 'code', description: 'The exact 10-character Store Account ID' })
  @ApiOperation({ summary: 'Confirm the store behind a code before requesting a connection' })
  lookup(@Query('code') code: string) {
    return this.connections.lookup(code ?? '');
  }

  @Get('connections')
  @RequirePermissions('consignment.view')
  @ApiOperation({ summary: 'Stores this shop is connected to, or has requests with' })
  list() {
    return this.connections.list();
  }

  @Post('connections')
  @RequirePermissions('connection.manage')
  @ApiOperation({ summary: 'Ask another store to connect' })
  request(@Body() dto: RequestConnectionDto) {
    return this.connections.request(dto.publicStoreId, dto.note);
  }

  @Post('connections/:id/decide')
  @RequirePermissions('connection.manage')
  @ApiOperation({ summary: 'Accept or reject a request another store sent you' })
  decide(@Param('id') id: string, @Body() dto: DecideConnectionDto) {
    return this.connections.decide(id, dto.accept, dto.expectedVersion);
  }

  /**
   * Blocking stops NEW requests. It never deletes history and never erases an
   * outstanding balance — a shop cannot escape what it owes by blocking the
   * creditor.
   */
  @Post('connections/:id/block')
  @RequirePermissions('connection.manage')
  @ApiOperation({ summary: 'Block or unblock a store' })
  block(@Param('id') id: string, @Body() dto: BlockConnectionDto) {
    return this.connections.setBlocked(id, dto.blocked, dto.reason);
  }

  /** Withdraw a request this store sent, while it is still waiting. */
  @Post('connections/:id/cancel')
  @RequirePermissions('connection.manage')
  @ApiOperation({ summary: 'Withdraw a connection request you sent' })
  cancel(@Param('id') id: string, @Body() dto: ConnectionVersionDto) {
    return this.connections.cancel(id, dto.expectedVersion);
  }

  /**
   * End an accepted connection. Stops NEW dealings only: existing consignments
   * and loans stay returnable, payable and readable by both stores.
   */
  @Post('connections/:id/remove')
  @RequirePermissions('connection.manage')
  @ApiOperation({ summary: 'End a connection; existing obligations stay settleable' })
  remove(@Param('id') id: string, @Body() dto: ConnectionVersionDto) {
    return this.connections.remove(id, dto.expectedVersion);
  }

  /**
   * Everything two connected stores share: identity, status, who owes whom,
   * whose phones each holds, and what is waiting on whom. Readable with
   * `consignment.view`, like the list.
   */
  @Get('connections/:id/summary')
  @RequirePermissions('consignment.view')
  @ApiOperation({ summary: 'A connected store: balances, custody, pending actions and shared history' })
  summary(@Param('id') id: string) {
    return this.connections.summary(id);
  }

  @Get('counterparties')
  @RequirePermissions('consignment.view')
  @ApiOperation({ summary: 'Everybody this shop deals with — connected stores and manual ones' })
  listCounterparties() {
    return this.connections.listCounterparties();
  }

  /**
   * A shop or person who does not use the application.
   *
   * Owner-only, like every other decision about who the business deals with.
   */
  @Post('counterparties')
  @RequirePermissions('connection.manage')
  @ApiOperation({ summary: 'Record a store or person who does not use the app' })
  createCounterparty(@Body() dto: CreateCounterpartyDto) {
    return this.connections.createManualCounterparty(dto);
  }
}
