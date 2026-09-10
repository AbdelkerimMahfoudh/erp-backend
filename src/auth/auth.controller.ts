import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BranchId } from '../common/decorators/branch-id.decorator';
import { AuthUser } from '../common/types/auth-user';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { UsersService } from '../users/users.service';
import { AccessService } from '../rbac/access.service';
import { AuthService } from './auth.service';
import { ChooseAccountDto, LoginDto } from './dto/login.dto';
import { LogoutDto, RefreshDto } from './dto/token.dto';

/**
 * Stricter rate limit on auth endpoints (brute-force defense).
 *
 * Read from the environment, because `AUTH_THROTTLE_LIMIT` was validated by
 * Joi, exposed on `AppConfigService` and consumed by nothing — an operator
 * tightening it after a credential-stuffing attempt would have changed
 * nothing, and no test or log would have said so. Dead configuration is worse
 * than none: it looks like a control.
 *
 * `process.env` directly rather than the config service, which the project
 * otherwise requires: a decorator is evaluated when this module is loaded, and
 * nothing is injected yet. The Joi schema still validates the value, and the
 * fallback matches the schema's own default so a missing variable behaves
 * exactly as before.
 */
const AUTH_THROTTLE_LIMIT = Number(process.env.AUTH_THROTTLE_LIMIT) || 10;
const AUTH_THROTTLE = { default: { limit: AUTH_THROTTLE_LIMIT, ttl: 60_000 } };

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly access: AccessService,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with a phone number or personal ID. No Store ID.' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  /**
   * Continue as one of the shops the password already matched (CP3).
   *
   * Reachable only with a continuation token, which is issued solely from a
   * verified credential — so this route grants nothing that the password
   * check had not already established. Rate-limited like every other
   * unauthenticated auth route.
   */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('choose-account')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pick which shop to sign in to, after the password matched' })
  chooseAccount(@Body() dto: ChooseAccountDto, @Req() req: Request) {
    return this.auth.chooseAccount(dto.continuationToken, dto.accountRef, dto as never, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token for new access + refresh tokens' })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the current session (refresh token)' })
  logout(@CurrentUser() user: AuthUser, @Body() dto: LogoutDto) {
    return this.auth.logout(uuidToBin(user.userId), dto.refreshToken);
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke all sessions for the current user' })
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.logoutAll(uuidToBin(user.userId));
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user' })
  async me(@CurrentUser() user: AuthUser) {
    const found = await this.users.findByIdWithStore(uuidToBin(user.userId));
    if (!found) {
      throw new UnauthorizedException();
    }
    return {
      id: binToUuid(found.id),
      name: found.name,
      login: found.login,
      // Shown in Settings so somebody can find their own sign-in identifier
      // without contacting support (CP3). Not a secret, and not a password.
      personalId: found.personalId,
      companyId: binToUuid(found.companyId),
      // Lets a RESTORED session namespace its device credential without a
      // re-login (Stage 3.2). Not a secret.
      publicStoreId: found.company.publicStoreId,
      isActive: found.isActive,
    };
  }

  @ApiBearerAuth()
  @Get('branches')
  @ApiOperation({ summary: 'Branches the current user is assigned to (for branch selection)' })
  branches(@CurrentUser() user: AuthUser) {
    return this.access.getUserBranches(uuidToBin(user.userId));
  }

  @ApiBearerAuth()
  @Get('permissions')
  @ApiOperation({
    summary: 'Effective permissions for the current user (scoped to X-Branch-Id if provided)',
  })
  async permissions(@CurrentUser() user: AuthUser, @BranchId() branchId?: string) {
    const perms = await this.access.getEffectivePermissions(
      uuidToBin(user.userId),
      branchId ? uuidToBin(branchId) : undefined,
    );
    return { branchId: branchId ?? null, permissions: [...perms].sort() };
  }
}

