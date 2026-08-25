import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { normaliseEmail } from '../auth/identifier';

/**
 * Who administers the PLATFORM.
 *
 * This is a second, separate identity realm and it is separate on purpose.
 *
 * The alternative — a `RoleKey` on `users` — was rejected because a tenant role
 * lives *inside* a company. A shop with the ability to create roles would then
 * have a path, however indirect, to minting a platform administrator. There is
 * no such path here: `platform_admins` has no `company_id` at all, so there is
 * nothing for a tenant to attach to.
 *
 * Sessions are separate too, for the same kind of reason. A shared session
 * table would mean one bug in tenant session lookup could return a platform
 * session, and that is not a risk worth taking to save a table.
 */

/** Access tokens are short. An administrator can hold real power; 15 minutes of it. */
export const ADMIN_ACCESS_TTL_SECONDS = 15 * 60;
/** The refresh token, and therefore the session, lasts a working day. */
export const ADMIN_SESSION_TTL_HOURS = 12;

export interface PlatformAdminIdentity {
  id: Buffer;
  email: string;
  name: string;
}

export interface AdminSessionResult {
  admin: { id: string; email: string; name: string };
  /** Returned once, set as an HttpOnly cookie by the controller. Never stored. */
  sessionToken: string;
  expiresAt: Date;
}

@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  /** Session tokens are opaque and random. Only their hash is ever stored. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Sign in.
   *
   * Non-enumerating and timing-even, exactly like the tenant login: an unknown
   * address, a wrong password and a disabled account all produce the same
   * refusal, and every path spends one Argon2 verify so "no such administrator"
   * cannot be told from "wrong password" by how long the answer takes.
   */
  async signIn(
    emailRaw: string,
    password: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AdminSessionResult> {
    const email = normaliseEmail(emailRaw);

    const admin = await this.prisma.platformAdmin.findFirst({
      where: { email, isActive: true, deletedAt: null },
    });

    const ok = admin
      ? await this.hashing.verify(admin.passwordHash, password)
      : await this.hashing.verifyDummy(password);

    if (!ok || !admin) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const token = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000);

    await this.prisma.platformAdminSession.create({
      data: {
        id: newUuidV7Bin(),
        adminId: admin.id,
        refreshTokenHash: this.hashToken(token),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        expiresAt,
      },
    });

    await this.prisma.platformAdmin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      admin: { id: admin.id.toString('hex'), email: admin.email, name: admin.name },
      sessionToken: token,
      expiresAt,
    };
  }

  /**
   * Resolve a session token to an administrator, or null.
   *
   * Checks the admin is still active on every request rather than trusting what
   * was true at sign-in: disabling an administrator has to take effect now, not
   * whenever their session happens to expire.
   */
  async resolve(token: string | undefined): Promise<PlatformAdminIdentity | null> {
    if (!token) return null;

    const session = await this.prisma.platformAdminSession.findFirst({
      where: {
        refreshTokenHash: this.hashToken(token),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { admin: true },
    });

    if (!session || !session.admin.isActive || session.admin.deletedAt) return null;

    return {
      id: session.admin.id,
      email: session.admin.email,
      name: session.admin.name,
    };
  }

  async signOut(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.platformAdminSession.updateMany({
      where: { refreshTokenHash: this.hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Cut every session for one administrator — the revocation the brief requires. */
  async revokeAllFor(adminId: Buffer): Promise<number> {
    const res = await this.prisma.platformAdminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }

  /**
   * Step-up confirmation for anything high-impact.
   *
   * Suspending a business or moving an expiry date is not an action a warm
   * session should be enough for — an administrator's laptop left open is the
   * ordinary case, not the exotic one. The password is re-typed and verified
   * against the acting administrator, and nothing about it is stored or logged.
   */
  async confirmPassword(adminId: Buffer, password: string | undefined): Promise<void> {
    if (!password) {
      throw new ForbiddenException({
        code: 'password_confirmation_required',
        message: 'Confirm your password to complete this action.',
      });
    }

    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: adminId },
      select: { passwordHash: true },
    });

    const ok = admin
      ? await this.hashing.verify(admin.passwordHash, password)
      : await this.hashing.verifyDummy(password);

    if (!ok) {
      throw new ForbiddenException({
        code: 'password_confirmation_failed',
        message: 'That password did not match.',
      });
    }
  }

  /**
   * Create an administrator. **Not reachable from any HTTP route.**
   *
   * Deliberately only callable from the bootstrap CLI. Public registration
   * creates shops; nothing anywhere creates platform administrators except a
   * person with shell access to the server, and no credential is committed to
   * source for one.
   */
  async createAdmin(input: { email: string; name: string; password: string }): Promise<Buffer> {
    const email = normaliseEmail(input.email);
    if (!email.includes('@')) {
      throw new ForbiddenException('A platform administrator needs an email address.');
    }
    const id = newUuidV7Bin();
    await this.prisma.platformAdmin.create({
      data: {
        id,
        email,
        name: input.name,
        passwordHash: await this.hashing.hash(input.password),
      },
    });
    return id;
  }

  /** Constant-time compare, for anything that ever needs to match a secret. */
  static safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    if (x.length !== y.length) return false;
    return timingSafeEqual(x, y);
  }
}
