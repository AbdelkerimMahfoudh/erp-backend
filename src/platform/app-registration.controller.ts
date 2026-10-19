import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { registrationThrottle } from './platform.controller';
import { RegistrationFlowService } from './registration-flow.service';
import { ContinueConfirmDto, ContinueStartDto, RegisterDto } from './registration.dto';

/**
 * Creating a business account in the app (0095, the owner's decision Q1 of 2026-10-13, reversing D117).
 *
 * The same three steps as the website's `platform/register*` — register, send the code, prove it — under `auth/`,
 * because the app never calls a `/platform/` route (its boundary test bans them). Nothing is duplicated: both doors
 * hand their bodies to {@link RegistrationFlowService}, so the refusal before anything is saved
 * (`registration_unavailable`), the continuation, the Owner session at the end and the free trial eligibility are the
 * same by construction. The business is eligible for one free trial and it is NOT started: starting it is the Owner's
 * explicit act on the Dukan ERP website, and no route the app calls can do it.
 *
 * Public — they run before any account exists — and throttled with the website's own limit, in the same budget: one per
 * step and per address, whichever door is used (`registrationThrottle`).
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AppRegistrationController {
  constructor(private readonly flow: RegistrationFlowService) {}

  @Public()
  @Throttle(registrationThrottle('register'))
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a business account: the business, its first store, its Owner — pending, and nothing started' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.flow.register(dto, { source: 'mobile_registration', ip: req.ip });
  }

  @Public()
  @Throttle(registrationThrottle('verify-start'))
  @Post('register/verify/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send the code that finishes this registration, to the contact the Owner gave' })
  continueStart(@Body() dto: ContinueStartDto) {
    return this.flow.startVerification(dto);
  }

  @Public()
  @Throttle(registrationThrottle('verify-confirm'))
  @Post('register/verify/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Prove the code and receive an ordinary Owner session' })
  continueConfirm(@Body() dto: ContinueConfirmDto, @Req() req: Request) {
    return this.flow.confirmVerification(dto, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }
}
