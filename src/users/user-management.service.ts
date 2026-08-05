import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, isUuid, uuidToBin } from '../common/utils/uuid.util';
import { UpdateUserDto } from './dto/update-user.dto';
import { toE164, isValidEmail } from './contact.util';

/**
 * `active` — usable and contactable. `inactive` — deactivated (never deleted).
 * `pending_contact` — active but has no phone yet, so cannot be reached for OTP
 * or recovery. Derived, not stored: adding a lifecycle column would risk pushing
 * the existing users (who predate contact capture) into a "broken" state.
 */
export type UserStatus = 'active' | 'inactive' | 'pending_contact';

export interface UserBranchView {
  branchId: string;
  branchName: string;
  role: string;
}

/**
 * What the Team screen may see. Note what is ABSENT: `passwordHash`, `pinHash`,
 * refresh-token hashes and session material never appear in this shape, because
 * the query never selects them.
 */
export interface UserView {
  id: string;
  name: string;
  login: string;
  phone: string | null;
  email: string | null;
  /** ISO timestamp, or null. Null in Stage 1 — there is no verification yet. */
  phoneVerifiedAt: string | null;
  emailVerifiedAt: string | null;
  isActive: boolean;
  status: UserStatus;
  lastLoginAt: string | null;
  branches: UserBranchView[];
}

/** The exact columns the Team surface is allowed to read — hashes excluded. */
const USER_SELECT = {
  id: true,
  name: true,
  login: true,
  phone: true,
  email: true,
  phoneVerifiedAt: true,
  emailVerifiedAt: true,
  isActive: true,
  lastLoginAt: true,
  userBranches: {
    select: {
      branch: { select: { id: true, name: true } },
      role: { select: { key: true } },
    },
  },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/**
 * Owner-only user management for F1 Stage 1 — read the team and edit contact
 * details. Every route is guarded by `user.manage`, and the tenant-scoped client
 * confines every query to the caller's company automatically.
 *
 * Deliberately NOT here (later stages): creating users (invitation acceptance,
 * Stage 5), assigning roles or branches (Stage 7), per-user permission grants
 * (Stage 2), device/session control (Stage 3), OTP, passcode or password reset.
 */
@Injectable()
export class UserManagementService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<UserView[]> {
    const rows = await this.db.user.findMany({
      where: { deletedAt: null },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: USER_SELECT,
    });
    return rows.map((r) => this.toView(r));
  }

  async getOne(idStr: string): Promise<UserView> {
    const row = await this.findInCompany(idStr);
    return this.toView(row);
  }

  async update(idStr: string, dto: UpdateUserDto): Promise<UserView> {
    const before = await this.findInCompany(idStr);
    const id = uuidToBin(idStr);

    const data: Prisma.UserUpdateInput = {};
    const changed: string[] = [];

    if (dto.name !== undefined && dto.name !== before.name) {
      data.name = dto.name;
      changed.push('name');
    }

    // A changed contact must never keep a stale "verified" mark. Clearing (empty
    // string) and replacing both reset the matching timestamp.
    if (dto.phone !== undefined) {
      const next = this.resolvePhone(dto.phone);
      if (next !== before.phone) {
        data.phone = next;
        data.phoneVerifiedAt = null;
        changed.push('phone');
      }
    }

    if (dto.email !== undefined) {
      const next = this.resolveEmail(dto.email);
      if (next !== before.email) {
        data.email = next;
        data.emailVerifiedAt = null;
        changed.push('email');
      }
    }

    if (dto.isActive !== undefined && dto.isActive !== before.isActive) {
      if (dto.isActive === false && this.isSelf(id)) {
        throw new BadRequestException('You cannot deactivate your own account');
      }
      data.isActive = dto.isActive;
      changed.push('isActive');
    }

    if (changed.length === 0) {
      throw new BadRequestException('No changes were provided');
    }

    // Deactivation must be a security boundary, not just a flag flip: in one
    // transaction we set isActive=false AND revoke every active session, so the
    // user's refresh tokens die and — because access tokens are bound to a
    // session — their access tokens stop authorizing at once. Reactivation does
    // NOT un-revoke sessions, so a re-enabled user must authenticate again.
    const deactivating = changed.includes('isActive') && dto.isActive === false;
    let sessionsRevoked = 0;
    try {
      const ops: Prisma.PrismaPromise<unknown>[] = [this.db.user.update({ where: { id }, data })];
      if (deactivating) {
        ops.push(
          this.db.authSession.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          }),
        );
      }
      const results = await this.db.$transaction(ops);
      if (deactivating) sessionsRevoked = (results[1] as { count: number }).count;
    } catch (e) {
      // The per-company unique index is the real guarantee; this turns the
      // race-loser's 500 into a clear 409.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Another user in this company already uses that phone number');
      }
      throw e;
    }

    const after = await this.findInCompany(idStr);
    await this.audit.record({
      entityType: 'User',
      entityId: id,
      action: changed.length === 1 && changed[0] === 'isActive' ? 'status_change' : 'update',
      before: this.auditable(before, changed),
      after: this.auditable(after, changed),
      reason: deactivating ? `Deactivated; ${sessionsRevoked} active session(s) revoked` : undefined,
    });

    return this.toView(after);
  }

  // ------------------------------------------------------------- internals

  private async findInCompany(idStr: string): Promise<UserRow> {
    if (!isUuid(idStr)) {
      throw new NotFoundException('User not found');
    }
    const row = await this.db.user.findFirst({
      where: { id: uuidToBin(idStr), deletedAt: null },
      select: USER_SELECT,
    });
    if (!row) {
      throw new NotFoundException('User not found');
    }
    return row;
  }

  /** '' clears the phone; anything else must normalize to E.164 or it is a 400. */
  private resolvePhone(raw: string): string | null {
    if (raw === '') return null;
    const e164 = toE164(raw);
    if (!e164) {
      throw new BadRequestException('Enter the phone in international format, e.g. +2223XXXXXX');
    }
    return e164;
  }

  private resolveEmail(raw: string): string | null {
    if (raw === '') return null;
    if (!isValidEmail(raw)) {
      throw new BadRequestException('That does not look like an email address');
    }
    return raw;
  }

  private isSelf(id: Buffer): boolean {
    const self = this.tenant.userId();
    return !!self && Buffer.compare(self, id) === 0;
  }

  private toView(row: UserRow): UserView {
    return {
      id: binToUuid(row.id),
      name: row.name,
      login: row.login,
      phone: row.phone,
      email: row.email,
      phoneVerifiedAt: row.phoneVerifiedAt ? row.phoneVerifiedAt.toISOString() : null,
      emailVerifiedAt: row.emailVerifiedAt ? row.emailVerifiedAt.toISOString() : null,
      isActive: row.isActive,
      status: !row.isActive ? 'inactive' : row.phone ? 'active' : 'pending_contact',
      lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
      branches: row.userBranches.map((ub) => ({
        branchId: binToUuid(ub.branch.id),
        branchName: ub.branch.name,
        role: ub.role.key,
      })),
    };
  }

  /** Only the touched fields, and only safe ones — never a hash or a token. */
  private auditable(row: UserRow, changed: string[]): Prisma.InputJsonValue {
    const all: Record<string, unknown> = {
      name: row.name,
      phone: row.phone,
      email: row.email,
      phoneVerifiedAt: row.phoneVerifiedAt ? row.phoneVerifiedAt.toISOString() : null,
      emailVerifiedAt: row.emailVerifiedAt ? row.emailVerifiedAt.toISOString() : null,
      isActive: row.isActive,
    };
    const out: Record<string, unknown> = {};
    // Record the verification reset alongside the contact change, so the audit
    // shows the "verified" mark being cleared.
    const keys = new Set(changed);
    if (keys.has('phone')) keys.add('phoneVerifiedAt');
    if (keys.has('email')) keys.add('emailVerifiedAt');
    for (const k of keys) {
      if (k in all) out[k] = all[k];
    }
    return out as Prisma.InputJsonValue;
  }
}
