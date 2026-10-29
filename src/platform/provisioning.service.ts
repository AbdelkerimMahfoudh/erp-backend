import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { isUuid, uuidToBin } from '../common/utils/uuid.util';
import type { Activity } from '../entitlement/activity';
import { WhatsAppRecords, type ConsentState } from '../messaging/whatsapp-records';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformAdminIdentity } from './platform-admin.service';
import { SeatAllocationService, type SeatAllocationView } from './seat-allocation.service';

/** The administrator acting, and from where. */
export interface ProvisioningActor {
  admin: PlatformAdminIdentity;
  ip?: string | null;
}

/** Where an Owner's setup invitation stands (0075): the newest one, or none was ever issued. */
export type InvitationState = 'none' | 'active' | 'expired' | 'accepted' | 'revoked';

/** How the business came to exist: the console, the Owner's own registration, or neither (a seed or a script). */
export type CreatedBy = 'console' | 'self_service' | 'other';

/**
 * Where a business stands on the two separate questions the console asks (D217):
 *
 *  - **provisioning** — is it built, and can its Owner sign in? The business, its first store, its roles and its Owner
 *    are written together by the registration, so a business that exists is built; what remains is the Owner's own
 *    password, set from the setup invitation for a business the console made;
 *  - **activation** — may it work? That is the subscription's decision and the entitlement's state, never this one.
 *
 * Neither implies the other: an Owner may set their password for a business still waiting for access, and a business
 * may be given access before its Owner has signed in.
 */
export interface ProvisioningStatus {
  isTest: boolean;
  testMarkedAt: string | null;
  testMarkedBy: string | null;
  /** The platform's setting, so the console can say why an action is refused. */
  customerActivation: 'open' | 'closed';
  createdBy: CreatedBy;
  provisioning: 'awaiting_owner_setup' | 'ready';
  owner: {
    name: string;
    /** True, false, or null when it cannot be known (a business a script made). Never the password. */
    passwordSet: boolean | null;
    phone: { present: boolean; verified: boolean; verification: 'required' | 'deferred_by_platform' | 'verified'; whatsappConsent: ConsentState | null };
    email: { present: boolean; verified: boolean };
    lastLoginAt: string | null;
  } | null;
  invitation: {
    state: InvitationState;
    issuedAt: string | null;
    issuedBy: string | null;
    expiresAt: string | null;
    acceptedAt: string | null;
    revokedAt: string | null;
  };
  activation: {
    status: string | null;
    complimentaryUntil: string | null;
  };
}

/** The key prefix the console's business creation stores its idempotency key under (`platform.controller.ts`). */
export const CONSOLE_KEY_PREFIX = 'admin:';

/**
 * Platform-superadmin provisioning (D217): test businesses, the customer-activation gate, and stores opened from the
 * console.
 *
 * Every administrator action here was already behind {@link PlatformAdminGuard} (a session with its second factor)
 * and a step-up (the password and a fresh authenticator code, `confirmPassword`); this service adds what the console
 * may do to WHICH business:
 *
 *  - **customer activation** — while it is closed (production's default), the console sets up and gives access to
 *    test businesses only: a customer is activated once the release requirements are met, never from the console
 *    meanwhile;
 *  - **no payment for a test business** — access is an explicit, audited administrative grant, never a payment made
 *    up to unlock it;
 *  - **the test status itself** — set and cleared by an administrator, audited, and refused where it would mix test and
 *    real: a business connected to another, one that has paid, or a test business already in use.
 *
 * A refusal is audited like an action: who tried what, on which business, and the answer.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: PlatformAuditService,
    private readonly seats: SeatAllocationService,
    @Optional() private readonly whatsappRecords?: WhatsAppRecords,
  ) {}

  get activationOpen(): boolean {
    return this.config.customerActivationOpen;
  }

  private companyIdOf(companyUuid: string): Buffer {
    if (!isUuid(companyUuid)) throw new NotFoundException('Unknown business');
    return uuidToBin(companyUuid);
  }

  private async companyOf(companyId: Buffer) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, isTest: true } });
    if (!company) throw new NotFoundException('Unknown business');
    return company;
  }

  /** Record the refusal with what was attempted, then throw it. */
  private async refuse(
    error: HttpException,
    ctx: ProvisioningActor,
    attempted: string,
    target: { id: Buffer | null; label: string | null },
  ): Promise<never> {
    const body = error.getResponse();
    const code = typeof body === 'object' && body !== null && 'code' in body ? String((body as { code: unknown }).code) : String(error.getStatus());
    await this.audit.record({
      admin: ctx.admin,
      action: `${attempted}.refused`,
      targetType: 'Company',
      targetId: target.id,
      targetLabel: target.label,
      reason: code,
      after: { outcome: 'refused', code, status: error.getStatus() },
      ip: ctx.ip ?? null,
    });
    throw error;
  }

  /** Run an action, and audit its refusal if it is refused. */
  private async audited<T>(ctx: ProvisioningActor, attempted: string, target: { id: Buffer | null; label: string | null }, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof HttpException) return this.refuse(e, ctx, attempted, target);
      throw e;
    }
  }

  private activationClosed(): ForbiddenException {
    return new ForbiddenException({
      code: 'customer_activation_closed',
      message: 'Customer activation is closed: for now only a test business can be set up and given access.',
    });
  }

  /** Creating a business: a customer's only while customer activation is open; a test business always. */
  async assertMayCreate(isTest: boolean, ctx: ProvisioningActor, label: string): Promise<void> {
    if (isTest || this.activationOpen) return;
    await this.refuse(this.activationClosed(), ctx, 'business.create', { id: null, label });
  }

  /**
   * An action that sets a business up or gives it access — its Owner's setup invitation, approval, a grant, a period —
   * on a customer's business only while customer activation is open. A test business always may.
   */
  async assertMayActivate(companyUuid: string, attempted: string, ctx: ProvisioningActor): Promise<void> {
    if (this.activationOpen) return;
    const company = await this.companyOf(this.companyIdOf(companyUuid));
    if (company.isTest) return;
    await this.refuse(this.activationClosed(), ctx, attempted, { id: company.id, label: company.name });
  }

  /** A payment, or a payment's confirmation: never for a test business, whose access is a grant. */
  async assertMayTakePayment(companyId: Buffer, attempted: string, ctx: ProvisioningActor): Promise<void> {
    const company = await this.companyOf(companyId);
    if (!company.isTest) return;
    await this.refuse(
      new ForbiddenException({
        code: 'test_business_no_payment',
        message: 'A test business is never paid for. Give it access with an administrative grant instead.',
      }),
      ctx,
      attempted,
      { id: company.id, label: company.name },
    );
  }

  /** Whether an Owner's invitation may be spent: a customer's only while customer activation is open. */
  async mayAcceptInvitation(companyId: Buffer): Promise<boolean> {
    if (this.activationOpen) return true;
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { isTest: true } });
    return company?.isTest === true;
  }

  /**
   * Set or clear a business's test status (D217).
   *
   * Refused where it would mix test and real: a business with any connection to another business (a test business
   * deals only with test businesses, so a connection made under one status must not survive into the other), a
   * business that has paid (it is a customer), and a test business already in use — given access, or its Owner set
   * up — which stays a test business: the customer's own business is created separately.
   */
  async setTestStatus(
    companyUuid: string,
    input: { isTest: boolean; reason: string },
    ctx: ProvisioningActor,
  ): Promise<{ applied: boolean; isTest: boolean }> {
    const companyId = this.companyIdOf(companyUuid);
    const company = await this.companyOf(companyId);
    const target = { id: company.id, label: company.name };
    const reason = (input.reason ?? '').trim();

    return this.audited(ctx, 'business.test_status', target, async () => {
      if (!reason) throw new BadRequestException('Say why — the reason is the whole record.');

      return this.prisma.$transaction(async (tx) => {
        // The company row first: two administrators changing one business are serialised here.
        await tx.$queryRaw(Prisma.sql`SELECT id FROM companies WHERE id = ${companyId} FOR UPDATE`);
        const current = (await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { isTest: true } })).isTest;
        if (current === input.isTest) return { applied: false, isTest: current };

        const [connections, linked] = await Promise.all([
          tx.storeConnection.count({ where: { OR: [{ requesterCompanyId: companyId }, { addresseeCompanyId: companyId }] } }),
          tx.counterparty.count({
            where: { OR: [{ companyId, connectedCompanyId: { not: null } }, { connectedCompanyId: companyId }] },
          }),
        ]);
        if (connections + linked > 0) {
          throw new ConflictException({
            code: 'test_status_connected',
            message: 'This business is connected to another business, so its test status cannot change.',
          });
        }
        if (input.isTest) {
          const payments = await tx.subscriptionPayment.count({ where: { companyId } });
          if (payments > 0) {
            throw new ConflictException({
              code: 'test_status_paid',
              message: 'This business has paid: it is a customer, not a test business.',
            });
          }
        } else {
          const [sub, accepted] = await Promise.all([
            tx.subscription.findFirst({ where: { companyId }, select: { status: true } }),
            tx.ownerInvitation.count({ where: { companyId, acceptedAt: { not: null } } }),
          ]);
          // A platform-provisioned person who chose their password (0109) has used the business as surely.
          const setUp = await tx.accountSetupCode.count({ where: { companyId, usedAt: { not: null } } });
          if ((sub && sub.status !== 'pending_activation') || accepted > 0 || setUp > 0) {
            throw new ConflictException({
              code: 'test_status_in_use',
              message: 'This test business has been used, so it stays a test business. Create the customer’s business separately.',
            });
          }
        }

        const now = new Date();
        await tx.company.update({
          where: { id: companyId },
          data: { isTest: input.isTest, testMarkedAt: now, testMarkedBy: ctx.admin.email.slice(0, 160) },
        });
        await this.audit.record(
          {
            admin: ctx.admin,
            action: 'business.test_status',
            targetType: 'Company',
            targetId: companyId,
            targetLabel: company.name,
            reason,
            before: { isTest: current },
            after: { isTest: input.isTest, outcome: 'applied' },
            ip: ctx.ip ?? null,
            at: now,
          },
          tx,
        );
        return { applied: true, isTest: input.isTest };
      });
    });
  }

  /**
   * A store for a business, from the console (the owner's decision of 2026-10-20):
   *
   *  - a **test business** holding an administrative grant: opened at once, at no charge, as part of that grant
   *    ({@link SeatAllocationService.grantStore}), recorded on its timeline and audited;
   *  - a **customer's business**: the priced request its Owner would file ({@link SeatAllocationService.requestStore}),
   *    awaiting payment; the store opens only when a real payment is confirmed.
   *
   * The same name again answers with the store or the request that already exists: a retry opens nothing twice.
   */
  async openStore(
    companyUuid: string,
    input: { name: string; activity?: Activity | null; reason: string },
    ctx: ProvisioningActor,
  ): Promise<{ mode: 'granted' | 'requested'; allocation: SeatAllocationView; created: boolean }> {
    const companyId = this.companyIdOf(companyUuid);
    const company = await this.companyOf(companyId);
    const target = { id: company.id, label: company.name };
    const reason = (input.reason ?? '').trim();

    return this.audited(ctx, 'business.store', target, async () => {
      if (!reason) throw new BadRequestException('Say why — the reason is the whole record.');
      const by = ctx.admin.email;
      const mode = company.isTest ? ('granted' as const) : ('requested' as const);
      const result = company.isTest
        ? await this.seats.grantStore(companyId, { name: input.name, activity: input.activity, reason, by })
        : await this.seats.requestStore(companyId, { name: input.name, activity: input.activity, requestedBy: by });
      if (result.created) {
        await this.audit.record({
          admin: ctx.admin,
          action: company.isTest ? 'business.store_grant' : 'business.store_request',
          targetType: 'Company',
          targetId: companyId,
          targetLabel: company.name,
          reason,
          after: {
            store: result.allocation.label,
            activity: result.allocation.activityTo,
            status: result.allocation.status,
            monthlyAmount: result.allocation.monthlyAmount,
            outcome: 'applied',
          },
          ip: ctx.ip ?? null,
        });
      }
      return { mode, ...result };
    });
  }

  /** Where the business stands: its provisioning and its activation, separately (D217). Never a credential. */
  async status(companyId: Buffer): Promise<ProvisioningStatus> {
    const [company, attempt, owner, invitation, sub] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { isTest: true, testMarkedAt: true, testMarkedBy: true },
      }),
      this.prisma.registrationAttempt.findFirst({ where: { companyId }, select: { idempotencyKey: true } }),
      // The Owner is the account the business was created with.
      this.prisma.user.findFirst({
        where: { companyId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, email: true, phone: true, emailVerifiedAt: true, phoneVerifiedAt: true, phoneVerification: true, lastLoginAt: true },
      }),
      this.prisma.ownerInvitation.findFirst({
        where: { companyId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { issuedBy: true, createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true },
      }),
      this.prisma.subscription.findFirst({ where: { companyId }, select: { status: true, isComplimentary: true, complimentaryUntil: true } }),
    ]);

    const createdBy: CreatedBy = !attempt ? 'other' : attempt.idempotencyKey.startsWith(CONSOLE_KEY_PREFIX) ? 'console' : 'self_service';
    const accepted = owner
      ? (await this.prisma.ownerInvitation.count({ where: { companyId, userId: owner.id, acceptedAt: { not: null } } })) +
          (await this.prisma.accountSetupCode.count({ where: { companyId, userId: owner.id, usedAt: { not: null } } })) >
        0
      : false;
    const passwordSet = createdBy === 'console' ? accepted : createdBy === 'self_service' ? true : accepted ? true : null;

    const now = Date.now();
    const state: InvitationState = !invitation
      ? 'none'
      : invitation.acceptedAt
        ? 'accepted'
        : invitation.revokedAt
          ? 'revoked'
          : invitation.expiresAt.getTime() <= now
            ? 'expired'
            : 'active';

    const consent = owner?.phone && this.whatsappRecords ? (await this.whatsappRecords.contactState(owner.phone)).consent : null;

    return {
      isTest: company.isTest,
      testMarkedAt: company.testMarkedAt?.toISOString() ?? null,
      testMarkedBy: company.testMarkedBy,
      customerActivation: this.activationOpen ? 'open' : 'closed',
      createdBy,
      provisioning: passwordSet === false ? 'awaiting_owner_setup' : 'ready',
      owner: owner
        ? {
            name: owner.name,
            passwordSet,
            phone: {
              present: owner.phone !== null,
              verified: owner.phoneVerifiedAt !== null,
              /** D224: `deferred_by_platform` is NOT verified — the number was never proved. */
              verification: owner.phoneVerification as 'required' | 'deferred_by_platform' | 'verified',
              whatsappConsent: consent,
            },
            email: { present: owner.email !== null, verified: owner.emailVerifiedAt !== null },
            lastLoginAt: owner.lastLoginAt?.toISOString() ?? null,
          }
        : null,
      invitation: {
        state,
        issuedAt: invitation?.createdAt.toISOString() ?? null,
        issuedBy: invitation?.issuedBy ?? null,
        expiresAt: invitation?.expiresAt.toISOString() ?? null,
        acceptedAt: invitation?.acceptedAt?.toISOString() ?? null,
        revokedAt: invitation?.revokedAt?.toISOString() ?? null,
      },
      activation: {
        status: sub?.status ?? null,
        complimentaryUntil: sub?.isComplimentary ? (sub.complimentaryUntil?.toISOString() ?? null) : null,
      },
    };
  }
}
