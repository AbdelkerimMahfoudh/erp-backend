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
  /** The administrator confirms, in this request, that the number stays unverified and nothing WhatsApp works. */
  confirmUnverified: boolean;
  reviewAt?: string | null;
}

export interface ProvisioningActor {
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
 * Accounts a platform superadmin provisions from the console, and the deferred-verification exception (D224, docs/109;
 * amended by the owner 2026-10-29: per ACCOUNT, in an ordinary business). Every condition is the server's; the portal
 * hiding a control decides nothing:
 *
 *  1. a superadmin — every platform administrator is one — whose MFA is enabled;
 *  2. a fresh step-up on THIS session (password and an authenticator code, five minutes);
 *  3. the protected platform routes — tenants, ordinary staff invitations and public registration have no such field,
 *     and the whitelist pipe rejects one sent anyway;
 *  4. the switch `PHONE_VERIFICATION_DEFERRAL=on` (off unless set).
 *
 * The business is an ordinary one: its access, subscription, seats, reports and relationships are untouched. A
 * provisioned person takes a seat like anyone; a store without one is refused, never given one.
 *
 * A deferral never verifies anything: `phone_verified_at` stays null, no WhatsApp consent is recorded, nothing is sent.
 * Every grant, change and refusal is audited, never with a password, code or secret.
 */
@Injectable()
export class AccountProvisioningService {
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

  private async refuse(error: HttpException, ctx: ProvisioningActor, attempted: string, target: { id: Buffer | null; label: string | null }, detail: Record<string, unknown> = {}): Promise<never> {
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
    if (input?.confirmUnverified !== true) {
      throw new BadRequestException({ code: 'deferral_confirmation_required', message: 'Confirm that the number stays unverified.' });
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
   * Every condition of a deferral, the server's (docs/109 §2.3). Refused and audited unless all hold.
   */
  async assertMayDefer(ctx: ProvisioningActor, company: { id: Buffer | null; name: string }, attempted: string): Promise<void> {
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
  }

  // ── an Owner created deferred ───────────────────────────────────────────

  /**
   * The Owner of a business the console just created, deferred: the state, the exception's record and a setup code
   * in one transaction. The Owner's setup invitation (0075) is not issued: this code replaces it.
   */
  async deferOwner(companyUuid: string, deferral: { reason: string; reviewAt: Date | null }, ctx: ProvisioningActor): Promise<{ setupCode: IssuedSetupCode; ownerId: string }> {
    const companyId = uuidToBin(companyUuid);
    const now = new Date();
    const out = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
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

  // ── staff ───────────────────────────────────────────────────────────────

  /**
   * A Manager or an Employee, provisioned by the administrator (docs/109 §2.4) — a provisioning mechanism, not a
   * replacement for the Owner's Team screen. The business's rules all hold: one Owner (never made here), a number and an
   * email unique in the business, roles only from the business, stores only its own and active, and a free seat at each
   * chosen store — counting the people already provisioned there and still waiting. A store without one is REFUSED:
   * capacity is the business's subscription's to give, never the console's.
   *
   * `required`: the account waits, like any invited employee, for the person to verify their number.
   * `deferred_by_platform`: usable once the person spends their setup code.
   */
  async createStaff(
    companyUuid: string,
    input: { name: string; nameAr?: string | null; phone: string; email?: string | null; role: StaffRoleKey; branchIds: string[]; verification: VerificationPolicy; deferral?: DeferralInput },
    ctx: ProvisioningActor,
  ) {
    if (!isUuid(companyUuid)) throw new NotFoundException('Unknown business');
    const companyId = uuidToBin(companyUuid);
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, isActive: true, closedAt: true } });
    if (!company) throw new NotFoundException('Unknown business');
    const target = { id: company.id, label: company.name };
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

    // Seats: the business's own, counted as the activation counts them, with everyone provisioned there and still waiting.
    const seats = await this.entitlement.maySeat(companyId, branchIds);
    const waiting = await this.prisma.userBranch.groupBy({
      by: ['branchId'],
      where: { companyId, branchId: { in: branchIds }, role: { key: { not: 'owner' } }, user: { invitedAt: { not: null }, activatedAt: null, deletedAt: null } },
      _count: { _all: true },
    });
    // The business's whole capacity (each store's included seats and the pooled ones) less the people using or waiting
    // for a seat, and each store's own rule (`maySeat`): a store's seat is never taken from a full store.
    // One seat per person per store, as the census counts them: a Manager waiting at two stores waits for two.
    const pendingTotal = await this.prisma.userBranch.count({ where: { companyId, role: { key: { not: 'owner' } }, branch: { isActive: true, deletedAt: null }, user: { invitedAt: { not: null }, activatedAt: null, deletedAt: null } } });
    const businessFull = seats.seatLimit - seats.seatsUsed - pendingTotal <= 0;
    const full = branches.filter((b) => {
      const line = seats.stores.find((s) => s.branchId === binToUuid(b.id));
      const pending = waiting.find((w) => w.branchId.equals(b.id))?._count._all ?? 0;
      const storeRoom = line ? line.seatLimit - line.seatsUsed - pending : 0;
      return businessFull || seats.full.includes(binToUuid(b.id)) || (storeRoom <= 0 && seats.seatLimit - seats.seatsUsed - pendingTotal <= 0);
    });
    if (full.length > 0) {
      await this.refuse(
        new ConflictException({ code: 'seat_unavailable', message: `No free seat at ${full.map((b) => b.name).join(', ')}. The business adds a seat first.`, stores: full.map((b) => b.name) }),
        ctx,
        'account.create',
        target,
        { stores: full.map((b) => b.name) },
      );
    }

    const userId = newUuidV7Bin();
    const now = new Date();
    const stores = branches.map((b) => b.name);
    let code: (IssuedSetupCode & { replaced: number }) | null = null;
    try {
      code = await this.prisma.$transaction(async (tx) => {
        // Read again inside the write: a business closed meanwhile is refused here as well.
        const still = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { isActive: true, closedAt: true } });
        if (!still.isActive || still.closedAt) throw new ConflictException({ code: 'business_closed', message: 'This business is closed.' });
        await tx.user.create({
          data: {
            id: userId,
            companyId,
            name,
            nameAr: input.nameAr?.trim().slice(0, 160) || null,
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
            reason: deferred ? `Provisioned by the platform; WhatsApp verification deferred: ${deferral!.reason}` : 'Provisioned by the platform; WhatsApp verification required',
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
      select: { id: true, companyId: true, name: true, phoneVerification: true, activatedAt: true, invitedAt: true, company: { select: { name: true } }, userBranches: { select: { role: { select: { key: true } } } } },
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
  async requireVerification(companyUuid: string, userUuid: string, reason: string, ctx: ProvisioningActor) {
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
  async updateDeferral(companyUuid: string, userUuid: string, input: { reason?: string; reviewAt?: string | null }, ctx: ProvisioningActor) {
    const user = await this.personOf(userUuid, companyUuid);
    const live = await this.prisma.phoneVerificationDeferral.findFirst({ where: { userId: user.id, endedAt: null } });
    if (!live) throw new ConflictException({ code: 'not_deferred', message: 'This account’s verification is not deferred.' });
    const next = this.parseDeferral({ reason: input.reason ?? live.reason, confirmUnverified: true, reviewAt: input.reviewAt === undefined ? live.reviewAt?.toISOString() ?? null : input.reviewAt });
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
  async reissueCode(companyUuid: string, userUuid: string, ctx: ProvisioningActor) {
    const user = await this.personOf(userUuid, companyUuid);
    const used = await this.prisma.accountSetupCode.findFirst({ where: { userId: user.id, usedAt: { not: null } }, select: { id: true } });
    if (used) throw new ConflictException({ code: 'already_set_up', message: 'This person already chose their password.' });
    const now = new Date();
    const code = await this.prisma.$transaction((tx) => this.codes.issueTx(tx, { companyId: user.companyId, userId: user.id, issuedBy: ctx.admin.email, now }));
    await this.codes.recordIssue(ctx, { companyId: user.companyId, company: user.company.name, userId: user.id, replaced: Math.max(code.replaced, 1), expiresAt: code.expiresAt });
    const { replaced: _replaced, ...setupCode } = code;
    return { userId: binToUuid(user.id), setupCode };
  }

  async revokeCode(companyUuid: string, userUuid: string, ctx: ProvisioningActor) {
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
   * Cancel a provisioned account: deactivated and soft-deleted like any cancelled account, its
   * contacts released, its sessions and setup code revoked, its deferral ended `cancelled`. Nothing is hard-deleted;
   * whatever it recorded stays, attributed. The Owner is never cancelled here.
   */
  async cancelAccount(companyUuid: string, userUuid: string, reason: string, ctx: ProvisioningActor) {
    const user = await this.personOf(userUuid, companyUuid);
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('Give a reason.');
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
