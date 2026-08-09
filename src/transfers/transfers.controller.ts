import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { TransfersService } from './transfers.service';
import {
  CreateTransferDto,
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
  @ApiOperation({ summary: 'List transfers' })
  list() {
    return this.transfers.list();
  }

  @Get(':id')
  @RequirePermissions('transfer.view')
  @ApiOperation({ summary: 'Transfer detail' })
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
   * Either authority reaches this route; the service decides which applies.
   * `transfer.cancel` covers anything in the branch, `transfer.cancel_own` only
   * the caller's own request while it is still pending — and the service proves
   * that, so holding the route permission alone cannot widen it.
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
