import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/**
 * Bringing a shop's stock list in (Milestone G).
 *
 * The uploaded file is held in memory and never written to disk — a stock list
 * is commercially sensitive, and keeping a copy nobody asked us to keep is a
 * liability with no matching benefit. What persists is the parsed result.
 */
@Module({
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
