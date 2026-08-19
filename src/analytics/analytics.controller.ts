import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AnalyticsService } from './analytics.service';
import { SummaryService } from './summary.service';
import { isoDay } from './accounting-rules';

/*
 * Moved to `accounting-rules.ts` and given tests.
 *
 * It lived here as an inline regex and shipped broken — the escaping was lost,
 * so the pattern matched the literal text `dddd-dd-dd` and every request
 * silently fell back to today. The endpoint answered 200 with a perfectly
 * shaped body for the wrong period, which is the worst way for a report to be
 * wrong: nothing looks broken.
 */

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
