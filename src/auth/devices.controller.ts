import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser } from '../common/types/auth-user';
import { AuditService } from '../common/audit/audit.service';
import { uuidToBin } from '../common/utils/uuid.util';
import { DevicesService } from './devices.service';
import { SessionsService } from './sessions.service';
import { DeviceMetaDto } from './dto/device.dto';

/**
 * Devices a user has signed in from (F1 Stage 3).
 *
 * Everything here is scoped by the authenticated user, and the Owner routes are
 * additionally guarded by `user.manage` and a company check. A device secret is
 * **never** returned by any of these routes — the only response that ever
 * carries one is the enrollment that created it.
 *
 * Revoked devices stay listed. A security history that vanishes when someone
 * revokes a stolen phone is not a security history.
 */
@ApiTags('devices')
@ApiBearerAuth()
@Controller({ path: 'devices', version: '1' })
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The device this session belongs to, so the UI can mark "this device"
   * without the client telling us which one it is. Null for a pre-Stage-3
   * session that has not adopted a device yet.
   */
  private currentDevice(user: AuthUser): Promise<Buffer | null> {
    return this.sessions.deviceOf(uuidToBin(user.sessionId), uuidToBin(user.userId));
  }

  @Get()
  @ApiOperation({ summary: "The signed-in user's devices, current one flagged. Never returns secrets." })
  async list(@CurrentUser() user: AuthUser) {
    const current = await this.currentDevice(user);
    return this.devices.listForUser(uuidToBin(user.userId), current);
  }

  /**
   * Adopt a device for a session that predates Stage 3.
   *
   * Idempotent and single-shot: a session that already has a device gets its id
   * back rather than a second enrollment, so a retry or two racing app launches
   * cannot duplicate or rebind. The trust method is recorded as `legacy` —
   * these sessions were already valid, but nothing about them was OTP-verified.
   */
  @Post('adopt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bind an existing pre-Stage-3 session to a legacy-trusted device' })
  async adopt(@CurrentUser() user: AuthUser, @Body() meta: DeviceMetaDto) {
    const result = await this.devices.adoptLegacy(
      uuidToBin(user.companyId),
      uuidToBin(user.userId),
      uuidToBin(user.sessionId),
      meta,
    );
    if (!('alreadyBound' in result)) {
      await this.audit.record({
        entityType: 'UserDevice',
        entityId: uuidToBin(result.deviceId),
        action: 'create',
        after: { trustMethod: result.trustMethod, adopted: true },
        reason: 'Legacy session adopted a device (no OTP; trust is legacy)',
      });
    }
    return result;
  }

  @Delete(':deviceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke one of your own devices',
    description: 'Revokes every session that device owns. Revoking the current device ends this session.',
  })
  async revokeOwn(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
  ) {
    const current = await this.currentDevice(user);
    const result = await this.devices.revoke({
      companyId: uuidToBin(user.companyId),
      ownerUserId: uuidToBin(user.userId),
      targetUserId: uuidToBin(user.userId),
      deviceIdStr: deviceId,
    });
    const wasCurrent = current !== null && current.equals(uuidToBin(deviceId));
    if (!result.alreadyRevoked) {
      await this.audit.record({
        entityType: 'UserDevice',
        entityId: uuidToBin(deviceId),
        action: 'status_change',
        after: { revoked: true, sessionsRevoked: result.sessionsRevoked, self: true },
        reason: wasCurrent ? 'Revoked the current device' : 'Revoked another of their devices',
      });
    }
    return { ...result, wasCurrent };
  }

  /* ----------------------------- Owner routes ----------------------------- */

  @Get('users/:userId')
  @RequirePermissions('user.manage')
  @ApiOperation({ summary: "Owner: list a company member's devices" })
  async listForUser(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
  ) {
    const current = await this.currentDevice(user);
    return this.devices.listForCompanyUser(uuidToBin(user.companyId), userId, current);
  }

  @Delete('users/:userId/:deviceId')
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Owner: revoke a company member's device and all its sessions" })
  async revokeForUser(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const companyId = uuidToBin(user.companyId);
    const targetUserId = await this.devices.resolveCompanyUser(companyId, userId);
    const result = await this.devices.revoke({
      companyId,
      ownerUserId: uuidToBin(user.userId),
      targetUserId,
      deviceIdStr: deviceId,
    });
    if (!result.alreadyRevoked) {
      await this.audit.record({
        entityType: 'UserDevice',
        entityId: uuidToBin(deviceId),
        action: 'status_change',
        after: {
          revoked: true,
          sessionsRevoked: result.sessionsRevoked,
          targetUserId: userId,
        },
        reason: "Owner revoked a team member's device",
      });
    }
    return result;
  }
}
