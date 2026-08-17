import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ConnectionsService } from './connections.service';
import {
  BlockConnectionDto,
  CreateCounterpartyDto,
  DecideConnectionDto,
  RequestConnectionDto,
} from './dto/connection.dto';

@ApiTags('connections')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

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
