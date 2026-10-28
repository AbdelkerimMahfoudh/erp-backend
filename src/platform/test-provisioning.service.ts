import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { HashingService } from '../common/security/hashing.service';
import { generatePersonalId, isEmail, normaliseEmail, normalisePhone } from '../auth/identifier';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { actorRef, contactPresence } from '../common/privacy/audit-contact';
import { EntitlementService } from '../entitlement/entitlement.service';
import { SessionsService } from '../auth/sessions.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformMfaService } from './platform-mfa.service';
import type { PlatformAdminIdentity } from './platform-admin.service';
import { AccountSetupCodeService, type IssuedSetupCode } from './account-setup-code.service';

/** The number's verification policy an administrator chooses for an account they provision (D224). */
export type VerificationPolicy = 'required' | 'deferred_by_platform';
export type StaffRoleKey = 'store_manager' | 'store_employee';

/** What a deferral needs, besides its account: the administrator's written reason and their confirmation. */
export interface DeferralInput {
  reason: string;
  confirmControlledTest: boolean;
  reviewAt?: string | null;
}

export interface TestActor {
  admin: PlatformAdminIdentity;
  /** The session the request authenticated with: a deferral needs ITS step-up, fresh. */
  sessionId: Buffer | undefined;
  ip?: string | null;
}

/** The longest a deferral may be planned for before it is reviewed. */
export const DEFERRAL_REVIEW_MAX_DAYS = 90;

/** How a deferred account reads anywhere the platform describes it. Never "verified". */
export interface DeferralView {
  userId: string;
  name: string;
  role: string | null;
  stores: string[];
  phoneVerification: 'deferred_by_platform';
  grantedBy: string;
  grantedAt: string;
  reason: string;
  reviewAt: string | null;
  setupCode: 'none' | 'active' | 'expired' | 'used' | 'revoked';
  activated: boolean;
}

/**
 * Accounts a platform superadmin provisions in a TEST business, and the deferred-verification exception (D224,
 * docs/109). Every condition is the server's (§2.3); the portal hiding a control decides nothing:
 *
 *  1. a superadmin — every platform administrator is one — whose MFA is enabled;
 *  2. a fresh step-up on THIS session (password and an authenticator code, five minutes);
 *  3. the protected platform routes — tenants and public registration have no such field, and the whitelist pipe
 *     rejects one sent anyway;
 *  4. a business marked Test;
 *  5. the kill switch `PHONE_VERIFICATION_DEFERRAL=on`.
 *
 * A deferral never verifies anything: `phone_verified_at` stays null, no WhatsApp consent is recorded, nothing is sent.
 * Every grant, change and refusal is audited, never with a password, code or secret.
 */
@Injectable()
export class TestProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly hashing: HashingService,
    private readonly audit: PlatformAuditService,
    private readonly mfa: PlatformMfaService,
    private readonly entitlement: EntitlementService,
    private readonly sessions: SessionsService,
    private readonly codes: AccountSetupCodeService,
  ) {}

  /** The console's question: may it offer the choice at all (the kill switch). */
  get deferralAvailable(): boolean {
    return this.config.phoneVerificationDeferralEnabled;
  }

  // ── the conditions ──────────────────────────────────────────────────────

  private async refuse(error: HttpException, ctx: TestActor, attempted: string, target: { id: Buffer | null; label: string | null }, detail: Record<string, unknown> = {}): Promise<never> {
    const body = error.getResponse();
    const code = typeof body === 'object' && body !== null && 'code' in body ? String((body as { code: unknown }).code) : String(error.getStatus());
    await this.audit.record({
      admin: ctx.admin,
      action: `${attempted}.refused`,
      targetType: 'Company',
      targetId: target.id,
      targetLabel: target.label,
      reason: code,
      after: { outcome: 'refused', refusal: code, ...detail },
      ip: ctx.ip ?? null,
    });
    throw error;
  }

  /** The written reason and the planned review, checked before anything is looked up. */
  parseDeferral(input: DeferralInput | undefined, now = new Date()): { reason: string; reviewAt: Date | null } {
    const reason = (input?.reason ?? '').trim();
    if (!reason) throw new BadRequestException({ code: 'deferral_reason_required', message: 'Write why this account’s WhatsApp verification is deferred.' });
    if (reason.length > 500) throw new BadRequestException({ code: 'deferral_reason_too_long', message: 'The reason is at most 500 characters.' });
    if (input?.confirmControlledTest !== true) {
      throw new BadRequestException({ code: 'deferral_confirmation_required', message: 'Confirm that this account is for controlled testing.' });
    }
    let reviewAt: Date | null = null;
    if (input.reviewAt) {
      reviewAt = new Date(input.reviewAt);
      const max = now.getTime() + DEFERRAL_REVIEW_MAX_DAYS * 86_400_000;
      if (Number.isNaN(reviewAt.getTime()) || reviewAt.getTime() <= now.getTime() || reviewAt.getTime() > max) {
        throw new BadRequestException({ code: 'deferral_review_date', message: `Choose a review date in the next ${DEFERRAL_REVIEW_MAX_DAYS} days.` });
      }
    }
    return { reason, reviewAt };
  }

  /**
   * Every condition of a deferral, the server's (docs/109 §2.3). Refused and audited unless all hold. `isTest` is read
   * by the caller inside its own transaction as well, so a business un-marked meanwhile cannot slip through.
   */
  async assertMayDefer(ctx: TestActor, company: { id: Buffer | null; name: string; isTest: boolean }, attempted: string): Promise<void> {
    const target = { id: company.id, label: company.name };
    if (!this.config.phoneVerificationDeferralEnabled) {
      await this.refuse(new ForbiddenException({ code: 'deferral_disabled', message: 'Deferred WhatsApp verification is switched off on this server.' }), ctx, attempted, target, { condition: 'kill_switch' });
    }
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: ctx.admin.id }, select: { mfaEnabledAt: true, isActive: true, deletedAt: true } });
    if (!admin || !admin.isActive || admin.deletedAt || !admin.mfaEnabledAt) {
      await this.refuse(new ForbiddenException({ code: 'deferral_mfa_required', message: 'Only an administrator with MFA enabled may defer verification.' }), ctx, attempted, target, { condition: 'mfa' });
    }
    try {
      await this.mfa.assertFreshStepUp(ctx.sessionId);
    } catch (e) {
      if (e instanceof HttpException) await this.refuse(e, ctx, attempted, target, { condition: 'step_up' });
      throw e;
    }
    if (!company.isTest) {
      await this.refuse(new ForbiddenException({ code: 'deferral_test_business_only', message: 'WhatsApp verification can be deferred only for a test business.' }), ctx, attempted, target, { condition: 'test_business' });
    }
  }

  // ── an Owner created deferred ───────────────────────────────────────────

  /**
   * The Owner of a test business the console just created, deferred: the state, the exception's record and a setup code
   * in one transaction. The Owner's setup invitation (0075) is not issued: this code replaces it.
   */
  async deferOwner(companyUuid: string, deferral: { reason: string; reviewAt: Date | null }, ctx: TestActor): Promise<{ setupCode: IssuedSetupCode; ownerId: string }> {
    const companyId = uuidToBin(companyUuid);
    const now = new Date();
    const out = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true, isTest: true } });
      if (!company.isTest) throw new ForbiddenException({ code: 'deferral_test_business_only', message: 'WhatsApp verification can be deferred only for a test business.' });
      const owner = await tx.user.findFirstOrThrow({ where: { companyId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, phoneVerifiedAt: true } });
      if (owner.phoneVerifiedAt) throw new ConflictException({ code: 'already_verified', message: 'This number is already verified.' });
      await tx.user.update({ where: { id: owner.id }, data: { phoneVerification: 'deferred_by_platform' } });
      await tx.phoneVerificationDeferral.create({
        data: { id: newUuidV7Bin(), companyId, userId: owner.id, grantedById: ctx.admin.id, grantedBy: ctx.admin.email.slice(0, 160), reason: deferral.reason, reviewAt: deferral.reviewAt, grantedAt: now },
      });
      const code = await this.codes.issueTx(tx, { companyId, userId: owner.id, issuedBy: ctx.admin.email, now });
      await this.audit.record(
        {
          admin: ctx.admin,
          action: 'phone_verification.defer',
          targetType: 'Company',
          targetId: companyId,
          targetLabel: company.name,
          reason: deferral.reason,
          after: { person: actorRef(binToUuid(owner.id)), role: 'owner', stores: 'all', phoneVerification: 'deferred_by_platform', reviewAt: deferral.reviewAt?.toISOString() ?? null, outcome: 'deferred' },
          ip: ctx.ip ?? null,
        },
        tx,
      );
      return { company: company.name, ownerId: owner.id, code };
    });
    await this.codes.recordIssue(ctx, { companyId, company: out.company, userId: out.ownerId, replaced: out.code.replaced, expiresAt: out.code.expiresAt });
    const { replaced: _replaced, ...setupCode } = out.code;
    return { setupCode, ownerId: binToUuid(out.ownerId) };
  }

  // ── test staff ──────────────────────────────────────────────────────────

  /**
   * A Manager or an Employee of a TEST business, provisioned by the administrator (docs/109 §2.4). Not a replacement for
   * the Owner's Team screen: only a test business, never an Owner, and the business's rules all hold — one Owner, a
   * number and an email unique in the business, roles only from the business, stores only its own and active, a seat
   * free at each store (a test business's seats are granted; none is priced here).
   *
   * `required`: the account waits, like any invited employee, for the person to verify their number — the code is a
   * setup code all the same, but the account is not usable until then. `deferred_by_platform`: usable once the person
   * spends the code.
   */
  async createStaff(
    companyUuid: string,
    input: { name: string; phone: string; email?: string | null; role: StaffRoleKey; branchIds: string[]; verification: VerificationPolicy; deferral?: DeferralInput },
    ctx: TestActor,
  ) {
    if (!isUuid(companyUuid)) throw new NotFoundException('Unknown business');
    const companyId = uuidToBin(companyUuid);
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, isTest: true, isActive: true, closedAt: true } });
    if (!company) throw new NotFoundException('Unknown business');
    const target = { id: company.id, label: company.name };
    if (!company.isTest) {
      await this.refuse(new ForbiddenException({ code: 'test_business_only', message: 'Staff are provisioned from the console only for a test business.' }), ctx, 'account.create', target);
    }
    if (!company.isActive || company.closedAt) {
      await this.refuse(new ConflictException({ code: 'business_closed', message: 'This business is closed.' }), ctx, 'account.create', target);
    }
    if (input.role !== 'store_manager' && input.role !== 'store_employee') {
      // One Owner per business: the console never makes a second.
      await this.refuse(new BadRequestException({ code: 'role_not_allowed', message: 'Choose Manager or Employee.' }), ctx, 'account.create', target);
    }

    const deferred = input.verification === 'deferred_by_platform';
    const deferral = deferred ? this.parseDeferral(input.deferral) : null;
    if (deferred) await this.assertMayDefer(ctx, company, 'phone_verification.defer');

    const name = (input.name ?? '').trim().slice(0, 160);
    if (!name) throw new BadRequestException('Give the person a name.');
    const phone = input.phone?.trim() ? normalisePhone(input.phone.trim()) : null;
    if (!phone) throw new BadRequestException({ code: 'whatsapp_required', message: 'Give the person’s WhatsApp number.' });
    const email = input.email?.trim() ? normaliseEmail(input.email.trim()) : null;
    if (input.email?.trim() && (!email || !isEmail(input.email.trim()))) throw new BadRequestException('That does not look like an email address.');

    const branchIds = [...new Set(input.branchIds ?? [])].filter(isUuid).map((id) => uuidToBin(id));
    if (branchIds.length === 0 || branchIds.length !== new Set(input.branchIds ?? []).size) throw new BadRequestException({ code: 'stores_required', message: 'Choose at least one of the business’s stores.' });
    const branches = await this.prisma.branch.findMany({ where: { id: { in: branchIds }, companyId, isActive: true, deletedAt: null }, select: { id: true, name: true } });
    if (branches.length !== branchIds.length) throw new NotFoundException('Unknown store');
    const role = await this.prisma.role.findFirst({ where: { companyId, key: input.role }, select: { id: true } });
    if (!role) throw new BadRequestException('That role does not exist in this business.');

    // Seats (the owner's decision, 2026-10-28): a test business is never paid for, so where a chosen store has no free
    // seat — counting the people already provisioned there and still waiting — this person is GRANTED a seat there, at
    // no charge, held for them and audited, exactly as a test business's stores are granted. Never priced; the seat
    // census counts it like any held seat. Only under the business's administrative grant in force.
    const sub = await this.prisma.subscription.findFirst({ where: { companyId }, select: { id: true, status: true, isComplimentary: true, complimentaryUntil: true } });
    const granted = sub?.status === 'activated' && sub.isComplimentary && sub.complimentaryUntil !== null && sub.complimentaryUntil.getTime() > Date.now();
    if (!sub || !granted) {
      await this.refuse(new ConflictException({ code: 'grant_required', message: 'Give this test business an administrative grant first: its staff are seated under that grant.' }), ctx, 'account.create', target);
    }
    const seats = await this.entitlement.maySeat(companyId, branchIds);
    const waiting = await this.prisma.userBranch.groupBy({
      by: ['branchId'],
      where: {
        companyId,
        branchId: { in: branchIds },
        role: { key: { not: 'owner' } },
        // Every person still waiting there: a seat granted to one of them raises the store's limit, and is theirs.
        user: { invitedAt: { not: null }, activatedAt: null, deletedAt: null },
      },
      _count: { _all: true },
    });
    const toGrant = branches.filter((b) => {
      const line = seats.stores.find((s) => s.branchId === binToUuid(b.id));
      const pending = waiting.find((w) => w.branchId.equals(b.id))?._count._all ?? 0;
      const room = line ? line.seatLimit - line.seatsUsed - pending : 0;
      return room <= 0 || seats.full.includes(binToUuid(b.id));
    });

    const userId = newUuidV7Bin();
    const now = new Date();
    const stores = branches.map((b) => b.name);
    let code: (IssuedSetupCode & { replaced: number }) | null = null;
    try {
      code = await this.prisma.$transaction(async (tx) => {
        // Read again inside the write: a business un-marked meanwhile is refused here as well.
        const still = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { isTest: true } });
        if (!still.isTest) throw new ForbiddenException({ code: 'test_business_only', message: 'Staff are provisioned from the console only for a test business.' });
        await tx.user.create({
          data: {
            id: userId,
            companyId,
            name,
            login: `staff-${binToUuid(userId).slice(-12)}`,
            email,
            phone,
            personalId: generatePersonalId(),
            // Known to nobody: the person chooses theirs with the setup code.
            passwordHash: await this.hashing.hash(randomBytes(32).toString('base64url')),
            isActive: false,
            invitedAt: now,
            activatedAt: null,
            phoneVerification: deferred ? 'deferred_by_platform' : 'required',
          },
        });
        for (const branch of branches) {
          await tx.userBranch.create({ data: { id: newUuidV7Bin(), companyId, userId, branchId: branch.id, roleId: role.id } });
        }
        for (const branch of toGrant) {
          await tx.seatAllocation.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              subscriptionId: sub!.id,
              branchId: branch.id,
              userId,
              kind: 'seat',
              status: 'granted',
              label: name,
              monthlyAmount: 0,
              requestedBy: `platform:${ctx.admin.email}`.slice(0, 160),
              confirmedBy: `platform:${ctx.admin.email}`.slice(0, 160),
              confirmedAt: now,
              reason: `Seat granted at no charge under the test business's administrative grant, for ${name}`.slice(0, 500),
            },
          });
        }
        if (deferral) {
          await tx.phoneVerificationDeferral.create({
            data: { id: newUuidV7Bin(), companyId, userId, grantedById: ctx.admin.id, grantedBy: ctx.admin.email.slice(0, 160), reason: deferral.reason, reviewAt: deferral.reviewAt, grantedAt: now },
          });
        }
        await tx.auditLog.create({
          data: {
            companyId,
            userId: null,
            entityType: 'User',
            entityId: userId,
            action: 'create',
            after: { name, email: contactPresence(email), phone: contactPresence(phone), role: input.role, stores, status: 'pending', invitedBy: `platform:${ctx.admin.email}`, phoneVerification: deferred ? 'deferred_by_platform' : 'required' },
            reason: deferred ? `Provisioned by the platform for controlled testing; WhatsApp verification deferred: ${deferral!.reason}` : 'Provisioned by the platform; WhatsApp verification required',
          },
        });
        const issued = await this.codes.issueTx(tx, { companyId, userId, issuedBy: ctx.admin.email, now });
        await this.audit.record(
          {
            admin: ctx.admin,
            action: 'account.create',
            targetType: 'Company',
            targetId: companyId,
            targetLabel: company.name,
            reason: deferral?.reason ?? null,
            after: {
              person: actorRef(binToUuid(userId)),
              role: input.role,
              stores,
              seatsGranted: toGrant.map((b) => b.name),
              phoneVerification: deferred ? 'deferred_by_platform' : 'required',
              reviewAt: deferral?.reviewAt?.toISOString() ?? null,
              outcome: 'created',
            },
            ip: ctx.ip ?? null,
          },
          tx,
        );
        return issued;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.refuse(new ConflictException({ code: 'contact_in_use', message: 'Somebody in this business already uses that number or email address.' }), ctx, 'account.create', target);
      }
      if (e instanceof HttpException) await this.refuse(e, ctx, 'account.create', target);
      throw e;
    }
    await this.codes.recordIssue(ctx, { companyId, company: company.name, userId, replaced: code.replaced, expiresAt: code.expiresAt });
    const { replaced: _replaced, ...setupCode } = code;
    return {
      user: { id: binToUuid(userId), name, role: input.role, stores, phoneVerification: deferred ? ('deferred_by_platform' as const) : ('required' as const), status: 'pending' as const },
      setupCode,
    };
  }

  // ── the lifecycle ───────────────────────────────────────────────────────

  private async personOf(userUuid: string, companyUuid: string) {
    if (!isUuid(userUuid) || !isUuid(companyUuid)) throw new NotFoundException('Unknown account');
    const user = await this.prisma.user.findFirst({
      where: { id: uuidToBin(userUuid), companyId: uuidToBin(companyUuid), deletedAt: null },
      select: { id: true, companyId: true, name: true, phoneVerification: true, activatedAt: true, invitedAt: true, company: { select: { name: true, isTest: true } }, userBranches: { select: { role: { select: { key: true } } } } },
    });
    // Another business's person reads exactly like nobody: the business is part of the address.
    if (!user) throw new NotFoundException('Unknown account');
    return user;
  }

  /**
   * Deferred → required (docs/109 §2.5): the exception ends, nothing is sent. The person verifies later through the
   * normal flow, which is theirs to begin. An account already in use stays signed in; its WhatsApp-dependent actions
   * were never available and still are not.
   */
  async requireVerification(companyUuid: string, userUuid: string, reason: string, ctx: TestActor) {
    const user = await this.personOf(userUuid, companyUuid);
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('Give a reason.');
    if (user.phoneVerification !== 'deferred_by_platform') throw new ConflictException({ code: 'not_deferred', message: 'This account’s verification is not deferred.' });
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.user.updateMany({ where: { id: user.id, phoneVerification: 'deferred_by_platform' }, data: { phoneVerification: 'required' } });
      if (moved.count !== 1) throw new ConflictException({ code: 'not_deferred', message: 'This account’s verification is not deferred.' });
      await tx.phoneVerificationDeferral.updateMany({ where: { userId: user.id, endedAt: null }, data: { endedAt: now, endedBy: ctx.admin.email.slice(0, 160), endReason: 'required' } });
      await this.audit.record(
        {
          admin: ctx.admin,
          action: 'phone_verification.require',
          targetType: 'Company',
          targetId: user.companyId,
          targetLabel: user.company.name,
          reason: why,
          before: { phoneVerification: 'deferred_by_platform' },
          after: { person: actorRef(binToUuid(user.id)), role: user.userBranches[0]?.role.key ?? null, phoneVerification: 'required', sent: 'nothing', outcome: 'required' },
          ip: ctx.ip ?? null,
        },
        tx,
      );
    });
    return { userId: binToUuid(user.id), phoneVerification: 'required' as const, sent: 'nothing' as const };
  }

  /** The reason or the review date of a live deferral. Never the state itself. */
  async updateDeferral(companyUuid: string, userUuid: string, input: { reason?: string; reviewAt?: string | null }, ctx: TestActor) {
    const user = await this.personOf(userUuid, companyUuid);
    const live = await this.prisma.phoneVerificationDeferral.findFirst({ where: { userId: user.id, endedAt: null } });
    if (!live) throw new ConflictException({ code: 'not_deferred', message: 'This account’s verification is not deferred.' });
    const next = this.parseDeferral({ reason: input.reason ?? live.reason, confirmControlledTest: true, reviewAt: input.reviewAt === undefined ? live.reviewAt?.toISOString() ?? null : input.reviewAt });
    await this.prisma.$transaction(async (tx) => {
      await tx.phoneVerificationDeferral.update({ where: { id: live.id }, data: { reason: next.reason, reviewAt: next.reviewAt } });
      await this.audit.record(
        {
          admin: ctx.admin,
          action: 'phone_verification.deferral_update',
          targetType: 'Company',
          targetId: user.companyId,
          targetLabel: user.company.name,
          reason: next.reason,
          before: { reason: live.reason, reviewAt: live.reviewAt?.toISOString() ?? null },
          after: { person: actorRef(binToUuid(user.id)), reason: next.reason, reviewAt: next.reviewAt?.toISOString() ?? null, outcome: 'updated' },
          ip: ctx.ip ?? null,
        },
        tx,
      );
    });
    return { userId: binToUuid(user.id), reason: next.reason, reviewAt: next.reviewAt?.toISOString() ?? null };
  }

  /** A new setup code for a person who has not spent theirs — the old one revoked in the same transaction. */
  async reissueCode(companyUuid: string, userUuid: string, ctx: TestActor) {
    const user = await this.personOf(userUuid, companyUuid);
    if (!user.company.isTest) throw new ForbiddenException({ code: 'test_business_only', message: 'Setup codes are issued from here only for a test business.' });
    const used = await this.prisma.accountSetupCode.findFirst({ where: { userId: user.id, usedAt: { not: null } }, select: { id: true } });
    if (used) throw new ConflictException({ code: 'already_set_up', message: 'This person already chose their password.' });
    const now = new Date();
    const code = await this.prisma.$transaction((tx) => this.codes.issueTx(tx, { companyId: user.companyId, userId: user.id, issuedBy: ctx.admin.email, now }));
    await this.codes.recordIssue(ctx, { companyId: user.companyId, company: user.company.name, userId: user.id, replaced: Math.max(code.replaced, 1), expiresAt: code.expiresAt });
    const { replaced: _replaced, ...setupCode } = code;
    return { userId: binToUuid(user.id), setupCode };
  }

  async revokeCode(companyUuid: string, userUuid: string, ctx: TestActor) {
    const user = await this.personOf(userUuid, companyUuid);
    const revoked = await this.prisma.$transaction((tx) => this.codes.revokeTx(tx, user.id, 'revoked', new Date()));
    await this.audit.record({
      admin: ctx.admin,
      action: 'account_setup_code.revoke',
      targetType: 'Company',
      targetId: user.companyId,
      targetLabel: user.company.name,
      after: { person: actorRef(binToUuid(user.id)), outcome: revoked ? 'revoked' : 'none_live' },
      ip: ctx.ip ?? null,
    });
    return { userId: binToUuid(user.id), revoked };
  }

  /**
   * Cancel a provisioned account of a test business: deactivated and soft-deleted like any cancelled account, its
   * contacts released, its sessions and setup code revoked, its deferral ended `cancelled`. Nothing is hard-deleted;
   * whatever it recorded stays, attributed. The Owner is never cancelled here.
   */
  async cancelAccount(companyUuid: string, userUuid: string, reason: string, ctx: TestActor) {
    const user = await this.personOf(userUuid, companyUuid);
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('Give a reason.');
    if (!user.company.isTest) throw new ForbiddenException({ code: 'test_business_only', message: 'Accounts are cancelled from here only for a test business.' });
    if (user.userBranches.some((ub) => ub.role.key === 'owner') || !user.invitedAt) {
      throw new ForbiddenException({ code: 'owner_not_cancellable', message: 'The Owner’s account is not cancelled from here.' });
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.codes.revokeTx(tx, user.id, 'cancelled', now);
      await tx.phoneVerificationDeferral.updateMany({ where: { userId: user.id, endedAt: null }, data: { endedAt: now, endedBy: ctx.admin.email.slice(0, 160), endReason: 'cancelled' } });
      await tx.user.update({ where: { id: user.id }, data: { deletedAt: now, isActive: false, email: null, phone: null, emailVerifiedAt: null, phoneVerifiedAt: null } });
      await this.audit.record(
        {
          admin: ctx.admin,
          action: 'account.cancel',
          targetType: 'Company',
          targetId: user.companyId,
          targetLabel: user.company.name,
          reason: why,
          before: { phoneVerification: user.phoneVerification, activated: user.activatedAt !== null },
          after: { person: actorRef(binToUuid(user.id)), role: user.userBranches[0]?.role.key ?? null, outcome: 'cancelled' },
          ip: ctx.ip ?? null,
        },
        tx,
      );
    });
    await this.sessions.revokeAll(user.id);
    return { userId: binToUuid(user.id), cancelled: true as const };
  }

  /**
   * The pilot sub-mark on a test business (the owner's decision, 2026-10-28): its banner then reads "Pilot business —
   * controlled test of Dukan ERP". It changes no other rule; only a test business carries it (a CHECK as well).
   */
  async setPilot(companyUuid: string, isPilot: boolean, reason: string, ctx: TestActor) {
    if (!isUuid(companyUuid)) throw new NotFoundException('Unknown business');
    const companyId = uuidToBin(companyUuid);
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('Say why — the reason is the whole record.');
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, isTest: true, isPilot: true } });
    if (!company) throw new NotFoundException('Unknown business');
    if (isPilot && !company.isTest) {
      await this.refuse(new ForbiddenException({ code: 'pilot_test_business_only', message: 'Only a test business is marked as a pilot.' }), ctx, 'business.pilot_status', { id: company.id, label: company.name });
    }
    if (company.isPilot === isPilot) return { applied: false, isPilot };
    await this.prisma.$transaction(async (tx) => {
      await tx.company.update({ where: { id: companyId }, data: { isPilot } });
      await this.audit.record(
        { admin: ctx.admin, action: 'business.pilot_status', targetType: 'Company', targetId: companyId, targetLabel: company.name, reason: why, before: { isPilot: company.isPilot }, after: { isPilot, outcome: 'applied' }, ip: ctx.ip ?? null },
        tx,
      );
    });
    return { applied: true, isPilot };
  }

  // ── reading ─────────────────────────────────────────────────────────────

  /** Every account whose verification is deferred — one business's, or the platform's. */
  async listDeferred(companyUuid?: string): Promise<(DeferralView & { companyId: string; business: string })[]> {
    const where: Prisma.UserWhereInput = { phoneVerification: 'deferred_by_platform', deletedAt: null };
    if (companyUuid) {
      if (!isUuid(companyUuid)) throw new NotFoundException('Unknown business');
      where.companyId = uuidToBin(companyUuid);
    }
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        companyId: true,
        name: true,
        activatedAt: true,
        company: { select: { name: true } },
        userBranches: { select: { branch: { select: { name: true } }, role: { select: { key: true } } } },
        phoneVerificationDeferrals: { where: { endedAt: null }, take: 1 },
        accountSetupCodes: { orderBy: { createdAt: 'desc' }, take: 1, select: { expiresAt: true, usedAt: true, revokedAt: true } },
      },
    });
    const now = Date.now();
    return rows.map((r) => {
      const d = r.phoneVerificationDeferrals[0];
      const c = r.accountSetupCodes[0];
      const setupCode = !c ? 'none' : c.usedAt ? 'used' : c.revokedAt ? 'revoked' : c.expiresAt.getTime() <= now ? 'expired' : 'active';
      return {
        companyId: binToUuid(r.companyId),
        business: r.company.name,
        userId: binToUuid(r.id),
        name: r.name,
        role: r.userBranches[0]?.role.key ?? null,
        stores: r.userBranches.map((ub) => ub.branch.name),
        phoneVerification: 'deferred_by_platform' as const,
        grantedBy: d?.grantedBy ?? 'unknown',
        grantedAt: d?.grantedAt.toISOString() ?? '',
        reason: d?.reason ?? '',
        reviewAt: d?.reviewAt?.toISOString() ?? null,
        setupCode,
        activated: r.activatedAt !== null,
      };
    });
  }
}
