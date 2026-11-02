import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RecordMaintenanceDto, ReverseMaintenanceDto } from './dto/maintenance.dto';
import { MaintenanceService } from './maintenance.service';

@ApiTags('maintenance')
@ApiBearerAuth()
@Controller({ path: 'maintenance', version: '1' })
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Post()
  @RequirePermissions('maintenance.record')
  @ApiOperation({ summary: 'Record money from a repair: never a sale, never stock' })
  record(@Body() dto: RecordMaintenanceDto) {
    return this.maintenance.record(dto);
  }

  @Get()
  @RequirePermissions('maintenance.record')
  list(@Query('from') from?: string, @Query('to') to?: string) {
    return this.maintenance.list({ from, to });
  }

  @Get(':id')
  @RequirePermissions('maintenance.record')
  get(@Param('id') id: string) {
    return this.maintenance.get(id);
  }

  @Post(':id/reverse')
  @RequirePermissions('maintenance.record')
  reverse(@Param('id') id: string, @Body() dto: ReverseMaintenanceDto) {
    return this.maintenance.reverse(id, dto.reason, dto.clientUuid);
  }
}
