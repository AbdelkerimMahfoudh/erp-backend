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
import { isDelegatable, DELEGATION_ELIGIBLE_ROLE, DELEGATABLE_PERMISSIONS } from '../rbac/permission-scope';
import { UpdateUserDto } from './dto/update-user.dto';
import { toE164, isValidEmail } from './contact.util';
import { EntitlementService } from '../entitlement/entitlement.service';
import { SEAT_LIMIT_REACHED } from '../entitlement/entitlement-rules';

/**
 * The one permission this API can delegate, as a server-side constant.
 *
 * It is deliberately NOT taken from the request. The route spells the authority
 * out in its path (`/delegations/price-edit`), so there is no field a client
 * could put `discount.override` or `user.manage` into — the narrow API cannot
 * be turned into a general permission administration endpoint by sending a
 * different body.
 */
const DELEGATED_PERMISSION = 'price.edit';

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
  /** Whether this assignment may receive delegated permissions (store_manager). */
  canDelegate: boolean;
  /** Delegatable permissions currently granted on THIS assignment (Stage 2). */
  grantedPermissions: string[];
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
  /** Permissions an Owner is allowed to delegate at all (the allow-list). */
  delegatablePermissions: string[];
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
      permissions: { select: { permission: { select: { key: true } } } },
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
    private readonly entitlement: EntitlementService,
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

      /**
       * Reactivating somebody consumes a staff seat (Milestone K).
       *
       * Checked here, at the moment of activation, rather than against a figure
       * the client was shown earlier — two Owners re-enabling the last seat at
       * the same time must not both succeed.
       *
       * Deactivation is never blocked. A company over its limit must always be
       * able to get back under it, and a seat check that stopped somebody
       * *removing* staff would trap them there.
       */
      if (dto.isActive === true) {
        const seats = await this.entitlement.maySeat(this.tenant.companyId());
        if (!seats.allowed) {
          throw new ConflictException({
            code: SEAT_LIMIT_REACHED,
            message:
              `All ${seats.seatLimit} staff places are in use. Deactivate somebody, or add places, before re-enabling this account.`,
          });
        }
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

  // --------------------------------------------------- delegated price.edit

  /**
   * Delegate ordinary price editing to a Store Manager **in one branch**.
   *
   * The grant attaches to the `UserBranch` assignment, not to the user, which is
   * what makes it branch-specific: `AccessService` only reads grants in the
   * branch-scoped resolution path, so authority given in branch A cannot appear
   * in branch B, and cannot appear at all without an `X-Branch-Id`.
   *
   * Idempotent by contract — repeating a grant is a no-op, not a second row.
   * This never confers below-cost authority: that stays gated on
   * `discount.override`, which is Owner-only and not delegatable.
   */
  async grantPriceEdit(userIdStr: string, branchIdStr: string): Promise<UserView> {
    const assignment = await this.eligibleAssignment(userIdStr, branchIdStr);
    const permission = await this.delegatedPermission();

    try {
      await this.db.userBranchPermission.create({
        data: {
          companyId: this.tenant.companyId(),
          userBranchId: assignment.id,
          permissionId: permission.id,
          grantedById: this.tenant.requireUserId(),
        },
      });
      await this.recordDelegation('create', userIdStr, branchIdStr, assignment.branchName);
    } catch (e) {
      // Two Owners granting at once: the composite primary key makes the loser
      // a no-op rather than a duplicate. Already-granted is success.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }

    return this.getOne(userIdStr);
  }

  /**
   * Withdraw the delegation. Idempotent: revoking a grant that is not there
   * succeeds, because the caller's intent — "this manager must not have it" —
   * is satisfied either way.
   */
  async revokePriceEdit(userIdStr: string, branchIdStr: string): Promise<UserView> {
    // Deliberately NOT the eligibility check: if a manager was downgraded, the
    // grant row may still exist and an Owner must still be able to clear it.
    const assignment = await this.assignment(userIdStr, branchIdStr);
    const permission = await this.delegatedPermission();

    const { count } = await this.db.userBranchPermission.deleteMany({
      where: { userBranchId: assignment.id, permissionId: permission.id },
    });
    if (count > 0) {
      await this.recordDelegation('delete', userIdStr, branchIdStr, assignment.branchName);
    }

    return this.getOne(userIdStr);
  }

  /** The assignment, scoped to this company by the tenant client. */
  private async assignment(userIdStr: string, branchIdStr: string) {
    if (!isUuid(userIdStr) || !isUuid(branchIdStr)) {
      throw new NotFoundException('Branch assignment not found');
    }
    // A forged or another company's branch simply does not match — the tenant
    // extension injects `companyId`, so this fails closed rather than leaking
    // whether the branch exists elsewhere.
    const found = await this.db.userBranch.findFirst({
      where: { userId: uuidToBin(userIdStr), branchId: uuidToBin(branchIdStr) },
      select: {
        id: true,
        role: { select: { key: true } },
        branch: { select: { name: true } },
        user: { select: { isActive: true, deletedAt: true } },
      },
    });
    if (!found) {
      throw new NotFoundException('This user has no assignment in that branch');
    }
    return { ...found, branchName: found.branch.name };
  }

  /** The assignment, plus every rule that makes it eligible to RECEIVE a grant. */
  private async eligibleAssignment(userIdStr: string, branchIdStr: string) {
    const found = await this.assignment(userIdStr, branchIdStr);

    if (found.user.deletedAt || !found.user.isActive) {
      throw new ConflictException('This user is deactivated and cannot receive delegated authority');
    }
    if (found.role.key !== DELEGATION_ELIGIBLE_ROLE) {
      // Employees and administrators are refused here, not silently ignored, so
      // the Owner learns why nothing happened.
      throw new ConflictException(
        'Price editing can only be delegated to a Store Manager in that branch',
      );
    }
    return found;
  }

  private async delegatedPermission() {
    const permission = await this.db.permission.findUnique({
      where: { key: DELEGATED_PERMISSION },
      select: { id: true },
    });
    if (!permission) {
      // Migration 0022 guarantees this row exists; a miss means the database is
      // behind the code, which is worth saying plainly rather than 500-ing.
      throw new ConflictException(
        `The "${DELEGATED_PERMISSION}" permission is missing — apply pending migrations`,
      );
    }
    return permission;
  }

  /** Actor comes from the audit context; never any hash, token or secret. */
  private recordDelegation(
    action: 'create' | 'delete',
    userIdStr: string,
    branchIdStr: string,
    branchName: string,
  ): Promise<void> {
    const payload = {
      targetUserId: userIdStr,
      branchId: branchIdStr,
      branchName,
      permission: DELEGATED_PERMISSION,
    };
    return this.audit.record({
      entityType: 'UserBranchPermission',
      entityId: uuidToBin(userIdStr),
      action,
      branchId: uuidToBin(branchIdStr),
      before: action === 'delete' ? payload : undefined,
      after: action === 'create' ? payload : undefined,
      reason:
        action === 'create'
          ? `Delegated ${DELEGATED_PERMISSION} in ${branchName}`
          : `Revoked ${DELEGATED_PERMISSION} in ${branchName}`,
    });
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
        canDelegate: ub.role.key === DELEGATION_ELIGIBLE_ROLE,
        // Only delegatable grants are ever meaningful; filter defensively.
        grantedPermissions: ub.permissions
          .map((p) => p.permission.key)
          .filter(isDelegatable),
      })),
      delegatablePermissions: [...DELEGATABLE_PERMISSIONS],
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
