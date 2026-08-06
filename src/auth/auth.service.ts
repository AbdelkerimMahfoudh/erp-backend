import { Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { HashingService } from '../common/security/hashing.service';
import { PrismaService } from '../prisma/prisma.service';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { normalizeStoreCode } from '../common/utils/store-code.util';
import { TokensService } from './tokens.service';
import { SessionsService } from './sessions.service';
import { DevicesService, type DeviceEnrollment } from './devices.service';
import { LoginDto } from './dto/login.dto';

export interface AuthTokenResponse {
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: { id: string; name: string; login: string; companyId: string; publicStoreId: string };
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
    private readonly prisma: PrismaService,
  ) {}

  async login(dto: LoginDto, meta: { ip?: string; userAgent?: string }): Promise<AuthTokenResponse> {
    /*
     * Tenant resolution (F1 Stage 3.2). The client names its company by the
     * PUBLIC Store Account ID — never a binary company id it could forge. We
     * resolve the company, then find the user WITHIN it, so the same login can
     * exist in two companies without collision and a Store-ID-A + login-from-B
     * pairing simply fails.
     *
     * Non-enumerating + timing-safe: a bad Store ID, a bad login and a bad
     * password all produce the SAME generic failure, and every path spends one
     * Argon2 verify so "no such company/user" cannot be told apart from "wrong
     * password" by timing.
     */
    const storeCode = normalizeStoreCode(dto.storeAccountId);
    const company = storeCode
      ? await this.prisma.company.findUnique({
          where: { publicStoreId: storeCode },
          select: { id: true, isActive: true, publicStoreId: true },
        })
      : null;
    const user =
      company && company.isActive ? await this.users.findByLoginForAuth(company.id, dto.login) : null;

    const passwordOk = user
      ? await this.hashing.verify(user.passwordHash, dto.password)
      : await this.hashing.verifyDummy(dto.password);

    if (!user || !user.isActive || !passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    /*
     * Device identity (F1 Stage 3 / 3.1).
     *
     * The recognition decision is made BEFORE a session exists, so a rejected
     * credential claim leaves nothing behind — no session, no device, no token,
     * no `lastLogin` bump. Five cases, kept structurally distinct:
     *
     *   A. No credential at all → a genuinely new or locally reset install.
     *      Enroll on the password-era path, trust recorded honestly as
     *      `password` (a password was verified; a phone was not — distinct from
     *      `otp`).
     *   B. A valid, complete pair for this user → recognise and attach.
     *   C. Known id, WRONG secret  ┐
     *   D. Unknown id with a secret ├─ a failed/invalid/stale CLAIM. Fail CLOSED:
     *   E. Revoked id + credential  ┘  no new device, no rotation, no secret, no
     *      authorization — a controlled error. Enrolling here would mint a
     *      trusted device from a bad claim and let repeated claims create
     *      unlimited device rows. When OTP exists (Stage 4), this is exactly
     *      where a verification challenge is issued instead of a hard refusal.
     *
     * A partially-supplied pair (id without secret, or secret without id) is a
     * claim too, and fails closed the same way.
     */
    const presented = dto.deviceCredential;
    const claimsCredential = Boolean(presented?.deviceId || presented?.deviceSecret);
    let recognisedDeviceId: Buffer | null = null;

    if (claimsCredential) {
      const known =
        presented!.deviceId && presented!.deviceSecret
          ? await this.devices.recognise(user.id, presented!.deviceId, presented!.deviceSecret)
          : null;
      if (!known) {
        // Fail closed. The message names no id and echoes no secret, so the
        // failure cannot enumerate whether a device id exists or leak the claim.
        throw new UnauthorizedException({
          code: 'device_unrecognized',
          message:
            'This device could not be verified. Clear the saved device and sign in again to enroll it fresh.',
        });
      }
      recognisedDeviceId = known.id;
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

    let enrollment: DeviceEnrollment | undefined;
    if (recognisedDeviceId) {
      await this.devices.attach(sessionId, recognisedDeviceId);
    } else if (presented) {
      enrollment = await this.devices.enroll({
        companyId: user.companyId,
        userId: user.id,
        sessionId,
        trustMethod: 'password',
        meta: presented,
      });
    }

    // `company` is guaranteed here: `user` is set only when the company resolved
    // and was active, and we would have thrown otherwise.
    return { ...this.buildResponse(user, sessionId, secret, company!.publicStoreId), device: enrollment };
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

    const company = await this.prisma.company.findUnique({
      where: { id: user.companyId },
      select: { publicStoreId: true },
    });
    if (!company) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildResponse(user, sessionId, newSecret, company.publicStoreId);
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

  private buildResponse(
    user: User,
    sessionId: Buffer,
    secret: string,
    publicStoreId: string,
  ): AuthTokenResponse {
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
        // The public Store Account ID the client namespaces its device
        // credential by (Stage 3.2). Not a secret.
        publicStoreId,
      },
    };
  }
}
