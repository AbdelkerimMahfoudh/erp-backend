import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { isUuid, uuidToBin } from '../common/utils/uuid.util';
import { PlatformAdminGuard, type AdminRequest } from '../platform/platform-admin.guard';
import { PlatformAdminService } from '../platform/platform-admin.service';
import { PUBLIC_THROTTLE } from '../platform/platform.controller';
import { AcquisitionService } from './acquisition.service';
import { PromoterService } from './promoter.service';
import { ReferralInvitationService } from './referral-invitation.service';
import { REFERRAL_TOKEN_LENGTH } from './referral-token';

/**
 * The routes of promoter attribution and user invitations (0103, D221).
 *
 *  - **public lookups**, by both doors — the website's `platform/acquisition/*` and the app's `auth/acquisition/*` (the
 *    app never calls a `/platform/` route) — in one budget per address, so neither door is the cheaper one to guess on.
 *    POST, so a code or a token never sits in a URL or an access log. There is no list and no search: one code or one
 *    link per request, answered usable or not;
 *  - **the platform administrator's** promoters and reports — MFA session, the password-and-step-up confirmation for
 *    every change, every change audited;
 *  - **a signed-in user's** invitation links — their own only.
 */

/** Both doors' lookups, in one budget per address (like `registrationThrottle`). */
export const ACQUISITION_LOOKUP_THROTTLE = {
  default: {
    ...PUBLIC_THROTTLE.default,
    generateKey: (_context: unknown, tracker: string, throttler: string) => `acquisition-lookup-${throttler}-${tracker}`,
  },
};

export class CodeLookupDto {
  /** Six digits — ASCII, Arabic-Indic or Eastern Arabic-Indic; normalised and checked by the service. Never logged. */
  @IsString() @MaxLength(20) code: string;
}

export class LinkLookupDto {
  /** The `r` of a registration link. Never logged. */
  @IsString() @MaxLength(REFERRAL_TOKEN_LENGTH + 8) token: string;
}

class PromoterCreateDto {
  @IsString() @MinLength(1) @MaxLength(80) displayName: string;
  @IsString() @MinLength(6) @MaxLength(24) whatsappNumber: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class PromoterUpdateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) displayName?: string;
  @IsOptional() @IsString() @MinLength(6) @MaxLength(24) whatsappNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class PromoterCodeDto {
  /** True to replace an existing code — the console asks the administrator to confirm that first. */
  @IsOptional() @IsBoolean() regenerate?: boolean;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class ConfirmDto {
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class ListQuery {
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) page?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class ReportQuery {
  @IsOptional() @IsIn(['none', 'promoter', 'user_invite']) source?: 'none' | 'promoter' | 'user_invite';
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsString() inviterCompanyId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) page?: number;
}

class InvitationDto {
  @IsIn(['en', 'fr', 'ar']) language: 'en' | 'fr' | 'ar';
}

/** A day as the console names it, as the instant it starts (UTC); `to` is exclusive of the next day. */
function dayRange(q: { from?: string; to?: string }) {
  const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined;
  const to = q.to ? new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + 86_400_000) : undefined;
  return { from, to };
}

// ── Public lookups ───────────────────────────────────────────────────────────

@ApiExcludeController()
@Controller({ path: 'platform/acquisition', version: '1' })
export class WebsiteAcquisitionController {
  constructor(private readonly acquisition: AcquisitionService) {}

  @Public()
  @Throttle(ACQUISITION_LOOKUP_THROTTLE)
  @Post('code')
  @HttpCode(HttpStatus.OK)
  code(@Body() dto: CodeLookupDto, @Req() req: Request) {
    return this.acquisition.lookupCode(dto.code, req.ip);
  }

  @Public()
  @Throttle(ACQUISITION_LOOKUP_THROTTLE)
  @Post('link')
  @HttpCode(HttpStatus.OK)
  link(@Body() dto: LinkLookupDto, @Req() req: Request) {
    return this.acquisition.lookupLink(dto.token, req.ip);
  }
}

@ApiTags('auth')
@Controller({ path: 'auth/acquisition', version: '1' })
export class AppAcquisitionController {
  constructor(private readonly acquisition: AcquisitionService) {}

  @Public()
  @Throttle(ACQUISITION_LOOKUP_THROTTLE)
  @Post('code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Is this promo code usable? Usable with the promoter’s display name, or unavailable — nothing else' })
  code(@Body() dto: CodeLookupDto, @Req() req: Request) {
    return this.acquisition.lookupCode(dto.code, req.ip);
  }

  @Public()
  @Throttle(ACQUISITION_LOOKUP_THROTTLE)
  @Post('link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'What a registration link prefills: a promoter’s code and name, an invitation, or unavailable' })
  link(@Body() dto: LinkLookupDto, @Req() req: Request) {
    return this.acquisition.lookupLink(dto.token, req.ip);
  }
}

// ── The platform administrator ───────────────────────────────────────────────

@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class PromotersController {
  constructor(
    private readonly promoters: PromoterService,
    private readonly acquisition: AcquisitionService,
    private readonly admins: PlatformAdminService,
  ) {}

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('promoters')
  list(@Query() q: ListQuery) {
    return this.promoters.list({ q: q.q, page: q.page });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('promoters')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: PromoterCreateDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    return this.promoters.create({ displayName: dto.displayName, whatsappNumber: dto.whatsappNumber, note: dto.note }, { admin, ip: req.ip });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('promoters/:id')
  detail(@Param('id') id: string) {
    return this.promoters.detail(id);
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Patch('promoters/:id')
  async update(@Param('id') id: string, @Body() dto: PromoterUpdateDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    return this.promoters.update(id, { displayName: dto.displayName, whatsappNumber: dto.whatsappNumber, note: dto.note }, { admin, ip: req.ip });
  }

  /** "Generate code and QR" — or, with `regenerate`, replace them. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('promoters/:id/code')
  @HttpCode(HttpStatus.OK)
  async code(@Param('id') id: string, @Body() dto: PromoterCodeDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    return this.promoters.issueCode(id, { regenerate: dto.regenerate === true }, { admin, ip: req.ip });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('promoters/:id/activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Param('id') id: string, @Body() dto: ConfirmDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    return this.promoters.setActive(id, true, { admin, ip: req.ip });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('promoters/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  async deactivate(@Param('id') id: string, @Body() dto: ConfirmDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    return this.promoters.setActive(id, false, { admin, ip: req.ip });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('promoters/:id/businesses')
  businesses(@Param('id') id: string, @Query() q: ListQuery) {
    return this.promoters.businesses(id, q.page);
  }

  /** Self-registered businesses by source: none, a promoter or an invitation. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('acquisitions')
  report(@Query() q: ReportQuery) {
    return this.acquisition.report({
      source: q.source,
      ...dayRange(q),
      inviterCompanyId: q.inviterCompanyId && isUuid(q.inviterCompanyId) ? uuidToBin(q.inviterCompanyId) : undefined,
      page: q.page,
    });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('acquisitions/summary')
  summary(@Query() q: ReportQuery) {
    return this.acquisition.summary(dayRange(q));
  }
}

// ── A signed-in user's invitation links ──────────────────────────────────────

@ApiTags('referral-invitations')
@ApiBearerAuth()
@Controller({ path: 'referral-invitations', version: '1' })
export class ReferralInvitationsController {
  constructor(private readonly invitations: ReferralInvitationService) {}

  @Get()
  @ApiOperation({ summary: 'My invitation links to Dukan ERP, one per language at most' })
  mine(@CurrentUser() user: AuthUser) {
    return this.invitations.mine(principal(user));
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'My invitation link in this language: the existing one, or a new one' })
  create(@CurrentUser() user: AuthUser, @Body() dto: InvitationDto) {
    return this.invitations.createOrGet(principal(user), dto.language);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop one of my invitation links: it opens nothing from now on' })
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.invitations.revoke(principal(user), id);
  }
}

function principal(user: AuthUser) {
  return { companyId: uuidToBin(user.companyId), userId: uuidToBin(user.userId) };
}
