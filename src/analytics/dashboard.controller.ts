import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { HOME_PERIODS, type HomePeriod } from '../common/business-day';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller({ version: '1' })
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * Home (0076). No route permission — the screen is everyone's — and every
   * section is gated inside by what the caller may see.
   */
  @Get('home')
  @ApiQuery({ name: 'period', required: false, enum: HOME_PERIODS, description: 'today | week | month (default week)' })
  @ApiOperation({ summary: 'Home: business-date figures and series, top partner, latest phones, the closing card' })
  home(@Query('period') period?: string) {
    const chosen = (period ?? 'week') as HomePeriod;
    if (!HOME_PERIODS.includes(chosen)) throw new BadRequestException('period must be today, week or month');
    return this.dashboard.home(chosen);
  }

  @Get('dashboard')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Full dashboard: snapshot + best/worst/dead stock + branch & employee comparison' })
  full() {
    return this.dashboard.dashboard();
  }
}
