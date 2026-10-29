import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../common/config/app-config.service';

/** The audit helper is typed for the tenant client; the system client's transaction has the same `auditLog` table. */
type AuditClient = Parameters<AuditService['recordTx']>[0];
import { HashingService } from '../common/security/hashing.service';
import { generatePersonalId, isEmail, normaliseEmail, normalisePhone } from '../auth/identifier';
import { newUuidV7Bin, binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { actorRef, contactPresence } from '../common/privacy/audit-contact';
import { ContactVerificationService } from '../platform/contact-verification.service';
import { ContactDeliveryProvider } from '../platform/contact-delivery';
import { EntitlementService } from '../entitlement/entitlement.service';
import {
  StaffActivationService,
  type ActivationOutcome,
  type PendingReason,
} from '../platform/staff-activation.service';
import { SeatAllocationService } from '../platform/seat-allocation.service';
import type { CreateStaffDto, StaffRole } from './dto/staff.dto';
import { WhatsAppRecords } from '../messaging/whatsapp-records';
import { acceptedConsentVersion, consentLocaleOf } from '../messaging/whatsapp-consent';
import { formatReference, joinLink, newReference, normaliseReference, referenceHash, STAFF_INVITATION_TTL_MS } from './invitation-reference';

/**
 * Employee accounts, from the Owner's Team screen (docs/21, 2026-10-05; D213, D214).
 *
 * Creating an account and the account becoming usable are two different
 * events, and this file keeps them apart on purpose:
 *
 *  - **Created** means a row exists with `invited_at` set, `is_active = 0` and
 *    an unguessable placeholder password nobody knows. It cannot sign in, by
 *    any client, old or new, because sign-in refuses inactive accounts before
 *    it looks at the password.
 *  - **Usable** means the server activated it (`StaffActivationService`): the
 *    person proved their WhatsApp number and a seat is held for them at each
 *    store.
 *
 * Creating an account sends nothing — no WhatsApp, no email (D214). The server
 * issues an invitation (`staff_invitations`, 0101): a reference the Owner is
 * shown once and passes on themselves. The employee opens it in the app, types
 * their number, accepts the operational WhatsApp consent and asks for the code;
 * the agreement is theirs, recorded with them as the actor, pending until the
 * code proves the number. Confirming the code activates the consent, uses the
 * invitation and activates the account in one transaction. Cancelling the
 * account or issuing a new invitation ends the old invitation and its pending
 * agreement.
 *
 * The employee's routes are public and answer every unusable reference — unknown,
 * expired, revoked, used — the same way, so they tell nobody whether a business,
 * a person or a number exists.
 */

/** An invitation as issued: the reference shown to the Owner once — never stored, never logged — and its link. */
export interface IssuedInvitation {
  reference: string;
  link: string;
  expiresAt: string;
}

export interface StaffSeatState {
  storeId: string;
  store: string;
  /**
   * `included`: a free seat; `held`: a seat paid or granted for this person — or paid during the free trial and starting
   * when it ends (D176); `awaiting_payment`: a request the server priced.
   */
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
  /** Issued by this request, shown once. Null when the person was already waiting: a new one is the Owner's explicit act. */
  invitation: IssuedInvitation | null;
  seats: StaffSeatState[];
  activation: ActivationOutcome;
}

/** What an employee sees on opening a usable invitation: enough to recognise it, never the number. */
export interface OpenedInvitation {
  business: string;
  name: string;
  /** The last two digits of the number the Owner entered — a hint, not the number. */
  numberEnding: string;
  expiresAt: string;
}

export interface JoinConfirmResult {
  verified: true;
  business: string;
  name: string;
  activated: boolean;
  pending: PendingReason[];
}

const invitationUnavailable = () =>
  new BadRequestException({
    code: 'invitation_unavailable',
    message: 'This invitation cannot be used. Ask your business Owner for a new one.',
  });
const codeFailure = () => new BadRequestException({ code: 'code_mismatch', message: 'That code did not match.' });

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class StaffInvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly hashing: HashingService,
    private readonly verification: ContactVerificationService,
    private readonly delivery: ContactDeliveryProvider,
    private readonly entitlement: EntitlementService,
    private readonly activation: StaffActivationService,
    private readonly allocations: SeatAllocationService,
    private readonly config: AppConfigService,
    @Optional() private readonly whatsappRecords?: WhatsAppRecords,
  ) {}

  // ── the Owner creates an account ─────────────────────────────────────────

  async invite(dto: CreateStaffDto): Promise<StaffInvitationResult> {
    const companyId = this.tenant.companyId();
    const actorId = this.tenant.requireUserId();
    await this.prisma.user.findUniqueOrThrow({ where: { id: actorId }, select: { id: true } });
    // The Owner's account, never their email or number: the seat request and the audit outlive a deletion.
    const actorLabel = actorRef(binToUuid(this.tenant.requireUserId()));

    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the person a name.');

    const email = dto.email?.trim() ? normaliseEmail(dto.email.trim()) : null;
    if (dto.email?.trim() && (!email || !isEmail(dto.email.trim()))) {
      throw new BadRequestException('That does not look like an email address.');
    }
    // The WhatsApp number is every employee's required contact (D214); the email address is optional.
    const phone = dto.phone?.trim() ? normalisePhone(dto.phone.trim()) : null;
    if (dto.phone?.trim() && !phone) throw new BadRequestException('That does not look like a WhatsApp number.');
    if (!phone) {
      throw new BadRequestException({
        code: 'whatsapp_required',
        message: 'Give the person’s WhatsApp number: it is how they activate their account and sign in.',
      });
    }
    const key = this.invitationKey();

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
      // Nothing is sent and no reference is issued again: a new invitation is the Owner's explicit act.
      return this.describe(existing.id, false, null);
    }

    const userId = newUuidV7Bin();
    const now = new Date();
    let issued: IssuedInvitation | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: userId,
            companyId,
            name: name.slice(0, 160),
            nameAr: dto.nameAr?.slice(0, 160) || null,
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
            email: contactPresence(email),
            phone: contactPresence(phone),
            role: dto.role,
            stores: branches.map((b) => b.name),
            status: 'pending',
            invitedBy: actorLabel,
          },
        });
        issued = await this.issue(tx, key, companyId, userId, actorLabel, now);
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

    // A store with no free seat: the server prices one now, and the account waits for payment — unless a seat bought
    // for that store during the free trial, held by nobody, will seat this person when the trial ends (D176 §8).
    const seats = await this.entitlement.maySeat(
      companyId,
      branches.map((b) => b.id),
    );
    for (const branch of branches) {
      if (seats.full.includes(binToUuid(branch.id)) && !(await this.activation.coveredByScheduledSeat(userId, branch.id))) {
        await this.allocations.requestSeat(companyId, {
          branchId: branch.id,
          userId,
          requestedBy: actorLabel,
          note: `Requested when ${name} was added to the team.`,
        });
      }
    }

    return this.describe(userId, true, issued);
  }

  /**
   * A new invitation for a person still waiting — the Owner lost the reference, it expired, or the person never had one
   * (an account from before 0101). The live one, if any, is revoked and its pending agreement concluded `cancelled`, in
   * the same transaction that issues the new one. Its reference is shown once.
   */
  async reinvite(userId: string): Promise<{ invitation: IssuedInvitation }> {
    const companyId = this.tenant.companyId();
    const user = await this.pendingInCompany(companyId, userId);
    if (!user.phone) {
      throw new BadRequestException({
        code: 'whatsapp_required',
        message: 'This account has no WhatsApp number. Cancel it and add the person again with their number.',
      });
    }
    const key = this.invitationKey();
    const actorId = this.tenant.requireUserId();
    const actorLabel = actorRef(binToUuid(actorId));
    const now = new Date();
    let issued: IssuedInvitation | null = null;
    await this.prisma.$transaction(async (tx) => {
      await this.endLive(tx, companyId, user.id, actorId, 'reinvited', now);
      await this.lockStillPending(tx, user.id);
      issued = await this.issue(tx, key, companyId, user.id, actorLabel, now);
    });
    return { invitation: issued! };
  }

  /**
   * The Owner withdraws an account that was never activated.
   *
   * Soft-deleted, like every account: the row and its audit trail stay, the
   * contact becomes available again, and any seat request it caused is
   * withdrawn with it. Its invitation is revoked and the pending agreement it
   * carried is concluded `cancelled` — in the same transaction.
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
      await this.endLive(tx, companyId, user.id, actorId, 'cancelled', now);
      // The employee may have confirmed their code a moment ago: an activated account is never withdrawn as an invitation.
      await this.lockStillPending(tx, user.id);
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
        before: { status: 'pending', email: contactPresence(user.email), phone: contactPresence(user.phone) },
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

  // ── the employee activates their account ─────────────────────────────────

  /** The employee opens an invitation: whose it is, and a hint of the number — or the one answer for every unusable reference. */
  async open(reference: string): Promise<OpenedInvitation> {
    const invitation = await this.usable(this.prisma, reference, new Date());
    return {
      business: invitation.company.name,
      name: invitation.user.name,
      numberEnding: invitation.user.phone!.slice(-2),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * The employee typed their number, ticked the operational WhatsApp consent and asked for the code.
   *
   * Only now is the agreement recorded — `pending_unverified`, the employee as the actor — and bound to the invitation,
   * and the code sent. Asking again sends a new code under the SAME pending agreement while it and the invitation are
   * both still valid; an agreement that expired (24 hours) inside the invitation's 72 is accepted again as a new one.
   */
  async requestCode(
    reference: string,
    typedNumber: string,
    language: 'en' | 'ar' | 'fr' = 'en',
    consent: { version?: string; locale?: string } = {},
    ip: string | null = null,
  ): Promise<{ accepted: true; devCode?: string }> {
    const version = acceptedConsentVersion(consent.version);
    const number = normalisePhone((typedNumber ?? '').trim());
    if (!number) throw new BadRequestException({ code: 'number_invalid', message: 'That does not look like a WhatsApp number.' });
    const now = new Date();
    const invitation = await this.usable(this.prisma, reference, now);
    if (number !== invitation.user.phone) {
      throw new BadRequestException({
        code: 'number_mismatch',
        message: 'That is not the WhatsApp number your business Owner entered for this invitation.',
      });
    }
    if (!this.whatsappRecords || !this.delivery.canDeliver('phone', number)) {
      throw new ServiceUnavailableException({
        code: 'delivery_unavailable',
        message: 'No verification code can be sent right now. Try again later.',
      });
    }
    const records = this.whatsappRecords;
    await this.prisma.$transaction(async (tx) => {
      // The invitation first, then the number's consent (inside `pending`): the order every path here takes.
      const locked = await this.lockLive(tx, invitation.id, now);
      if (locked.pendingConsentId && (await records.pendingIsLive(locked.pendingConsentId, now, tx))) return;
      const written = await records.pending(
        {
          number,
          version,
          locale: consentLocaleOf(consent.locale, language),
          companyId: invitation.companyId,
          userId: invitation.userId,
          source: 'employee_activation',
          ip,
        },
        tx,
      );
      await tx.staffInvitation.update({ where: { id: invitation.id }, data: { pendingConsentId: written.pendingId } });
    });
    const sent = await this.verification.start(number, language);
    return { accepted: true, ...(sent.devCode ? { devCode: sent.devCode } : {}) };
  }

  /**
   * The code and a first password. In one transaction: the code consumed, the number verified, the password set, the
   * invitation's exact pending agreement activated, the invitation used and — when a seat is held — the account
   * activated. Anything failing leaves all of it as it was. Only this invitation's account is touched: the same number
   * invited by another business is that business's, activated by its own invitation.
   */
  async confirm(reference: string, code: string, password?: string): Promise<JoinConfirmResult> {
    const now = new Date();
    const invitation = await this.usable(this.prisma, reference, now);
    const number = invitation.user.phone!;
    if (!invitation.pendingConsentId) throw codeFailure();

    const challengeId = await this.verification.latestChallengeFor(number);
    if (!challengeId) throw codeFailure();
    if ((await this.verification.confirmChallenge(challengeId, code)) !== 'ok') throw codeFailure();

    const first = !invitation.user.emailVerifiedAt && !invitation.user.phoneVerifiedAt;
    if (first && !password) {
      throw new BadRequestException({ code: 'password_required', message: 'Choose a password to finish setting up your account.' });
    }
    const passwordHash = first && password ? await this.hashing.hash(password) : null;
    const records = this.whatsappRecords;
    if (!records) throw new ServiceUnavailableException({ code: 'delivery_unavailable', message: 'The account cannot be activated right now.' });
    const actor = actorRef(binToUuid(invitation.userId));

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Lock order, the same on every path: the company's subscription (the seat census), the invitation, the number.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM subscriptions WHERE company_id = ${invitation.companyId} FOR UPDATE`);
      const locked = await this.lockLive(tx, invitation.id, now);
      if (!locked.pendingConsentId) throw codeFailure();
      const consumed = await tx.contactVerification.updateMany({ where: { id: challengeId, consumedAt: null }, data: { consumedAt: now } });
      if (consumed.count !== 1) throw codeFailure();
      const consent = await records.activatePending(
        { number, userId: invitation.userId, companyId: invitation.companyId, pendingId: locked.pendingConsentId },
        tx,
      );
      if (consent !== 'activated') {
        throw new BadRequestException({
          code: 'consent_expired',
          message: 'Your agreement to WhatsApp messages expired. Accept it again and ask for a new code.',
        });
      }
      await tx.user.update({
        where: { id: invitation.userId },
        data: { phoneVerifiedAt: now, ...(passwordHash ? { passwordHash } : {}) },
      });
      await tx.staffInvitation.update({ where: { id: invitation.id }, data: { usedAt: now } });
      await tx.auditLog.create({
        data: {
          companyId: invitation.companyId,
          userId: invitation.userId,
          entityType: 'StaffInvitation',
          entityId: invitation.id,
          action: 'status_change',
          after: { status: 'used', number: 'verified' },
          reason: 'The employee verified their WhatsApp number from their invitation',
        },
      });
      return this.activation.activateInTx(tx, invitation.userId, actor);
    });

    // Not activated in the transaction: a seat to price, or a free trial's end to apply first — the service does both.
    const final = outcome.activated ? outcome : await this.activation.tryActivate(invitation.userId, actor);
    return {
      verified: true,
      business: invitation.company.name,
      name: invitation.user.name,
      activated: final.activated,
      pending: final.pending,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** The invitation key, or no invitation at all: a reference is never stored under a weak or missing key. */
  private invitationKey(): string {
    const key = this.config.staffInvitationKey;
    if (!key) {
      throw new ServiceUnavailableException({
        code: 'invitations_unavailable',
        message: 'Employee invitations are not configured on this server.',
      });
    }
    return key;
  }

  /** Issue an invitation in the caller's transaction. The clear reference leaves only in the answer. */
  private async issue(tx: Prisma.TransactionClient, key: string, companyId: Buffer, userId: Buffer, issuedBy: string, now: Date): Promise<IssuedInvitation> {
    const reference = newReference();
    const expiresAt = new Date(now.getTime() + STAFF_INVITATION_TTL_MS);
    const id = newUuidV7Bin();
    await tx.staffInvitation.create({
      data: { id, companyId, userId, tokenHash: referenceHash(key, reference), issuedBy: issuedBy.slice(0, 160), expiresAt, createdAt: now },
    });
    await this.audit.recordTx(tx as unknown as AuditClient, {
      entityType: 'StaffInvitation',
      entityId: id,
      action: 'create',
      after: { person: actorRef(binToUuid(userId)), expiresAt: expiresAt.toISOString(), issuedBy },
    });
    return { reference: formatReference(reference), link: joinLink(reference), expiresAt: expiresAt.toISOString() };
  }

  /**
   * Revoke this person's live invitation and conclude its pending agreement — inside the caller's transaction. Lock
   * order, the same on every path: the invitation, then the number's consent, then the person.
   */
  private async endLive(tx: Prisma.TransactionClient, companyId: Buffer, userId: Buffer, actorId: Buffer, reason: 'reinvited' | 'cancelled', now: Date): Promise<void> {
    // A locking read returns the rows as committed now, whatever the transaction read before.
    const live = await tx.$queryRaw<{ id: Uint8Array; pending_consent_id: Uint8Array | null }[]>(
      Prisma.sql`SELECT id, pending_consent_id FROM staff_invitations WHERE user_id = ${userId} AND company_id = ${companyId} AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
    );
    for (const row of live) {
      const id = Buffer.from(row.id);
      await tx.staffInvitation.update({ where: { id }, data: { revokedAt: now, revokedReason: reason } });
      if (row.pending_consent_id && this.whatsappRecords) {
        await this.whatsappRecords.cancelPending(
          {
            pendingId: Buffer.from(row.pending_consent_id),
            companyId,
            userId: actorId,
            source: reason === 'cancelled' ? 'invitation_cancelled' : 'invitation_replaced',
          },
          tx,
        );
      }
      await this.audit.recordTx(tx as unknown as AuditClient, {
        entityType: 'StaffInvitation',
        entityId: id,
        action: 'status_change',
        after: { status: 'revoked', reason },
      });
    }
  }

  /** The person's row, locked, still waiting: not activated by a confirmation that won the race, not withdrawn. */
  private async lockStillPending(tx: Prisma.TransactionClient, userId: Buffer): Promise<void> {
    const rows = await tx.$queryRaw<{ activated_at: Date | null; deleted_at: Date | null }[]>(
      Prisma.sql`SELECT activated_at, deleted_at FROM users WHERE id = ${userId} FOR UPDATE`,
    );
    if (!rows[0] || rows[0].deleted_at) throw new NotFoundException('Unknown user');
    if (rows[0].activated_at) throw new BadRequestException({ code: 'not_pending', message: 'This account is already active.' });
  }

  /**
   * The invitation behind a typed reference, if it can still be used: not used, not revoked, not expired, its person
   * still waiting in its business with a number. Every other case — a malformed reference included — is the same answer.
   */
  private async usable(db: Db, reference: string, now: Date) {
    const key = this.invitationKey();
    const normalised = normaliseReference(reference);
    if (!normalised) throw invitationUnavailable();
    const invitation = await db.staffInvitation.findUnique({
      where: { tokenHash: referenceHash(key, normalised) },
      include: {
        company: { select: { name: true } },
        user: {
          select: { companyId: true, name: true, phone: true, emailVerifiedAt: true, phoneVerifiedAt: true, invitedAt: true, activatedAt: true, deletedAt: true },
        },
      },
    });
    if (
      !invitation ||
      invitation.usedAt ||
      invitation.revokedAt ||
      invitation.expiresAt.getTime() <= now.getTime() ||
      !invitation.user.companyId.equals(invitation.companyId) ||
      invitation.user.deletedAt ||
      invitation.user.activatedAt ||
      !invitation.user.invitedAt ||
      !invitation.user.phone
    ) {
      throw invitationUnavailable();
    }
    return invitation;
  }

  /** The invitation's row, locked, and still usable once the lock is held — a cancellation or a use may have won. */
  private async lockLive(tx: Prisma.TransactionClient, id: Buffer, now: Date): Promise<{ pendingConsentId: Buffer | null }> {
    const rows = await tx.$queryRaw<{ used_at: Date | null; revoked_at: Date | null; expires_at: Date; pending_consent_id: Uint8Array | null }[]>(
      Prisma.sql`SELECT used_at, revoked_at, expires_at, pending_consent_id FROM staff_invitations WHERE id = ${id} FOR UPDATE`,
    );
    const row = rows[0];
    if (!row || row.used_at || row.revoked_at || new Date(row.expires_at).getTime() <= now.getTime()) throw invitationUnavailable();
    return { pendingConsentId: row.pending_consent_id ? Buffer.from(row.pending_consent_id) : null };
  }


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

  private async describe(
    userId: Buffer,
    created: boolean,
    invitation: IssuedInvitation | null,
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
            // A seat paid for during the free trial is this person's too (D176): shown as held.
            status: { in: ['pending_payment', 'paid', 'granted', 'scheduled'] },
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
      invitation,
      seats,
      activation,
    };
  }
}
