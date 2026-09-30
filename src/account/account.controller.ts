import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { uuidToBin } from '../common/utils/uuid.util';
import { AccountService } from './account.service';
import { AccountDeletionService, DeletionPrincipal } from './account-deletion.service';
import {
  ConfirmDeletionDto,
  ConfirmPhoneVerificationDto,
  ResendDeletionCodeDto,
  StartDeletionDto,
  StartPhoneVerificationDto,
} from './account.dto';

/**
 * The signed-in person's own account (docs/64).
 *
 * Every route here is about the caller alone — there is no `:userId` and no
 * way to name somebody else — and every code-issuing route is rate-limited on
 * top of the OTP service's own per-person and per-number caps. The routes are
 * classified as always reachable (`route-classification.ts`), because a shop
 * that is pending, suspended or lapsed still has people who must be able to
 * verify a number, see where a deletion stands, and ask for one.
 */
/*
 * Read from the environment at load time, exactly as `auth.controller.ts`
 * does for `AUTH_THROTTLE_LIMIT`: a decorator is evaluated before anything is
 * injected. The Joi schema validates the value and the fallback matches its
 * default, so a missing variable behaves as a present one.
 */
const ACCOUNT_THROTTLE_LIMIT = Number(process.env.ACCOUNT_THROTTLE_LIMIT) || 5;
const SENSITIVE_THROTTLE = { default: { limit: ACCOUNT_THROTTLE_LIMIT, ttl: 60_000 } };

@ApiTags('account')
@ApiBearerAuth()
@Controller({ path: 'account', version: '1' })
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly deletion: AccountDeletionService,
  ) {}

  private principal(user: AuthUser): DeletionPrincipal {
    return {
      userId: uuidToBin(user.userId),
      companyId: uuidToBin(user.companyId),
      sessionId: uuidToBin(user.sessionId),
    };
  }

  @Get()
  @ApiOperation({ summary: 'Who I am, my verified WhatsApp number, and what deleting my account would delete' })
  me(@CurrentUser() user: AuthUser) {
    return this.account.me(this.principal(user));
  }

  @Get('deletion')
  @ApiOperation({ summary: 'My latest account-deletion request, or null' })
  async deletionState(@CurrentUser() user: AuthUser) {
    return { request: await this.deletion.current(this.principal(user)) };
  }

  @Post('deletion/request')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  @ApiOperation({
    summary: 'Ask to delete my account: my password again, then a deletion code to my verified WhatsApp number',
    description:
      'Nothing is deleted here. The request stays open until the code is confirmed, cancelled or expires. ' +
      'Refused with whatsapp_number_required when no verified number exists — no other channel is substituted.',
  })
  start(@CurrentUser() user: AuthUser, @Body() dto: StartDeletionDto, @Req() req: Request) {
    return this.deletion.start(this.principal(user), {
      password: dto.password,
      clientUuid: dto.clientUuid,
      language: dto.language,
      ip: req.ip,
    });
  }

  @Post('deletion/resend')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  @ApiOperation({ summary: 'Send a new deletion code (the previous one stops working)' })
  resend(@CurrentUser() user: AuthUser, @Body() dto: ResendDeletionCodeDto) {
    return this.deletion.resend(this.principal(user), dto.language);
  }

  @Post('deletion/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  @ApiOperation({
    summary: 'Enter the deletion code. On success the account is deleted and every session ends, including this one',
  })
  confirm(@CurrentUser() user: AuthUser, @Body() dto: ConfirmDeletionDto) {
    return this.deletion.confirm(this.principal(user), dto.code);
  }

  @Post('deletion/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw an open deletion request. Safe to repeat.' })
  async cancel(@CurrentUser() user: AuthUser) {
    return { request: await this.deletion.cancel(this.principal(user)) };
  }

  @Post('whatsapp/verify/start')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  @ApiOperation({ summary: 'Prove a WhatsApp number: my password again, then a code to that number' })
  startPhone(@CurrentUser() user: AuthUser, @Body() dto: StartPhoneVerificationDto) {
    return this.account.startPhoneVerification(this.principal(user), dto);
  }

  @Post('whatsapp/verify/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  @ApiOperation({ summary: 'Enter the code: the number becomes my verified WhatsApp number' })
  confirmPhone(@CurrentUser() user: AuthUser, @Body() dto: ConfirmPhoneVerificationDto) {
    return this.account.confirmPhoneVerification(this.principal(user), dto);
  }
}
