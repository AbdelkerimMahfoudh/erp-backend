import { Module } from '@nestjs/common';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';

/**
 * Goals (Milestone F).
 *
 * No imports: progress is read straight from `daily_rollups` and the immutable
 * `sales.user_id` attribution, and `AccessService` comes from the global RBAC
 * module. Nothing here recomputes a figure the analytics already own.
 */
@Module({
  controllers: [GoalsController],
  providers: [GoalsService],
  exports: [GoalsService],
})
export class GoalsModule {}
