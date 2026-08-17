import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { GoalsService } from './goals.service';
import { CreateGoalDto } from './dto/create-goal.dto';
import { ArchiveGoalDto } from './dto/archive-goal.dto';

@ApiTags('goals')
@ApiBearerAuth()
@Controller({ version: '1' })
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  /**
   * Reading goals is deliberately **not** gated.
   *
   * An employee with a personal target has to be able to see it, and
   * `report.view` — the obvious-looking gate — would hand them the shop's
   * profit reporting at the same time. That is exactly the split `cost.view`
   * and `report.view` already keep apart.
   *
   * The service scopes what comes back: everybody sees the branch's and the
   * company's targets, and a personal target is visible only to the person it
   * is set for and to whoever may manage goals.
   */
  @Get('goals')
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  @ApiOperation({ summary: 'Goals in view, each with progress computed now' })
  list(@Query('includeArchived') includeArchived?: string) {
    return this.goals.list(includeArchived === 'true');
  }

  @Get('goals/:id')
  @ApiOperation({ summary: 'One goal and its progress' })
  get(@Param('id') id: string) {
    return this.goals.get(id);
  }

  /** Setting a target is deciding what the shop is aiming at. */
  @Post('goals')
  @RequirePermissions('goal.manage')
  @ApiOperation({ summary: 'Set a goal for the company, a branch, or a person' })
  create(@Body() dto: CreateGoalDto) {
    return this.goals.create(dto);
  }

  /**
   * Archive, never delete. A goal that was missed is a fact about the shop, and
   * removing it would make every past period look met.
   */
  @Post('goals/:id/archive')
  @RequirePermissions('goal.manage')
  @ApiOperation({ summary: 'Archive a goal, with a reason' })
  archive(@Param('id') id: string, @Body() dto: ArchiveGoalDto) {
    return this.goals.archive(id, dto);
  }
}
