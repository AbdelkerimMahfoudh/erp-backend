import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard, type AdminRequest } from './platform-admin.guard';
import { AccountProvisioningService, type ProvisioningActor, type StaffRoleKey, type VerificationPolicy } from './account-provisioning.service';

/** The deferral's own fields: the reason, the confirmation, an optional review date. */
export class DeferralDto {
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
  /** The administrator confirms, in this request, that the number stays unverified. */
  @IsBoolean() @Equals(true) confirmUnverified: boolean;
  @IsOptional() @IsISO8601() reviewAt?: string;
}

class ProvisionStaffDto {
  @IsString() @MinLength(1) @MaxLength(160) name: string;
  @IsString() @MinLength(4) @MaxLength(24) phone: string;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsIn(['store_manager', 'store_employee']) role: StaffRoleKey;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) branchIds: string[];
  @IsIn(['required', 'deferred_by_platform']) verification: VerificationPolicy;
  @IsOptional() @ValidateNested() @Type(() => DeferralDto) deferral?: DeferralDto;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class ReasonDto {
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class DeferralUpdateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) reason?: string;
  @IsOptional() @IsISO8601() reviewAt?: string;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class ConfirmDto {
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

/**
 * The console's account provisioning (D224, docs/109): staff for a business, and the deferred-verification lifecycle,
 * per account. Platform routes only — the app's boundary test bans `/platform/`, and no tenant guard reaches them. Every
 * mutation is behind a password confirmation and a fresh step-up (`confirmPassword`); a deferral checks every
 * condition again in {@link AccountProvisioningService.assertMayDefer}.
 */
@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class AccountProvisioningController {
  constructor(
    private readonly admins: PlatformAdminService,
    private readonly provisioning: AccountProvisioningService,
  ) {}

  private actor(req: AdminRequest): ProvisioningActor {
    return { admin: req.platformAdmin!, sessionId: req.platformSessionId, ip: req.ip ?? null };
  }

  /** What the console may offer: the kill switch's state. Nothing else. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('capabilities')
  capabilities() {
    return { phoneVerificationDeferral: this.provisioning.deferralAvailable };
  }

  /** Every deferred account on the platform, or one business's. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('phone-verification/deferred')
  async deferred(@Query('businessId') businessId?: string) {
    return { accounts: await this.provisioning.listDeferred(businessId || undefined) };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/provisioned-staff')
  @HttpCode(HttpStatus.CREATED)
  async createStaff(@Param('id') id: string, @Body() dto: ProvisionStaffDto, @Req() req: AdminRequest) {
    await this.admins.confirmPassword(req.platformAdmin!.id, dto.confirmPassword);
    return this.provisioning.createStaff(id, dto, this.actor(req));
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/accounts/:userId/require-verification')
  @HttpCode(HttpStatus.OK)
  async requireVerification(@Param('id') id: string, @Param('userId') userId: string, @Body() dto: ReasonDto, @Req() req: AdminRequest) {
    await this.admins.confirmPassword(req.platformAdmin!.id, dto.confirmPassword);
    return this.provisioning.requireVerification(id, userId, dto.reason, this.actor(req));
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/accounts/:userId/deferral')
  @HttpCode(HttpStatus.OK)
  async updateDeferral(@Param('id') id: string, @Param('userId') userId: string, @Body() dto: DeferralUpdateDto, @Req() req: AdminRequest) {
    await this.admins.confirmPassword(req.platformAdmin!.id, dto.confirmPassword);
    return this.provisioning.updateDeferral(id, userId, { reason: dto.reason, reviewAt: dto.reviewAt }, this.actor(req));
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/accounts/:userId/setup-code')
  @HttpCode(HttpStatus.OK)
  async reissueCode(@Param('id') id: string, @Param('userId') userId: string, @Body() dto: ConfirmDto, @Req() req: AdminRequest) {
    await this.admins.confirmPassword(req.platformAdmin!.id, dto.confirmPassword);
    return this.provisioning.reissueCode(id, userId, this.actor(req));
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/accounts/:userId/setup-code/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeCode(@Param('id') id: string, @Param('userId') userId: string, @Body() dto: ConfirmDto, @Req() req: AdminRequest) {
    await this.admins.confirmPassword(req.platformAdmin!.id, dto.confirmPassword);
    return this.provisioning.revokeCode(id, userId, this.actor(req));
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/accounts/:userId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id') id: string, @Param('userId') userId: string, @Body() dto: ReasonDto, @Req() req: AdminRequest) {
    await this.admins.confirmPassword(req.platformAdmin!.id, dto.confirmPassword);
    return this.provisioning.cancelAccount(id, userId, dto.reason, this.actor(req));
  }
}
