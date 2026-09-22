import { BadRequestException, Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { generatePersonalId, normaliseEmail, normalisePhone } from '../auth/identifier';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * User management foundation.
 *
 * NOTE: authentication lookups run BEFORE a tenant context exists, so they use
 * the unscoped system client ({@link PrismaService}) by design. Login resolves
 * the company from the public Store Account ID first (Stage 3.2), then finds the
 * user WITHIN that company — `login` is unique only per company, so the lookup
 * must be company-scoped or the same login in two companies would collide.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  /** Find a user by login, scoped to the already-resolved company. */
  findByLoginForAuth(companyId: Buffer, login: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { companyId, login, deletedAt: null } });
  }

  /**
   * Candidates for one sign-in identifier (CP3).
   *
   * A personal ID is globally unique, so it yields at most one. A phone is
   * unique only WITHIN a company, so the same number may legitimately belong
   * to a person at two shops — that ambiguity is resolved after the password
   * is verified, never by asking for a Store ID up front.
   *
   * Deleted and deactivated users are excluded here rather than checked
   * later, so a disabled account cannot even become a candidate.
   */
  findCandidatesForAuth(kind: 'email' | 'phone' | 'personal_id', value: string): Promise<User[]> {
    /*
     * Every branch filters on `deletedAt: null, isActive: true`, so a disabled
     * or removed account produces no candidate at all and therefore fails with
     * the same generic message as an identifier nobody holds. Whether an
     * account exists is not something an unauthenticated caller may learn.
     *
     * Case is the database's job: `email`, `phone` and `personal_id` are all
     * `utf8mb4_0900_ai_ci`, so the comparison here is already case-insensitive
     * and matches the unique indexes exactly.
     */
    const base = { deletedAt: null, isActive: true };
    const where =
      kind === 'email'
        ? { email: value, ...base }
        : kind === 'personal_id'
          ? { personalId: value, ...base }
          : { phone: value, ...base };
    // Bounded: a number legitimately shared by a handful of shops is possible,
    // hundreds is not, and an unbounded scan here would be a denial-of-service
    // surface on an unauthenticated route.
    return this.prisma.user.findMany({ where, take: 10 });
  }

  findById(id: Buffer): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /** The user plus their company's public Store Account ID (for `/auth/me`). */
  findByIdWithStore(id: Buffer) {
    return this.prisma.user.findUnique({
      where: { id },
      include: { company: { select: { publicStoreId: true, name: true } } },
    });
  }

  async setLastLogin(id: Buffer): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }

  /**
   * Create a user who can actually sign in.
   *
   * **At least one login contact is required.** An account with neither an
   * email nor a WhatsApp number cannot reach the sign-in screen at all now
   * that those are the only identifiers it offers — creating one would be
   * manufacturing the exact problem the contactless legacy accounts already
   * represent. Either contact satisfies the rule; both may be stored.
   *
   * Enforced here, in the service, rather than in a DTO: every path that
   * creates a user goes through this method, and a validation rule that lives
   * only on one HTTP shape is a rule the seed and the CLI can walk around.
   */
  async createUser(
    companyId: Buffer,
    data: {
      name: string;
      login: string;
      password: string;
      pin?: string;
      email?: string | null;
      phone?: string | null;
    },
  ): Promise<User> {
    const email = data.email ? normaliseEmail(data.email) : null;
    const phone = data.phone ? normalisePhone(data.phone) : null;

    if (!email && !phone) {
      throw new BadRequestException(
        'A new user needs an email address or a WhatsApp number — it is how they sign in.',
      );
    }
    if (data.email && !email) {
      throw new BadRequestException('That does not look like an email address');
    }
    if (data.phone && !phone) {
      throw new BadRequestException('That does not look like a WhatsApp number');
    }

    const passwordHash = await this.hashing.hash(data.password);
    const pinHash = data.pin ? await this.hashing.hash(data.pin) : null;
    return this.prisma.user.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        name: data.name,
        login: data.login,
        email,
        phone,
        /*
          Still generated for every user, and still not a normal way to sign in.
          It remains the transitional path for the accounts that pre-date
          email/WhatsApp login, and stays useful as a support reference. See
          `docs/36`.
        */
        personalId: generatePersonalId(),
        passwordHash,
        pinHash,
      },
    });
  }
}
