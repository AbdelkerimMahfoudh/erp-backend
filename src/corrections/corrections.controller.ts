import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CorrectionsService } from './corrections.service';
import {
  DecideCorrectionDto,
  ListCorrectionsDto,
  RequestCorrectionDto,
  PreviewCorrectionDto,
} from './dto/correction.dto';

/**
 * Correcting a confirmed payment.
 *
 * Two permissions, deliberately split. `financial.correction.request` belongs
 * to an Owner or Store Manager; `financial.correction.approve` to the Owner
 * alone, because approving is what actually restores a settled liability and
 * puts money back in the drawer.
 *
 * A Store Employee holds neither — the person who reported a payment must not
 * be able to open the process that unwinds it.
 */
@ApiTags('corrections')
@Controller('corrections')
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post()
  @RequirePermissions('financial.correction.request')
  @ApiOperation({
    summary: 'Ask for a confirmed payment to be corrected',
    description:
      'Records the request and nothing else. No cash, liability, profit, inventory or history changes until an owner approves.',
  })
  request(@Body() dto: RequestCorrectionDto) {
    return this.corrections.request(dto);
  }

  /**
   * Declared BEFORE `:id`, or Nest reads "pending" as a correction id and every
   * request answers 404 — the same ordering trap `refunds/summary` hit.
   */
  /**
   * What reclassifying a payment would do (0078): the before and after, the two
   * legs and the day they post to — nothing is written. Same authority as asking.
   */
  @Post('preview')
  @RequirePermissions('financial.correction.request')
  @ApiOperation({ summary: 'Preview moving a payment to the channel it really reached' })
  preview(@Body() dto: PreviewCorrectionDto) {
    return this.corrections.preview(dto);
  }

  @Get()
  @RequirePermissions('financial.correction.request')
  @ApiOperation({ summary: 'Corrections, newest first' })
  list(@Query() query: ListCorrectionsDto) {
    return this.corrections.list(query);
  }

  @Get(':id')
  @RequirePermissions('financial.correction.request')
  @ApiOperation({ summary: 'One correction, with who asked and who decided' })
  detail(@Param('id') id: string) {
    return this.corrections.detail(id);
  }

  @Post(':id/approve')
  @RequirePermissions('financial.correction.approve')
  @ApiOperation({
    summary: 'Approve — the moment the money comes back',
    description:
      'Restores the liability, and posts the opposite cash movement on the CURRENT open business day. Refused with 409 if that day is already closed: a filed closing is never reopened.',
  })
  approve(@Param('id') id: string, @Body() dto: DecideCorrectionDto) {
    return this.corrections.approve(id, dto);
  }

  @Post(':id/reject')
  @RequirePermissions('financial.correction.approve')
  @ApiOperation({ summary: 'Reject. The payment stands as confirmed.' })
  reject(@Param('id') id: string, @Body() dto: DecideCorrectionDto) {
    return this.corrections.reject(id, dto);
  }
}
