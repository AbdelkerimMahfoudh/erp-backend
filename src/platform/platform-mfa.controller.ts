import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { AllowPendingMfa, PlatformAdminGuard, type AdminRequest } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformMfaService } from './platform-mfa.service';

/** Every MFA route is a guess surface: throttled per address, in front of the per-administrator lock. */
const MFA_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

class MfaVerifyDto {
  @IsOptional() @IsString() @Matches(/^\s*\d{3}\s?\d{3}\s*$/) code?: string;
  @IsOptional() @IsString() @MaxLength(32) recoveryCode?: string;
}

class EnrolmentStartDto {
  @IsString() @MinLength(16) @MaxLength(128) enrolmentToken!: string;
}

class CodeDto {
  @IsString() @Matches(/^\s*\d{3}\s?\d{3}\s*$/) code!: string;
}

class StepUpDto {
  @IsString() @MinLength(1) @MaxLength(200) password!: string;
  @IsString() @Matches(/^\s*\d{3}\s?\d{3}\s*$/) code!: string;
}

class RecoveryCodesDto {
  /** Step-up, as every high-impact action: the password, on a session holding a fresh password-and-code step-up. */
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

/**
 * The administrator's second factor (correction phase, 2026-10-12; `platform-mfa.service.ts`).
 *
 * `verify` and the two enrolment routes take a PENDING session — the only routes that do, with sign-out. The
 * step-up and the recovery-code regeneration need a verified one.
 */
@ApiExcludeController()
@Controller({ path: 'platform/admin', version: '1' })
export class PlatformMfaController {
  constructor(
    private readonly mfa: PlatformMfaService,
    private readonly admins: PlatformAdminService,
  ) {}

  @Public()
  @UseGuards(PlatformAdminGuard)
  @AllowPendingMfa()
  @Throttle(MFA_THROTTLE)
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Body() dto: MfaVerifyDto, @Req() req: AdminRequest) {
    await this.mfa.verify(req.platformAdmin!, req.platformSessionId!, { code: dto.code, recoveryCode: dto.recoveryCode }, req.ip ?? null);
    return { verified: true };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @AllowPendingMfa()
  @Throttle(MFA_THROTTLE)
  @Post('mfa/enrolment/start')
  @HttpCode(HttpStatus.OK)
  async startEnrolment(@Body() dto: EnrolmentStartDto, @Req() req: AdminRequest) {
    // The secret goes to this response once — to be scanned or typed into the authenticator — and nowhere else.
    return this.mfa.startEnrolment(req.platformAdmin!, dto.enrolmentToken, req.ip ?? null);
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @AllowPendingMfa()
  @Throttle(MFA_THROTTLE)
  @Post('mfa/enrolment/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmEnrolment(@Body() dto: CodeDto, @Req() req: AdminRequest) {
    // The recovery codes are shown once, here; only their keyed digests are kept.
    return this.mfa.confirmEnrolment(req.platformAdmin!, req.platformSessionId!, dto.code, req.ip ?? null);
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Throttle(MFA_THROTTLE)
  @Post('step-up')
  @HttpCode(HttpStatus.OK)
  async stepUp(@Body() dto: StepUpDto, @Req() req: AdminRequest) {
    const { expiresAt } = await this.mfa.stepUp(req.platformAdmin!, req.platformSessionId!, dto.password, dto.code, req.ip ?? null);
    return { expiresAt: expiresAt.toISOString() };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Throttle(MFA_THROTTLE)
  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  async regenerate(@Body() dto: RecoveryCodesDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    return this.mfa.regenerateRecoveryCodes(admin, req.platformSessionId!, req.ip ?? null);
  }
}
