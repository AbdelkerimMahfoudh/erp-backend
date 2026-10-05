import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type ContactChannel } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';

/** The audit helper is typed for the tenant client; the system client's transaction has the same `auditLog` table. */
type AuditClient = Parameters<AuditService['recordTx']>[0];
import { HashingService } from '../common/security/hashing.service';
import { generatePersonalId, isEmail, normaliseEmail, normalisePhone } from '../auth/identifier';
import { newUuidV7Bin, binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { ContactVerificationService } from '../platform/contact-verification.service';
import { ContactDeliveryProvider, codeMayBeReturned, OutboxDeliveryProvider } from '../platform/contact-delivery';
import { EntitlementService } from '../entitlement/entitlement.service';
import {
  StaffActivationService,
  type ActivationOutcome,
  type PendingReason,
} from '../platform/staff-activation.service';
import { SeatAllocationService } from '../platform/seat-allocation.service';
import type { CreateStaffDto, StaffRole } from './dto/staff.dto';

/**
 * Employee accounts, from the Owner's Team screen (docs/21, 2026-10-05).
 *
 * Creating an account and the account becoming usable are two different
 * events, and this file keeps them apart on purpose:
 *
 *  - **Created** means a row exists with `invited_at` set, `is_active = 0` and
 *    an unguessable placeholder password nobody knows. It cannot sign in, by
 *    any client, old or new, because sign-in refuses inactive accounts before
 *    it looks at the password.
 *  - **Usable** means the server activated it (`StaffActivationService`): the
 *    person proved every contact the Owner selected and a seat is held for
 *    them at each store.
 *
 * Codes go out through the configured delivery provider. When a channel cannot
 * deliver, the account is still created and the response says plainly that no
 * code could be sent — nobody is shown a code that would never arrive, and the
 * Owner can send it again once delivery exists.
 */

export type DeliveryState = 'sent' | 'unavailable';

export interface StaffSeatState {
  storeId: string;
  store: string;
  /** `included`: a free seat; `held`: a seat paid or granted for this person; `awaiting_payment`: a request the server priced. */
  state: 'included' | 'held' | 'awaiting_payment';
}

export interface StaffInvitationResult {
  created: boolean;
  user: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    status: 'pending';
    stores: { id: string; name: string; role: StaffRole }[];
  };
  verification: { email: DeliveryState | null; phone: DeliveryState | null };
  seats: StaffSeatState[];
  activation: ActivationOutcome;
  /**
   * Local development only (`codeMayBeReturned`): the codes the outbox holds,
   * so a developer can finish the flow on one machine. Never in staging or
   * production, where the function is false whatever else is set.
   */
  devCodes?: { email?: string; phone?: string };
}

export interface StaffConfirmResult {
  verified: true;
  accounts: {
    business: string;
    name: string;
    activated: boolean;
    pending: PendingReason[];
  }[];
}

const GENERIC_CODE_FAILURE = () => new BadRequestException('That code did not match.');

@Injectable()
export class StaffInvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly hashing: HashingService,
    private readonly verification: ContactVerificationService,
    private readonly delivery: ContactDeliveryProvider,
    private readonly outbox: OutboxDeliveryProvider,
    private readonly entitlement: EntitlementService,
    private readonly activation: StaffActivationService,
    private readonly allocations: SeatAllocationService,
  ) {}

  // ── the Owner creates an account ─────────────────────────────────────────

  async invite(dto: CreateStaffDto): Promise<StaffInvitationResult> {
    const companyId = this.tenant.companyId();
    const actorId = this.tenant.requireUserId();
    const actor = await this.prisma.user.findUniqueOrThrow({
      where: { id: actorId },
      select: { name: true, email: true, phone: true },
    });
    const actorLabel = actor.email ?? actor.phone ?? actor.name;

    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the person a name.');

    const email = dto.email?.trim() ? normaliseEmail(dto.email.trim()) : null;
    if (dto.email?.trim() && (!email || !isEmail(dto.email.trim()))) {
      throw new BadRequestException('That does not look like an email address.');
    }
    const phone = dto.phone?.trim() ? normalisePhone(dto.phone.trim()) : null;
    if (dto.phone?.trim() && !phone) throw new BadRequestException('That does not look like a WhatsApp number.');
    if (!email && !phone) {
      throw new BadRequestException({
        code: 'contact_required',
        message:
          'Give an email address, a WhatsApp number, or both — it is how the person signs in and proves it is them.',
      });
    }

    const branchIds = [...new Set(dto.branchIds)].map((id) => uuidToBin(id));
    const branches = await this.prisma.branch.findMany({
      where: {
        id: { in: branchIds },
        companyId,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true, name: true },
    });
    if (branches.length !== branchIds.length) throw new NotFoundException('Unknown store');

    const role = await this.prisma.role.findFirst({
      where: { companyId, key: dto.role },
      select: { id: true },
    });
    if (!role) throw new BadRequestException('That role does not exist in this business.');

    // The same person, asked for twice: the pending account already there is the answer.
    const existing = await this.prisma.user.findFirst({
      where: {
        companyId,
        deletedAt: null,
        OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])],
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        invitedAt: true,
        activatedAt: true,
      },
    });
    if (existing) {
      if (existing.activatedAt !== null || existing.invitedAt === null) {
        throw new ConflictException({
          code: 'contact_in_use',
          message: 'Somebody on your team already uses that email address or number.',
        });
      }
      const verification = await this.deliverCodes(existing, dto.language ?? 'en');
      return this.describe(existing.id, false, verification);
    }

    const userId = newUuidV7Bin();
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: userId,
            companyId,
            name: name.slice(0, 160),
            // An internal handle only. Never typed to sign in, never shown. The
            // RANDOM half of the id: the first characters of a UUIDv7 are the
            // clock, and two accounts created in the same hour would share them.
            login: `staff-${binToUuid(userId).slice(-12)}`,
            email,
            phone,
            personalId: generatePersonalId(),
            // Unknown to everybody, including us. The person chooses theirs when they prove a contact.
            passwordHash: await this.hashing.hash(randomBytes(32).toString('base64url')),
            isActive: false,
            invitedAt: now,
            activatedAt: null,
          },
        });
        for (const branch of branches) {
          await tx.userBranch.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              userId,
              branchId: branch.id,
              roleId: role.id,
            },
          });
        }
        await this.audit.recordTx(tx as unknown as AuditClient, {
          entityType: 'User',
          entityId: userId,
          action: 'create',
          after: {
            name,
            email,
            phone,
            role: dto.role,
            stores: branches.map((b) => b.name),
            status: 'pending',
            invitedBy: actorLabel,
          },
        });
      });
    } catch (e) {
      // Two Owners adding the same contact at the same instant: the database's
      // per-company unique index is the referee, and the loser is told plainly.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          code: 'contact_in_use',
          message: 'Somebody on your team already uses that email address or number.',
        });
      }
      throw e;
    }

    // A store with no free seat: the server prices one now, and the account waits for payment.
    const seats = await this.entitlement.maySeat(
      companyId,
      branches.map((b) => b.id),
    );
    for (const branch of branches) {
      if (seats.full.includes(binToUuid(branch.id))) {
        await this.allocations.requestSeat(companyId, {
          branchId: branch.id,
          userId,
          requestedBy: actorLabel,
          note: `Requested when ${name} was added to the team.`,
        });
      }
    }

    const verification = await this.deliverCodes({ id: userId, email, phone }, dto.language ?? 'en');
    return this.describe(userId, true, verification);
  }

  /** The Owner asks for the code to go out again. */
  async resend(
    userId: string,
    channel: 'email' | 'phone',
    language: 'en' | 'ar' | 'fr' = 'en',
  ): Promise<{ delivery: DeliveryState }> {
    const companyId = this.tenant.companyId();
    const user = await this.pendingInCompany(companyId, userId);
    const destination = channel === 'email' ? user.email : user.phone;
    if (!destination)
      throw new BadRequestException(
        `This account has no ${channel === 'email' ? 'email address' : 'WhatsApp number'} to send to.`,
      );
    if (!this.delivery.canDeliver(channel)) {
      throw new ServiceUnavailableException({
        code: 'delivery_unavailable',
        message:
          'No verification code can be sent right now: the message channel is not configured. The account stays pending.',
      });
    }
    await this.verification.start(destination, language);
    return { delivery: 'sent' };
  }

  /**
   * The Owner withdraws an account that was never activated.
   *
   * Soft-deleted, like every account: the row and its audit trail stay, the
   * contact becomes available again, and any seat request it caused is
   * withdrawn with it.
   */
  async cancel(userId: string): Promise<{ cancelled: true }> {
    const companyId = this.tenant.companyId();
    const user = await this.pendingInCompany(companyId, userId);
    const actorId = this.tenant.requireUserId();
    const actor = await this.prisma.user.findUniqueOrThrow({
      where: { id: actorId },
      select: { name: true, email: true, phone: true },
    });
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // The contact is released with the account: it was never activated and
      // holds no history, and the per-company unique index would otherwise
      // keep the same person from being invited again.
      await tx.user.update({
        where: { id: user.id },
        data: {
          deletedAt: now,
          isActive: false,
          email: null,
          phone: null,
          emailVerifiedAt: null,
          phoneVerifiedAt: null,
        },
      });
      await this.audit.recordTx(tx as unknown as AuditClient, {
        entityType: 'User',
        entityId: user.id,
        action: 'status_change',
        before: { status: 'pending', email: user.email, phone: user.phone },
        after: { status: 'cancelled', deletedAt: now.toISOString() },
      });
    });

    const requests = await this.prisma.seatAllocation.findMany({
      where: { companyId, userId: user.id, status: 'pending_payment' },
      select: { id: true },
    });
    for (const r of requests) {
      await this.allocations.withdraw(companyId, r.id, actor.email ?? actor.phone ?? actor.name);
    }
    return { cancelled: true };
  }

  // ── the person proves a contact ──────────────────────────────────────────

  /**
   * Prove one contact with its code, and choose a password the first time.
   *
   * The code is checked against the live challenge for the destination WITHOUT
   * consuming it first, so a person who forgot the password field is told so
   * and keeps their code. Then, in one transaction, the challenge is consumed,
   * the contact marked verified and the password set — after which the server
   * decides whether the account may be activated.
   *
   * Public, and shaped not to enumerate: an unknown destination, a wrong code
   * and an expired one all answer the same way.
   */
  async confirm(rawDestination: string, code: string, password?: string): Promise<StaffConfirmResult> {
    const destination = classify(rawDestination);
    if (!destination) throw GENERIC_CODE_FAILURE();

    const challengeId = await this.verification.latestChallengeFor(destination.value);
    if (!challengeId) throw GENERIC_CODE_FAILURE();
    const outcome = await this.verification.confirmChallenge(challengeId, code);
    if (outcome !== 'ok') throw GENERIC_CODE_FAILURE();

    const pending = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        activatedAt: null,
        invitedAt: { not: null },
        ...(destination.channel === 'email' ? { email: destination.value } : { phone: destination.value }),
      },
      select: {
        id: true,
        name: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        company: { select: { name: true } },
      },
    });
    if (pending.length === 0) throw GENERIC_CODE_FAILURE();

    const needsPassword = pending.some((u) => !u.emailVerifiedAt && !u.phoneVerifiedAt);
    if (needsPassword && !password) {
      throw new BadRequestException({
        code: 'password_required',
        message: 'Choose a password to finish setting up your account.',
      });
    }

    const now = new Date();
    const passwordHash = password ? await this.hashing.hash(password) : null;
    await this.prisma.$transaction(async (tx) => {
      // Consume exactly this challenge; a second submission of the same code is a miss.
      const consumed = await tx.contactVerification.updateMany({
        where: { id: challengeId, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw GENERIC_CODE_FAILURE();
      for (const u of pending) {
        const first = !u.emailVerifiedAt && !u.phoneVerifiedAt;
        await tx.user.update({
          where: { id: u.id },
          data: {
            ...(destination.channel === 'email' ? { emailVerifiedAt: now } : { phoneVerifiedAt: now }),
            ...(first && passwordHash ? { passwordHash } : {}),
          },
        });
      }
    });

    const accounts: StaffConfirmResult['accounts'] = [];
    for (const u of pending) {
      const result = await this.activation.tryActivate(u.id, destination.value);
      accounts.push({
        business: u.company.name,
        name: u.name,
        activated: result.activated,
        pending: result.pending,
      });
    }
    return { verified: true, accounts };
  }

  /**
   * The person asks for their code again.
   *
   * Non-enumerating: while the channel can deliver, every destination answers
   * `accepted` whether or not an account is waiting; while it cannot, every
   * destination answers that delivery is unavailable. The answer never depends
   * on the account.
   */
  async resendPublic(rawDestination: string, language: 'en' | 'ar' | 'fr' = 'en'): Promise<{ accepted: true }> {
    const destination = classify(rawDestination);
    if (!destination)
      throw new BadRequestException('Enter the email address or WhatsApp number the invitation was sent to.');
    if (!this.delivery.canDeliver(destination.channel)) {
      throw new ServiceUnavailableException({
        code: 'delivery_unavailable',
        message: 'No verification code can be sent right now. Ask the business Owner to try again later.',
      });
    }
    const waiting = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        activatedAt: null,
        invitedAt: { not: null },
        ...(destination.channel === 'email' ? { email: destination.value } : { phone: destination.value }),
      },
      select: { id: true },
    });
    if (waiting) await this.verification.start(destination.value, language);
    return { accepted: true };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async pendingInCompany(companyId: Buffer, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: uuidToBin(userId), companyId, deletedAt: null },
      select: {
        id: true,
        email: true,
        phone: true,
        invitedAt: true,
        activatedAt: true,
      },
    });
    if (!user) throw new NotFoundException('Unknown user');
    if (user.activatedAt !== null || user.invitedAt === null) {
      throw new BadRequestException({
        code: 'not_pending',
        message: 'This account is already active.',
      });
    }
    return user;
  }

  /** Send a code on every selected channel that can deliver; say which could not. */
  private async deliverCodes(
    user: { id: Buffer; email: string | null; phone: string | null },
    language: 'en' | 'ar' | 'fr',
  ): Promise<{
    states: { email: DeliveryState | null; phone: DeliveryState | null };
    devCodes?: { email?: string; phone?: string };
  }> {
    const states: { email: DeliveryState | null; phone: DeliveryState | null } = { email: null, phone: null };
    const devCodes: { email?: string; phone?: string } = {};
    for (const channel of ['email', 'phone'] as const) {
      const destination = channel === 'email' ? user.email : user.phone;
      if (!destination) continue;
      if (!this.delivery.canDeliver(channel as ContactChannel)) {
        states[channel] = 'unavailable';
        continue;
      }
      const result = await this.verification.start(destination, language);
      states[channel] = 'sent';
      if (codeMayBeReturned() && result.delivery === 'outbox') {
        const code = this.outbox.peek(destination);
        if (code) devCodes[channel] = code;
      }
    }
    return {
      states,
      devCodes: Object.keys(devCodes).length ? devCodes : undefined,
    };
  }

  private async describe(
    userId: Buffer,
    created: boolean,
    verification: {
      states: { email: DeliveryState | null; phone: DeliveryState | null };
      devCodes?: { email?: string; phone?: string };
    },
  ): Promise<StaffInvitationResult> {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        userBranches: {
          select: {
            branch: { select: { id: true, name: true } },
            role: { select: { key: true } },
          },
        },
        seatAllocations: {
          where: {
            kind: 'seat',
            status: { in: ['pending_payment', 'paid', 'granted'] },
          },
          select: { branchId: true, status: true },
        },
      },
    });
    const activation = await this.activation.pendingFor(userId);
    const seats: StaffSeatState[] = row.userBranches.map((ub) => {
      const own = row.seatAllocations.find((a) => a.branchId !== null && a.branchId.equals(ub.branch.id));
      return {
        storeId: binToUuid(ub.branch.id),
        store: ub.branch.name,
        state: own ? (own.status === 'pending_payment' ? 'awaiting_payment' : 'held') : 'included',
      };
    });
    return {
      created,
      user: {
        id: binToUuid(row.id),
        name: row.name,
        email: row.email,
        phone: row.phone,
        status: 'pending',
        stores: row.userBranches.map((ub) => ({
          id: binToUuid(ub.branch.id),
          name: ub.branch.name,
          role: ub.role.key as StaffRole,
        })),
      },
      verification: verification.states,
      seats,
      activation,
      ...(verification.devCodes ? { devCodes: verification.devCodes } : {}),
    };
  }
}

/** Normalise a destination and say which channel it is; null when it is neither. */
function classify(raw: string): { channel: ContactChannel; value: string } | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) {
    if (!isEmail(trimmed)) return null;
    return { channel: 'email', value: normaliseEmail(trimmed) };
  }
  const phone = normalisePhone(trimmed);
  return phone ? { channel: 'phone', value: phone } : null;
}
