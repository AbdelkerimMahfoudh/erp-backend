import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller({ version: '1' })
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('home')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Owner snapshot: today/month totals and inventory value' })
  home() {
    return this.dashboard.home();
  }

  @Get('dashboard')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Full dashboard: snapshot + best/worst/dead stock + branch & employee comparison' })
  full() {
    return this.dashboard.dashboard();
  }
}
