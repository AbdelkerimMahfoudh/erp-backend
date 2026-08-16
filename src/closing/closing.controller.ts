import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ClosingService } from './closing.service';
import { CreateClosingDto } from './dto/create-closing.dto';
import { RecordCountDto } from './dto/record-count.dto';

@ApiTags('closing')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ClosingController {
  constructor(private readonly closing: ClosingService) {}

  /**
   * The day as it stands, per channel (E-CP1).
   *
   * Gated on `closing.count`, not `closing.perform` — the Employee who has to
   * enter the count is the one who needs to see what is outstanding. It writes
   * nothing, so looking cannot commit anything.
   */
  @Get('closings/open/view')
  @RequirePermissions('closing.count')
  @ApiQuery({ name: 'date', required: false, description: 'Day to view; defaults to today (UTC)' })
  @ApiOperation({ summary: 'Live per-channel view of the day being counted' })
  openView(@Query('date') date?: string) {
    return this.closing.openView(date);
  }

  /**
   * Record one channel's count without locking anything.
   *
   * The E0 audit's first finding: counting and signing off were one act held by
   * one permission, so the person holding the drawer could not report what was
   * in it. These are now two acts and two permissions.
   */
  @Post('closings/count')
  @RequirePermissions('closing.count')
  @ApiOperation({ summary: 'Record one channel count; the day stays open and correctable' })
  recordCount(@Body() dto: RecordCountDto) {
    return this.closing.recordCount(dto);
  }

  @Post('closings')
  @RequirePermissions('closing.perform')
  @ApiOperation({ summary: 'Close the day: digest + net profit + cash reconciliation (one transaction)' })
  close(@Body() dto: CreateClosingDto) {
    return this.closing.close(dto);
  }

  @Get('closings/:date')
  @RequirePermissions('closing.perform')
  @ApiOperation({ summary: 'Get a day closing (YYYY-MM-DD)' })
  getClosing(@Param('date') date: string) {
    return this.closing.getClosing(date);
  }

  @Get('digests/:date')
  @RequirePermissions('report.view')
  @ApiOperation({ summary: 'Get a day digest with lines + historical comparison (YYYY-MM-DD)' })
  getDigest(@Param('date') date: string) {
    return this.closing.getDigest(date);
  }
}
