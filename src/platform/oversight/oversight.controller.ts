import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { isUuid, uuidToBin } from '../../common/utils/uuid.util';
import { PlatformAdminGuard } from '../platform-admin.guard';
import { PlatformOversightService, pageOf } from './oversight.service';

/**
 * The console's oversight of the subscription lifecycle (0099; docs/101 §7): the subscription messages and what
 * became of each, the grace decisions against the allowance of three in any rolling 12 months, and the free trials
 * claimed. Administrator reads only: each stands down the tenant guard (`@Public`) and stands behind the platform guard
 * — a verified administrator session — and none reads a tenant header or the tenant context. Nothing here changes a
 * business, sends a message or decides a grace; those stay the lifecycle's, the notices' and the grace rules' own.
 */
@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class PlatformOversightController {
  constructor(private readonly oversight: PlatformOversightService) {}

  /** Every subscription message, newest first; `state` and `kind` narrow it. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('notices')
  noticeLog(@Query('state') state?: string, @Query('kind') kind?: string, @Query('page') page?: string) {
    return this.oversight.noticeLog({ state, kind, page: pageOf(page) });
  }

  /** One business's messages: the timeline as things stand, and the last fifty. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('businesses/:id/notices')
  businessNotices(@Param('id') id: string) {
    if (!isUuid(id)) throw new NotFoundException({ code: 'unknown_business', message: 'Unknown business.' });
    return this.oversight.businessNotices(uuidToBin(id));
  }

  /** The grace decisions, newest first, with how many run now and how many businesses used all three. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('grace')
  graceUsage(@Query('page') page?: string) {
    return this.oversight.graceUsage(pageOf(page));
  }

  /** The free trials claimed, newest first; `status` is `active` or `expired`. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('trial-claims')
  trialClaims(@Query('status') status?: string, @Query('page') page?: string) {
    return this.oversight.trialClaims({ status, page: pageOf(page) });
  }
}
