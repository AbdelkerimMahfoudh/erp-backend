import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { StaffInvitationService } from './staff-invitation.service';
import { CreateStaffDto, StaffJoinConfirmDto, StaffJoinOpenDto, StaffJoinRequestCodeDto } from './dto/staff.dto';

const PUBLIC_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * The Owner's side of team accounts (docs/21, 2026-10-05; D214).
 *
 * `user.manage` is held by the Owner alone, so a Manager or an Employee is
 * refused with 403 before any of this runs. Creating an account here never
 * makes it usable, and sends nothing: it issues an invitation whose reference
 * the Owner is shown once and passes on themselves.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller({ path: 'users', version: '1' })
export class StaffController {
  constructor(private readonly staff: StaffInvitationService) {}

  @Post()
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an employee account that waits to be activated, and its invitation',
    description:
      'A WhatsApp number is required, an email address optional. No WhatsApp message and no email is sent: the answer ' +
      'carries the invitation reference, shown once — the server keeps only its keyed hash. A store with no free seat ' +
      'gets a seat the server prices, waiting for the platform to confirm its payment.',
  })
  create(@Body() dto: CreateStaffDto) {
    return this.staff.invite(dto);
  }

  @Post(':id/invitation')
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'A new invitation for a waiting employee: the previous one and its pending consent end; the reference is shown once.',
  })
  reinvite(@Param('id') id: string) {
    return this.staff.reinvite(id);
  }

  @Post(':id/cancel-invitation')
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw an account that was never activated: its invitation, its pending consent and its seat request end with it.',
  })
  cancel(@Param('id') id: string) {
    return this.staff.cancel(id);
  }
}

/**
 * The employee's side: open the invitation, accept the consent and ask for the
 * code, confirm it. No session exists yet, so these are public and throttled,
 * and every unusable reference — unknown, expired, revoked, used — answers the
 * same way: nothing here says whether a business, a person or a number exists.
 */
@ApiTags('staff')
@Controller({ path: 'staff/join', version: '1' })
export class StaffActivationController {
  constructor(private readonly staff: StaffInvitationService) {}

  @Public()
  @Throttle(PUBLIC_THROTTLE)
  @Post('open')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open an invitation: the business, the person and the number’s last two digits.' })
  open(@Body() dto: StaffJoinOpenDto) {
    return this.staff.open(dto.reference);
  }

  @Public()
  @Throttle(PUBLIC_THROTTLE)
  @Post('request-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The employee’s typed number and own operational WhatsApp consent: records it pending and sends the code. Asked again, a new code under the same agreement.',
  })
  requestCode(@Body() dto: StaffJoinRequestCodeDto, @Req() req: Request) {
    return this.staff.requestCode(dto.reference, dto.number, dto.language, { version: dto.whatsappConsentVersion, locale: dto.whatsappConsentLocale }, req.ip ?? null);
  }

  @Public()
  @Throttle(PUBLIC_THROTTLE)
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The code and a first password: the consent, the invitation and the account, in one transaction.' })
  confirm(@Body() dto: StaffJoinConfirmDto) {
    return this.staff.confirm(dto.reference, dto.code, dto.password);
  }
}
