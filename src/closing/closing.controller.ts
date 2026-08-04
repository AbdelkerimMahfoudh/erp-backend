import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ClosingService } from './closing.service';
import { CreateClosingDto } from './dto/create-closing.dto';

@ApiTags('closing')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ClosingController {
  constructor(private readonly closing: ClosingService) {}

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
