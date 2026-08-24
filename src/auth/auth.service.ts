import { Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { HashingService } from '../common/security/hashing.service';
import { PrismaService } from '../prisma/prisma.service';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { normalizeStoreCode } from '../common/utils/store-code.util';
import { classifyIdentifier } from './identifier';
import { TokensService } from './tokens.service';
import { SessionsService } from './sessions.service';
import { DevicesService, type DeviceEnrollment } from './devices.service';
import { LoginDto } from './dto/login.dto';

export interface AuthTokenResponse {
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: {
    id: string;
    name: string;
    login: string;
    /** How this person signs in when they have no phone. Shown in Settings. */
    personalId: string;
    companyId: string;
    publicStoreId: string;
  };
  /** Present ONLY when this login enrolled a new device. The secret appears here and nowhere else. */
  device?: DeviceEnrollment;
}

/**
 * The same phone, the same password, more than one shop (CP3).
 *
 * Returned INSTEAD of tokens, and only ever after the password has been
 * verified — the shop names in here are the thing that must not leak, so
 * nothing reaches this shape until the credential is proven.
 */
export interface AccountChoiceResponse {
  status: 'choose_account';
  /**
   * Short-lived and purpose-bound. It authorises exactly one thing: naming
   * which of these accounts to continue as. It is not an access token and
   * cannot be used as one.
   */
  continuationToken: string;
  expiresIn: number;
  accounts: { accountRef: string; companyName: string; userName: string }[];
}

export type LoginResult = AuthTokenResponse | AccountChoiceResponse;

/** How long somebody has to pick a shop before starting again. */
export const ACCOUNT_CHOICE_TTL_SECONDS = 120;

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

  async login(dto: LoginDto, meta: { ip?: string; userAgent?: string }): Promise<LoginResult> {
    /*
     * Tenant resolution from the CREDENTIAL, not from the client (CP3).
     *
     * The caller no longer names a company. They type one identifier — their
     * phone or their personal ID — and the server works out who that is and
     * which company they belong to. Nothing about the tenant is trusted from
     * an unauthenticated request, which is strictly stronger than the old
     * arrangement where a Store ID selected the company before any credential
     * had been checked.
     *
     * Non-enumerating and timing-even: an unrecognised identifier, a real one
     * with the wrong password, and a disabled account all produce the SAME
     * generic failure, and every path spends at least one Argon2 verify so
     * "no such person" cannot be told from "wrong password" by timing.
     */
    const identifier = classifyIdentifier(dto.identifier);

    const candidates =
      identifier.kind === 'unrecognised' || identifier.value === null
        ? []
        : await this.users.findCandidatesForAuth(identifier.kind, identifier.value);

    /*
     * A phone is unique only within a company, so the same number may belong
     * to a person at two shops. Each candidate is checked, and the password
     * decides — no company name is read, let alone returned, before one has
     * matched.
     */
    const matches: typeof candidates = [];
    for (const candidate of candidates) {
      if (await this.hashing.verify(candidate.passwordHash, dto.password)) {
        matches.push(candidate);
      }
    }

    // Always spend one verify when there was nothing to check against.
    if (candidates.length === 0) await this.hashing.verifyDummy(dto.password);

    if (matches.length === 0) {
      throw new UnauthorizedException('Invalid credentials');
    }

    /*
     * More than one shop matched the same phone AND the same password.
     * Genuinely ambiguous, and only now — after the credential is proven — may
     * the shops be named. The alternative the brief rules out is asking for a
     * Store ID up front, which would put the burden back on the shopkeeper.
     */
    if (matches.length > 1) {
      return this.accountChoice(matches);
    }

    const user = matches[0];
    return this.completeLogin(user, dto, meta);
  }

  /**
   * Everything after the credential is proven (CP3).
   *
   * Shared by the direct path and the account chooser, so device recognition,
   * session creation and the response shape have exactly one implementation.
   * Two copies of this would drift, and the half that drifted would be the
   * one handling the rarer multi-shop case — the one nobody exercises.
   */
  private async completeLogin(
    // The whole row:  and the device path both read fields
    // beyond the few the credential check needed.
    user: User,
    dto: LoginDto,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthTokenResponse> {
    const company = await this.prisma.company.findUnique({
      where: { id: user.companyId },
      select: { id: true, isActive: true, publicStoreId: true },
    });

    // A dormant company is refused with the same generic message: whether a
    // business exists is not something an unauthenticated caller may learn.
    if (!company || !company.isActive) {
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
        personalId: user.personalId,
        companyId: binToUuid(user.companyId),
        // The public Store Account ID the client namespaces its device
        // credential by (Stage 3.2). Not a secret.
        publicStoreId,
      },
    };
  }

  /**
   * Offer the shops whose credential just matched.
   *
   * Reached only from a verified password. The continuation token carries the
   * matched user ids and nothing else, expires in two minutes, and is bound to
   * this purpose — it cannot be presented as an access token, and it cannot be
   * used to reach any account other than the ones already proven.
   *
   * `accountRef` is an opaque index rather than a user id: the client needs to
   * say "the second one", not to learn anybody's internal identifier.
   */
  private async accountChoice(matches: { id: Buffer; name: string; companyId: Buffer }[]): Promise<AccountChoiceResponse> {
    const companies = await this.prisma.company.findMany({
      where: { id: { in: matches.map((m) => m.companyId) }, isActive: true },
      select: { id: true, name: true },
    });
    const nameOf = new Map(companies.map((c) => [c.id.toString('hex'), c.name]));

    // A company that has since been deactivated is dropped rather than named.
    const usable = matches.filter((m) => nameOf.has(m.companyId.toString('hex')));
    if (usable.length === 0) throw new UnauthorizedException('Invalid credentials');

    const continuationToken = this.tokens.signContinuation(
      usable.map((m) => binToUuid(m.id)),
      ACCOUNT_CHOICE_TTL_SECONDS,
    );

    return {
      status: 'choose_account',
      continuationToken,
      expiresIn: ACCOUNT_CHOICE_TTL_SECONDS,
      accounts: usable.map((m, index) => ({
        accountRef: String(index),
        companyName: nameOf.get(m.companyId.toString('hex'))!,
        userName: m.name,
      })),
    };
  }

  /**
   * Continue as one of the accounts the password already matched.
   *
   * The token is the authority here: it was issued from a verified credential,
   * so this step re-proves nothing and grants nothing beyond what that
   * verification already established. An index outside the token's own list is
   * refused — the client may only choose from what it was offered.
   */
  async chooseAccount(
    continuationToken: string,
    accountRef: string,
    dto: LoginDto,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthTokenResponse> {
    const userIds = this.tokens.verifyContinuation(continuationToken);
    if (!userIds) throw new UnauthorizedException('That sign-in attempt expired. Please start again.');

    const index = Number(accountRef);
    if (!Number.isInteger(index) || index < 0 || index >= userIds.length) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const user = await this.users.findById(uuidToBin(userIds[index]));
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');

    return this.completeLogin(user, dto, meta);
  }
}
