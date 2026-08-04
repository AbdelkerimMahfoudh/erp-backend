import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { HealthService } from './health.service';

@ApiTags('health-score')
@ApiBearerAuth()
@Controller({ version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health-score')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Store health score (0–100, R/A/G) with per-component breakdown' })
  score() {
    return this.health.score();
  }
}
