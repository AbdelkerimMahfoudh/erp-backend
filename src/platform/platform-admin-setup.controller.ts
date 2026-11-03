import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { AdminOriginGuard } from './platform-admin.guard';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAdminInvitationService } from './platform-admin-invitation.service';

/**
 * Setting up an invited administrator's account (0115): the one route that spends a setup code.
 *
 * No session: the code is the credential. Every refusal is one refusal (`admin_setup_refused`), so the answer never
 * tells whether an address, a code or an administrator exists; the throttle bounds guessing per address, and the code
 * itself is 192 random bits. The answer carries an enrolment token for this browser only — the next step signs in
 * with the new password and enrols an authenticator with it; nothing administrative opens before that.
 */
const SETUP_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

class AdminSetupDto {
  @IsString() @MaxLength(160) email!: string;
  @IsString() @MaxLength(128) code!: string;
  @IsString() @MaxLength(200) password!: string;
}

@ApiExcludeController()
@Controller({ path: 'platform/admin', version: '1' })
export class PlatformAdminSetupController {
  constructor(private readonly invitations: PlatformAdminInvitationService) {}

  @Public()
  @UseGuards(AdminOriginGuard)
  @Throttle(SETUP_THROTTLE)
  @Post('setup')
  @HttpCode(HttpStatus.OK)
  async setup(@Body() dto: AdminSetupDto, @Req() req: Request) {
    const { enrolmentToken, expiresAt } = await this.invitations.redeem(dto, req.ip ?? null);
    return { enrolmentToken, expiresAt: expiresAt.toISOString() };
  }
}
