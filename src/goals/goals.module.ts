import { Module } from '@nestjs/common';
import { GoalsController } from './goals.controller';

/** Dormant (D227): only the deprecated routes old builds still call. See {@link GoalsController}. */
@Module({ controllers: [GoalsController] })
export class GoalsModule {}
