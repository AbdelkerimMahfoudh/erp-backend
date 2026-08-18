import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EntitlementService } from './entitlement.service';

@ApiTags('entitlement')
@ApiBearerAuth()
@Controller({ version: '1' })
export class EntitlementController {
  constructor(private readonly entitlement: EntitlementService) {}

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
}
