import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { OwnerInvitationService } from './owner-invitation.service';
import { AcceptInvitationDto, OWNER_SETUP_THROTTLE } from './platform.controller';
import { ProvisioningService } from './provisioning.service';

/**
 * An Owner's first password, from the app (0075, D217).
 *
 * The same act as the website's `platform/owner-invitation/accept`, under `auth/`, because the app never calls a
 * `/platform/` route (its boundary test bans them). Nothing is duplicated: both doors spend the code through
 * {@link OwnerInvitationService.accept}, with the same refusal for every unusable code — a customer's included while
 * customer activation is closed — in the same throttle budget. It issues no session: the Owner then signs in.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AppOwnerSetupController {
  constructor(
    private readonly invitations: OwnerInvitationService,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Public()
  @Throttle(OWNER_SETUP_THROTTLE)
  @Post('owner-setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Spend the one-time setup code the platform gave the Owner, and set their password' })
  async setup(@Body() dto: AcceptInvitationDto, @Req() req: Request) {
    const result = await this.invitations.accept(dto.token, dto.password, {
      ip: req.ip,
      mayAccept: (companyId) => this.provisioning.mayAcceptInvitation(companyId),
    });
    return { ...result, next: 'sign_in' };
  }
}
