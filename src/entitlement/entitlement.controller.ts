import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EntitlementService } from './entitlement.service';
import { RenewalReminderService } from './renewal-reminder.service';

@ApiTags('entitlement')
@ApiBearerAuth()
@Controller({ version: '1' })
export class EntitlementController {
  constructor(
    private readonly entitlement: EntitlementService,
    private readonly reminders: RenewalReminderService,
  ) {}

  /**
   * What this company is entitled to.
   *
   * Deliberately ungated by permission: every role needs to know whether the
   * shop can still write, and a warning that only the Owner can see is a
   * warning the person at the counter discovers by being refused.
   *
   * It is also a GET, so it keeps working after expiry — the screen that
   * explains the lapse must not itself be blocked by the lapse.
   */
  @Get('entitlement')
  @ApiOperation({ summary: 'Subscription state, seats and whether writes are accepted' })
  current() {
    return this.entitlement.current();
  }

  /**
   * The Owner's 3/2/1-day renewal reminder, if one is due now (owner's brief, 2026-11-05): the days left, computed here,
   * and whether one of this Owner's devices showed it already. Any other role is refused (403 `owner_only`). A GET,
   * so it answers during the last days of access as it does before.
   */
  @Get('me/renewal-reminder')
  @ApiOperation({ summary: "The Owner's renewal reminder 3, 2 and 1 days before access ends, if due" })
  renewalReminder() {
    return this.reminders.current();
  }
}
