import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { TransfersService } from './transfers.service';
import { CreateTransferDto, ReceiveTransferDto, SetTransferPrefixDto } from './dto/transfer.dto';

@ApiTags('transfers')
@ApiBearerAuth()
@Controller({ path: 'transfers', version: '1' })
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  @ApiOperation({ summary: 'List transfers' })
  list() {
    return this.transfers.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Transfer detail' })
  get(@Param('id') id: string) {
    return this.transfers.getById(id);
  }

  @Post()
  @RequirePermissions('unit.transfer')
  @ApiOperation({ summary: 'Create a transfer (Ready to Ship) with a transfer number' })
  create(@Body() dto: CreateTransferDto) {
    return this.transfers.create(dto);
  }

  @Post(':id/ship')
  @RequirePermissions('unit.transfer')
  @ApiOperation({ summary: 'Ship a transfer: units → in transit' })
  ship(@Param('id') id: string) {
    return this.transfers.ship(id);
  }

  @Post(':id/receive/preview')
  @RequirePermissions('unit.transfer')
  @ApiOperation({ summary: 'Scan at destination → discrepancy report (no changes)' })
  receivePreview(@Param('id') id: string, @Body() dto: ReceiveTransferDto) {
    return this.transfers.receivePreview(id, dto);
  }

  @Post(':id/receive/confirm')
  @RequirePermissions('unit.transfer')
  @ApiOperation({ summary: 'Confirm receipt → apply inventory, status, audit, notifications' })
  receiveConfirm(@Param('id') id: string, @Body() dto: ReceiveTransferDto) {
    return this.transfers.receiveConfirm(id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('unit.transfer')
  @ApiOperation({ summary: 'Cancel a transfer (revert units to origin)' })
  cancel(@Param('id') id: string) {
    return this.transfers.cancel(id);
  }

  @Put('config/prefix')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Set the active branch transfer-number prefix (e.g. NKC)' })
  setPrefix(@Body() dto: SetTransferPrefixDto) {
    return this.transfers.setPrefix(dto.prefix);
  }
}
