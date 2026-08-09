import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { TransfersService } from './transfers.service';
import {
  CreateTransferDto,
  ListTransfersDto,
  ReceiveTransferDto,
  SetTransferPrefixDto,
  TransferDecisionDto,
} from './dto/transfer.dto';

@ApiTags('transfers')
@ApiBearerAuth()
@Controller({ path: 'transfers', version: '1' })
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  @RequirePermissions('transfer.view')
  @ApiOperation({
    summary: 'Browse transfers: status filter, search and cursor pagination',
    description:
      'Scoped to the active branch (both ends). Search covers the transfer reference, both branch names, the product and the IMEI/serial.',
  })
  list(@Query() query: ListTransfersDto) {
    return this.transfers.list(query);
  }

  /**
   * Declared BEFORE `:id` on purpose. Nest matches routes in declaration order,
   * so with `:id` first this would arrive as a transfer whose id is "counts".
   */
  @Get('counts')
  @RequirePermissions('transfer.view')
  @ApiOperation({ summary: 'How much transfer work is waiting at the active branch' })
  counts() {
    return this.transfers.counts();
  }

  @Get(':id')
  @RequirePermissions('transfer.view')
  @ApiOperation({
    summary: 'Transfer detail, with the actions the caller may perform',
    description:
      'Each action reports whether it is allowed, why not, and the branch it must be performed from — so a notification opened in the wrong branch can offer to switch rather than simply refuse.',
  })
  get(@Param('id') id: string) {
    return this.transfers.getById(id);
  }

  @Post()
  @RequirePermissions('transfer.request')
  @ApiOperation({
    summary: 'Request a transfer',
    description:
      'Reserves every unit immediately. Starts pending_approval, or approved when the requester already holds transfer.approve here.',
  })
  create(@Body() dto: CreateTransferDto) {
    return this.transfers.create(dto);
  }

  @Post(':id/approve')
  @RequirePermissions('transfer.approve')
  @ApiOperation({ summary: 'Approve a pending request (source branch)' })
  approve(@Param('id') id: string, @Body() dto: TransferDecisionDto) {
    return this.transfers.approve(id, dto);
  }

  @Post(':id/reject')
  @RequirePermissions('transfer.approve')
  @ApiOperation({ summary: 'Refuse a pending request and release the stock (reason required)' })
  reject(@Param('id') id: string, @Body() dto: TransferDecisionDto) {
    return this.transfers.reject(id, dto);
  }

  @Post(':id/ship')
  @RequirePermissions('transfer.ship')
  @ApiOperation({ summary: 'Ship a transfer: units → in transit' })
  ship(@Param('id') id: string, @Body() dto: TransferDecisionDto) {
    return this.transfers.ship(id, dto);
  }

  @Post(':id/receive/preview')
  @RequirePermissions('transfer.receive')
  @ApiOperation({ summary: 'Scan at destination → discrepancy report (no changes)' })
  receivePreview(@Param('id') id: string, @Body() dto: ReceiveTransferDto) {
    return this.transfers.receivePreview(id, dto);
  }

  @Post(':id/receive/confirm')
  @RequirePermissions('transfer.receive')
  @ApiOperation({ summary: 'Confirm receipt → apply inventory, status, audit, notifications' })
  receiveConfirm(@Param('id') id: string, @Body() dto: ReceiveTransferDto & TransferDecisionDto) {
    return this.transfers.receiveConfirm(id, dto);
  }

  /**
   * Guarded on the NARROWER key deliberately.
   *
   * `transfer.cancel_own` is the route key — everyone who may cancel anything
   * holds it, so managers and owners get in too. Breadth is then decided by the
   * service: only `transfer.cancel` may touch somebody else's transfer.
   * Guarding on the broad key instead would have locked employees out of
   * withdrawing their own request; guarding on both would lock managers out,
   * because the guard requires ALL listed permissions.
   */
  @Post(':id/cancel')
  @RequirePermissions('transfer.cancel_own')
  @ApiOperation({ summary: 'Cancel before shipment (reason required)' })
  cancel(@Param('id') id: string, @Body() dto: TransferDecisionDto) {
    return this.transfers.cancel(id, dto);
  }

  @Put('config/prefix')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Set the active branch transfer-number prefix (e.g. NKC)' })
  setPrefix(@Body() dto: SetTransferPrefixDto) {
    return this.transfers.setPrefix(dto.prefix);
  }
}
