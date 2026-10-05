import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { StaffInvitationService } from './staff-invitation.service';
import {
  CreateStaffDto,
  ResendStaffVerificationDto,
  StaffVerifyConfirmDto,
  StaffVerifyResendDto,
} from './dto/staff.dto';

const PUBLIC_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * The Owner's side of team accounts (docs/21, 2026-10-05).
 *
 * `user.manage` is held by the Owner alone, so a Manager or an Employee is
 * refused with 403 before any of this runs. Creating an account here never
 * makes it usable: see `StaffActivationService`.
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
    summary: 'Create an employee account that waits to be activated',
    description:
      'Email, WhatsApp number or both. The account is pending until the person verifies every contact given ' +
      'and a seat is held at each store — the first seat per store is included; a further one is priced by the ' +
      'server and waits for the platform to confirm its payment. No code is ever returned.',
  })
  create(@Body() dto: CreateStaffDto) {
    return this.staff.invite(dto);
  }

  @Post(':id/resend-verification')
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send the verification code again on one channel. 503 when nothing can deliver.',
  })
  resend(@Param('id') id: string, @Body() dto: ResendStaffVerificationDto) {
    return this.staff.resend(id, dto.channel);
  }

  @Post(':id/cancel-invitation')
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw an account that was never activated; its seat request is withdrawn with it.',
  })
  cancel(@Param('id') id: string) {
    return this.staff.cancel(id);
  }
}

/**
 * The invited person's side: prove a contact, choose a password. No session
 * exists yet, so these are public and throttled, and shaped not to reveal
 * whether an account is waiting behind a destination.
 */
@ApiTags('staff')
@Controller({ path: 'staff', version: '1' })
export class StaffActivationController {
  constructor(private readonly staff: StaffInvitationService) {}

  @Public()
  @Throttle(PUBLIC_THROTTLE)
  @Post('verify/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Prove an email address or WhatsApp number with its code; set the password the first time.',
  })
  confirm(@Body() dto: StaffVerifyConfirmDto) {
    return this.staff.confirm(dto.destination, dto.code, dto.password);
  }

  @Public()
  @Throttle(PUBLIC_THROTTLE)
  @Post('verify/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask for the code again. Answers the same whether or not an account is waiting.',
  })
  resend(@Body() dto: StaffVerifyResendDto) {
    return this.staff.resendPublic(dto.destination, dto.language);
  }
}
