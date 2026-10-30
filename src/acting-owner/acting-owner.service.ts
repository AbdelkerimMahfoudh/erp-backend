import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { HashingService } from '../common/security/hashing.service';
import { binToUuid, isUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { ACTING_OWNER_PERMISSIONS, inForce, liveOrScheduled, overlaps } from './acting-owner-rules';
import type { AppointActingOwnerDto, RequestActingOwnerCodeDto, RevokeActingOwnerDto } from './dto/acting-owner.dto';
import { links } from '../notifications/notification-target';
import { ActingOwnerStepUp, StepUpAction, StepUpChallenge } from './acting-owner-step-up';

/** A start this far in the past is a clock difference, read as now; further is refused. */
const START_TOLERANCE_MS = 5 * 60_000;

/**
 * The temporary Acting Owner (D225, 0112). Appointing and revoking are the REAL Owner's: the routes check the Owner
 * role itself, so a delegate holding every delegated permission still cannot extend, change or pass on their own
 * appointment. The Owner confirms with their password AND a one-time code sent to their verified WhatsApp number for
 * that very change ({@link ActingOwnerStepUp}, the account-deletion code service). Changing an appointment is removing
 * it and appointing again — each confirmed the same way. Every change is audited, and both people are told.
 */
@Injectable()
export class ActingOwnerService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly hashing: HashingService,
    private readonly stepUp: ActingOwnerStepUp,
  ) {}

  /** The change a code is asked for, or confirmed against — the same normalisation both ways. */
  private changeOf(dto: { delegateId?: string; startsAt?: string; endsAt?: string }): StepUpAction {
    return {
      action: 'appoint',
      delegateId: dto.delegateId ?? '',
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
    };
  }

  /**
   * The step-up's first half: the Owner's password, then a code to their verified WhatsApp number for exactly this
   * appointment or removal. Nothing is changed here.
   */
  async requestCode(dto: RequestActingOwnerCodeDto): Promise<StepUpChallenge> {
    const ownerId = this.tenant.requireUserId();
    const companyId = this.tenant.companyId();
    await this.assertRealOwner(ownerId);
    await this.confirmPassword(ownerId, dto.currentPassword);
    const change: StepUpAction = dto.action === 'revoke' ? { action: 'revoke', delegationId: dto.delegationId ?? '' } : this.changeOf(dto);
    return this.stepUp.request({ companyId, userId: ownerId, change, language: dto.language });
  }

  /** The actor holds the Owner role — not merely the Owner's permissions, which an Acting Owner has too. */
  private async assertRealOwner(userId: Buffer): Promise<void> {
    const owner = await this.db.userBranch.count({ where: { userId, role: { key: 'owner' } } });
    if (owner === 0) throw new ForbiddenException({ code: 'owner_only', message: 'Only the Owner appoints or removes an Acting Owner.' });
  }

  private async confirmPassword(userId: Buffer, password: string): Promise<void> {
    const actor = await this.db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    const ok = actor ? await this.hashing.verify(actor.passwordHash, password) : await this.hashing.verifyDummy(password);
    if (!ok) throw new ForbiddenException({ code: 'password_incorrect', message: 'That password is not correct.' });
  }

  private view(d: { id: Buffer; delegateUserId: Buffer; grantedByUserId: Buffer; startsAt: Date; endsAt: Date | null; revokedAt: Date | null; delegate?: { name: string; nameAr: string | null } }, now: Date) {
    return {
      id: binToUuid(d.id),
      delegateId: binToUuid(d.delegateUserId),
      delegate: d.delegate ? { name: d.delegate.name, nameAr: d.delegate.nameAr } : null,
      grantedById: binToUuid(d.grantedByUserId),
      startsAt: d.startsAt.toISOString(),
      endsAt: d.endsAt?.toISOString() ?? null,
      revokedAt: d.revokedAt?.toISOString() ?? null,
      state: d.revokedAt ? ('revoked' as const) : inForce(d, now) ? ('active' as const) : d.startsAt > now ? ('scheduled' as const) : ('ended' as const),
    };
  }

  /** The appointment in force for this person now, or null — what AccessService adds authority for. */
  async activeFor(userId: Buffer, now = new Date()) {
    const rows = await this.db.actingOwnerDelegation.findMany({
      where: { delegateUserId: userId, revokedAt: null, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      take: 1,
    });
    return rows[0] ?? null;
  }

  /** The Owner sees every appointment; anyone else only their own that is running or to come. */
  async list() {
    const userId = this.tenant.requireUserId();
    const now = new Date();
    const isOwner = (await this.db.userBranch.count({ where: { userId, role: { key: 'owner' } } })) > 0;
    const rows = await this.db.actingOwnerDelegation.findMany({
      where: isOwner ? {} : { delegateUserId: userId, revokedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      orderBy: { startsAt: 'desc' },
      take: 20,
      include: { delegate: { select: { name: true, nameAr: true } } },
    });
    return { delegations: rows.map((r) => this.view(r, now)), delegatedPermissions: ACTING_OWNER_PERMISSIONS };
  }

  async appoint(dto: AppointActingOwnerDto) {
    const ownerId = this.tenant.requireUserId();
    const companyId = this.tenant.companyId();
    await this.assertRealOwner(ownerId);
    await this.confirmPassword(ownerId, dto.currentPassword);

    const now = new Date();
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : now;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (startsAt.getTime() < now.getTime() - START_TOLERANCE_MS) throw new BadRequestException({ code: 'start_in_past', message: 'Choose a start from now on.' });
    if (endsAt && endsAt.getTime() <= Math.max(startsAt.getTime(), now.getTime())) {
      throw new BadRequestException({ code: 'end_before_start', message: 'The end must come after the start.' });
    }
    if (!isUuid(dto.delegateId)) throw new NotFoundException('User not found');
    const delegateId = uuidToBin(dto.delegateId);
    if (delegateId.equals(ownerId)) throw new BadRequestException({ code: 'delegate_self', message: 'Choose somebody other than yourself.' });
    // The second factor, for this very appointment — "until revoked" included. Spent once, whatever follows.
    const stepUpChallengeId = await this.stepUp.confirm({ companyId, userId: ownerId, change: this.changeOf(dto), challengeId: dto.challengeId, code: dto.code });

    const created = await this.db.$transaction(async (tx) => {
      // One appointment at a time per business: a parallel request waits here, then sees this one.
      await tx.$queryRaw`SELECT id FROM companies WHERE id = ${companyId} FOR UPDATE`;
      const delegate = await tx.user.findFirst({
        where: { id: delegateId, companyId, deletedAt: null, isActive: true },
        select: { id: true, userBranches: { select: { role: { select: { key: true } } } } },
      });
      if (!delegate || delegate.userBranches.length === 0) throw new NotFoundException({ code: 'delegate_unknown', message: 'Choose an active member of your team.' });
      if (delegate.userBranches.some((ub) => ub.role.key === 'owner')) {
        throw new BadRequestException({ code: 'delegate_is_owner', message: 'This person is already an Owner.' });
      }
      const others = await tx.actingOwnerDelegation.findMany({ where: { companyId, revokedAt: null }, select: { startsAt: true, endsAt: true, revokedAt: true } });
      if (others.some((o) => liveOrScheduled(o, now) && overlaps(o, { startsAt, endsAt }))) {
        throw new ConflictException({ code: 'delegation_overlap', message: 'An Acting Owner is already appointed for that time. Remove that appointment first.' });
      }
      const id = newUuidV7Bin();
      const row = await tx.actingOwnerDelegation.create({
        data: { id, companyId, delegateUserId: delegateId, grantedByUserId: ownerId, startsAt, endsAt },
      });
      await this.audit.recordTx(tx, {
        entityType: 'ActingOwnerDelegation',
        entityId: id,
        action: 'create',
        after: {
          delegateId: binToUuid(delegateId),
          startsAt: startsAt.toISOString(),
          endsAt: endsAt?.toISOString() ?? null,
          permissions: ACTING_OWNER_PERMISSIONS.length,
          stepUp: { method: 'password+whatsapp_code', challengeId: stepUpChallengeId },
        },
        reason: 'Acting Owner appointed',
      });
      await this.tellBoth(tx, companyId, ownerId, delegateId, 'acting_owner.appointed', { delegationId: binToUuid(id), startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null });
      return row;
    });
    return this.view(created, now);
  }

  async revoke(idStr: string, dto: RevokeActingOwnerDto) {
    const ownerId = this.tenant.requireUserId();
    const companyId = this.tenant.companyId();
    await this.assertRealOwner(ownerId);
    await this.confirmPassword(ownerId, dto.currentPassword);
    if (!isUuid(idStr)) throw new NotFoundException('Appointment not found');
    const id = uuidToBin(idStr);
    const stepUpChallengeId = await this.stepUp.confirm({
      companyId,
      userId: ownerId,
      change: { action: 'revoke', delegationId: idStr },
      challengeId: dto.challengeId,
      code: dto.code,
    });
    const now = new Date();
    const updated = await this.db.$transaction(async (tx) => {
      const moved = await tx.actingOwnerDelegation.updateMany({ where: { id, companyId, revokedAt: null }, data: { revokedAt: now, revokedByUserId: ownerId } });
      const row = await tx.actingOwnerDelegation.findFirst({ where: { id, companyId } });
      if (!row) throw new NotFoundException('Appointment not found');
      if (moved.count === 0) throw new ConflictException({ code: 'already_revoked', message: 'This appointment was already removed.' });
      await this.audit.recordTx(tx, {
        entityType: 'ActingOwnerDelegation',
        entityId: id,
        action: 'status_change',
        before: { revokedAt: null },
        after: { revokedAt: now.toISOString(), stepUp: { method: 'password+whatsapp_code', challengeId: stepUpChallengeId } },
        reason: 'Acting Owner removed',
      });
      await this.tellBoth(tx, companyId, ownerId, row.delegateUserId, 'acting_owner.revoked', { delegationId: idStr });
      return row;
    });
    return this.view(updated, now);
  }

  /** Both people, in their own history: structured, rendered in each reader's language. */
  private async tellBoth(
    tx: Pick<TenantPrisma, 'notification'>,
    companyId: Buffer,
    ownerId: Buffer,
    delegateId: Buffer,
    type: 'acting_owner.appointed' | 'acting_owner.revoked',
    payload: Record<string, string | null>,
  ) {
    for (const targetUserId of [ownerId, delegateId]) {
      await tx.notification.create({
        data: {
          id: newUuidV7Bin(),
          companyId,
          branchId: null,
          targetUserId,
          type,
          // D225: the Owner who did it is not pushed; the person appointed is.
          actorUserId: ownerId,
          title: type === 'acting_owner.appointed' ? 'Acting Owner appointed' : 'Acting Owner removed',
          dedupeKey: `${type}:${payload.delegationId}`,
          actionLink: links.actingOwner(),
          payload: { ...payload, delegateId: binToUuid(delegateId), ownerId: binToUuid(ownerId) },
          isRead: false,
        },
      });
    }
  }
}
