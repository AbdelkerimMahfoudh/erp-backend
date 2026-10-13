import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantContext } from '../../common/tenant/tenant-context.service';
import { TrialSetupService } from './trial-setup.service';

/**
 * The free trial as the mobile app may show it (0095; docs/76) — display data only.
 *
 * The owner's correction of 2026-10-13: there is no trial action of any kind in the app. It may say that the
 * business is eligible, that the trial has not started, how long it lasts, whether the setup instructions reached
 * the Owner's verified contacts (masked), and honestly when no channel can carry them — nothing more. The
 * instructions are sent automatically once the contacts are verified, and again only from the website after the
 * Owner signs in, or through support.
 *
 * So this controller has one route, a read, under `account/` — the only path the app may call for the trial. No
 * resend, claim or link route lives under `account/` or `auth/` (a route-table spec proves it), and the answer
 * carries no link, no token, no route and no "you may ask again": nothing a client could act on.
 *
 * The Owner alone (403 `owner_only` for everyone else). Readable in every state (`route-classification.ts`): a
 * business that has not started is exactly the one whose Owner looks at it.
 */
@ApiTags('account')
@ApiBearerAuth()
@Controller({ path: 'account', version: '1' })
export class TrialSetupController {
  constructor(
    private readonly setup: TrialSetupService,
    private readonly tenant: TenantContext,
  ) {}

  @Get('trial-setup')
  @ApiOperation({ summary: 'My business’s free trial eligibility and where its setup instructions stand — display only' })
  status() {
    return this.setup.appStatus({ companyId: this.tenant.companyId(), userId: this.tenant.requireUserId() });
  }
}
