import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AnalyticsService } from './analytics.service';
import { SummaryService } from './summary.service';

/** A date the server trusts. Anything else falls back to today. */
const isoDay = (raw?: string): string =>
  /^d{4}-d{2}-d{2}$/.test(raw ?? '') ? (raw as string) : new Date().toISOString().slice(0, 10);

const clampDays = (raw?: string): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : 30;
};

@ApiTags('analytics')
@ApiBearerAuth()
@Controller({ path: 'analytics', version: '1' })
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly summary: SummaryService,
  ) {}

  /**
   * One consolidated period summary.
   *
   * Gated on `report.view` like every other analytics route, and the cost
   * gating interceptor strips margin for anybody without it — this endpoint
   * must not become the hole the rest of the gating is missing from.
   */
  @Get('summary')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: "Profit, cash, balances and discrepancies for a period, kept apart" })
  @ApiQuery({ name: 'from', required: true, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: true, description: 'YYYY-MM-DD' })
  periodSummary(@Query('from') from: string, @Query('to') to: string) {
    return this.summary.forPeriod(isoDay(from), isoDay(to));
  }

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
