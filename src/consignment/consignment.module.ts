import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';

/**
 * Inter-store consignment (Milestone H).
 *
 * Deliberately its own module rather than an extension of `TransfersModule`.
 * A stock transfer moves inventory between branches of ONE company; a
 * consignment is between two separate companies, moves custody without moving
 * ownership, and creates a receivable on one side and a payable on the other.
 *
 * `ConnectionsService` uses the UNSCOPED Prisma client, because discovery's
 * whole purpose is to look at companies that are not yours. That makes it the
 * narrowest service in the codebase: four published columns, opted-in rows
 * only, and every result shaped by `toPublicPreview`.
 */
@Module({
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConsignmentModule {}
