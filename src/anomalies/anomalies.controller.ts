import { Controller, Get, Param, Post } from '@nestjs/common';
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

  @Get()
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'What needs attention, worked out now from existing figures' })
  list() {
    return this.anomalies.list();
  }

  @Post(':key/dismiss')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Silence one anomaly for seven days, for the whole company' })
  dismiss(@Param('key') key: string) {
    return this.anomalies.dismiss(key);
  }
}
