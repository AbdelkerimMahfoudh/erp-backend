import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { generatePersonalId } from '../auth/identifier';
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
  findCandidatesForAuth(kind: 'personal_id' | 'phone', value: string): Promise<User[]> {
    const where =
      kind === 'personal_id'
        ? { personalId: value, deletedAt: null, isActive: true }
        : { phone: value, deletedAt: null, isActive: true };
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
      include: { company: { select: { publicStoreId: true } } },
    });
  }

  async setLastLogin(id: Buffer): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }

  async createUser(
    companyId: Buffer,
    data: { name: string; login: string; password: string; pin?: string },
  ): Promise<User> {
    const passwordHash = await this.hashing.hash(data.password);
    const pinHash = data.pin ? await this.hashing.hash(data.pin) : null;
    return this.prisma.user.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        name: data.name,
        login: data.login,
        /*
          Every user gets a personal ID at creation (CP3). Generated, never
          chosen: it is how somebody signs in when they have no phone — which,
          per the audit, is every user in this installation today.
        */
        personalId: generatePersonalId(),
        passwordHash,
        pinHash,
      },
    });
  }
}
