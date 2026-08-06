import { Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { HashingService } from '../common/security/hashing.service';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { TokensService } from './tokens.service';
import { SessionsService } from './sessions.service';
import { DevicesService, type DeviceEnrollment } from './devices.service';
import { LoginDto } from './dto/login.dto';

export interface AuthTokenResponse {
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: { id: string; name: string; login: string; companyId: string };
  /** Present ONLY when this login enrolled a new device. The secret appears here and nowhere else. */
  device?: DeviceEnrollment;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly hashing: HashingService,
    private readonly tokens: TokensService,
    private readonly sessions: SessionsService,
    private readonly devices: DevicesService,
  ) {}

  async login(dto: LoginDto, meta: { ip?: string; userAgent?: string }): Promise<AuthTokenResponse> {
    const user = await this.users.findByLoginForAuth(dto.login);
    // Verify against a found+active user; generic failure prevents enumeration.
    const ok = user && user.isActive && (await this.hashing.verify(user.passwordHash, dto.password));
    if (!user || !ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const secret = this.tokens.generateRefreshSecret();
    const sessionId = await this.sessions.create({
      companyId: user.companyId,
      userId: user.id,
      secret,
      device: dto.device,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await this.users.setLastLogin(user.id);

    /*
     * Device identity (F1 Stage 3).
     *
     * A returning installation presents the pair it was issued; we recognise it
     * and bind this session to the same device. An installation with no
     * credential — a first sign-in, a reinstall, or a different phone — enrolls
     * and receives a secret exactly once.
     *
     * The trust method is recorded as `password`, honestly: a password was
     * verified, a phone was not. When the OTP provider exists, Stage 4 gates
     * this branch instead of enrolling straight away.
     */
    let enrollment: DeviceEnrollment | undefined;
    const presented = dto.deviceCredential;
    if (presented?.deviceId && presented.deviceSecret) {
      const known = await this.devices.recognise(user.id, presented.deviceId, presented.deviceSecret);
      if (known) {
        await this.devices.attach(sessionId, known.id);
      } else {
        // A wrong, unknown or revoked credential is NOT a login failure — the
        // password was right. It is simply an unrecognised installation, so it
        // enrolls as a new device and the old one keeps its revoked history.
        enrollment = await this.devices.enroll({
          companyId: user.companyId,
          userId: user.id,
          sessionId,
          trustMethod: 'password',
          meta: presented,
        });
      }
    } else if (presented) {
      enrollment = await this.devices.enroll({
        companyId: user.companyId,
        userId: user.id,
        sessionId,
        trustMethod: 'password',
        meta: presented,
      });
    }

    return { ...this.buildResponse(user, sessionId, secret), device: enrollment };
  }

  async refresh(refreshToken: string): Promise<AuthTokenResponse> {
    const parsed = this.tokens.parseRefreshToken(refreshToken);
    if (!parsed) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    let sessionId: Buffer;
    try {
      sessionId = uuidToBin(parsed.sessionId);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const newSecret = this.tokens.generateRefreshSecret();
    const rotated = await this.sessions.rotate(sessionId, parsed.secret, newSecret);
    if (!rotated) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const user = await this.users.findById(rotated.userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildResponse(user, sessionId, newSecret);
  }

  /**
   * An **explicit** logout. This is the one gesture that costs the device its
   * standing trust: the next sign-in here should re-verify by OTP even though
   * it is the same phone.
   *
   * Closing the app, backgrounding it, losing the network or restoring a
   * session on launch never reach this method, and so never change device
   * trust — which is exactly the approved rule.
   *
   * Stage 3 records the requirement; Stage 4 enforces it.
   */
  async logout(userId: Buffer, refreshToken: string): Promise<{ success: true }> {
    const parsed = this.tokens.parseRefreshToken(refreshToken);
    if (parsed) {
      try {
        const sessionId = uuidToBin(parsed.sessionId);
        const deviceId = await this.sessions.deviceOf(sessionId, userId);
        await this.sessions.revoke(userId, sessionId);
        if (deviceId) await this.devices.markReverifyRequired(deviceId);
      } catch {
        /* malformed session id → nothing to revoke */
      }
    }
    return { success: true };
  }

  async logoutAll(userId: Buffer): Promise<{ revoked: number }> {
    return { revoked: await this.sessions.revokeAll(userId) };
  }

  private buildResponse(user: User, sessionId: Buffer, secret: string): AuthTokenResponse {
    const access = this.tokens.signAccessToken(
      binToUuid(user.id),
      binToUuid(user.companyId),
      binToUuid(sessionId),
    );
    return {
      tokenType: 'Bearer',
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: this.tokens.buildRefreshToken(binToUuid(sessionId), secret),
      user: {
        id: binToUuid(user.id),
        name: user.name,
        login: user.login,
        companyId: binToUuid(user.companyId),
      },
    };
  }
}
