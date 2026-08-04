import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * User management foundation.
 *
 * NOTE: authentication lookups run BEFORE a tenant context exists, so they use
 * the unscoped system client ({@link PrismaService}) by design. In v1 (single
 * company) `login` is unique enough; multi-tenant login resolution (company code
 * / subdomain) is a future concern.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  findByLoginForAuth(login: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { login, deletedAt: null } });
  }

  findById(id: Buffer): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
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
        passwordHash,
        pinHash,
      },
    });
  }
}
