import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AnomaliesService } from './anomalies.service';

/**
 * "Needs your attention" (A3).
 *
 * Read-only and advisory. Nothing here refuses a sale, an intake or a closing
 * — every one of the six rules is a sentence on a screen with the numbers that
 * produced it.
 *
 * `report.view` opens the door; the rules inside gate themselves further, and a
 * rule the caller may not see is never computed rather than computed and
 * filtered.
 */
@ApiTags('anomalies')
@Controller('anomalies')
export class AnomaliesController {
  constructor(private readonly anomalies: AnomaliesService) {}

  /**
   * `limit` and `page` slice an already-ordered list: the overview asks for
   * three, the full list pages through the rest, and both see the same order.
   * Without them every row is returned, as before.
   */
  @Get()
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'What needs attention, worked out now from existing figures — newest first' })
  list(@Query('limit') limit?: string, @Query('page') page?: string) {
    return this.anomalies.list({
      limit: limit === undefined ? undefined : Number(limit),
      page: page === undefined ? undefined : Number(page),
    });
  }

  @Post(':key/dismiss')
  @RequirePermissions('report.view')
  @Post(':key/undismiss')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'End a standing dismissal, so the anomaly shows again — the undo' })
  undismiss(@Param('key') key: string) {
    return this.anomalies.undismiss(key);
  }

  @ApiOperation({ summary: 'Silence one anomaly for seven days, for the whole company — a repeat answers the same' })
  dismiss(@Param('key') key: string) {
    return this.anomalies.dismiss(key);
  }
}
