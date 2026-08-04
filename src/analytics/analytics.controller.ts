import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AnalyticsService } from './analytics.service';

const clampDays = (raw?: string): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : 30;
};

@ApiTags('analytics')
@ApiBearerAuth()
@Controller({ path: 'analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('inventory-value')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: '$ invested + expected profit (units + quantity stock), by tracking type & category' })
  inventoryValue() {
    return this.analytics.inventoryValue();
  }

  @Get('products')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Per-product performance over a window (profit-ranked, with movement)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  products(@Query('days') days?: string) {
    return this.analytics.productPerformance(clampDays(days));
  }

  @Get('categories')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Per-category performance over a window' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  categories(@Query('days') days?: string) {
    return this.analytics.categoryPerformance(clampDays(days));
  }
}
