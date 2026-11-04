import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lockSubscription } from '../billing/renewal';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { PlatformAuditService } from '../platform/platform-audit.service';
import type { PlatformAdminIdentity } from '../platform/platform-admin.service';
import { AccountDeletionService } from './account-deletion.service';

/**
 * An administrator's staged deletion of a business (post-Build-4; the owner's brief and clarifications of 2026-11-03).
 *
 * **Prepare** — one transaction, under the subscription lock every billing writer takes: the subscription cancelled
 * (which outranks a grant or a running trial, `entitlement-rules.ts` `stateOf`), the free trial fenced, the business
 * deactivated, every session of every person in it revoked (app and portal alike: access tokens are re-checked against
 * their session on every request), the messages still queued for it cancelled, and two separate permanent audit records
 * — the cancellation and the deactivation. No refund is issued: money is never moved by this.
 *
 * **Delete** — only after the backend itself finds the business prepared, inactive, with no usable subscription and
 * nothing pending (a payment proof, a seat awaiting payment, an Owner's own deletion in progress). It needs the open
 * step-up window (the controller's `requireStepUp`) and the business's exact name typed back. It applies the same
 * de-identification as an Owner's closure (`AccountDeletionService.deidentifyBusiness`): identities, contacts,
 * credentials, sessions, devices, notes and receipt files removed or anonymised; the uploaded payment-proof images
 * removed; the business's names cleared. What stays, de-identified and marked by `companies.deleted_at`: sales,
 * purchases, closings, ledgers, subscription and payment records, and the audit trails — the 37 tables whose deletion
 * the database refuses are never bypassed; nothing here deletes a row from any of them.
 *
 * **Retry-safe**: one `business_deletions` row per business (UNIQUE), moved from `prepared` to `completed` once;
 * a repeated prepare or delete returns what was done and records nothing new.
 */

export const RETENTION_POLICY = 'deleted-business-v1';

/** What the retention policy keeps, said as such: read by the console and written into the deletion record. */
export const RETAINED = ['sales', 'purchases', 'closings', 'ledgers', 'subscription_records', 'payment_records', 'audit_logs', 'platform_audit_events'] as const;

export type DeletionBlocker =
  | 'already_deleted'
  | 'not_prepared'
  | 'still_active'
  | 'subscription_usable'
  | 'payment_pending'
  | 'seat_payment_pending'
  | 'owner_deletion_in_progress';

export interface BusinessDeletionView {
  businessId: string;
  /** The name to type back: the business's, or its first store's when it has none. Null once deleted. */
  confirmName: string | null;
  stage: 'none' | 'prepared' | 'completed';
  preparedAt: string | null;
  preparedBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
  retentionPolicy: string | null;
  /** What still stops each step, from the backend's own checks. Empty: the step is allowed. */
  prepareBlockers: DeletionBlocker[];
  deleteBlockers: DeletionBlocker[];
  retained: readonly string[];
}

interface Actor {
  admin: PlatformAdminIdentity;
  ip: string | null;
}

const refused = (code: string, message: string, blockers: DeletionBlocker[] = []) => new ConflictException({ code, message, blockers });

@Injectable()
export class BusinessDeletionService {
  private readonly logger = new Logger(BusinessDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly deletion: AccountDeletionService,
  ) {}

  async view(businessId: string): Promise<BusinessDeletionView> {
    return this.read(this.prisma, this.idOf(businessId));
  }

  async prepare(businessId: string, actor: Actor): Promise<BusinessDeletionView> {
    const companyId = this.idOf(businessId);
    const now = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        await lockSubscription(tx, companyId);
        const before = await this.read(tx, companyId);
        if (before.stage !== 'none') return; // Repeated: what was done stands.
        if (before.prepareBlockers.length > 0) throw refused('deletion_prepare_blocked', 'This business cannot be prepared for deletion yet.', before.prepareBlockers);
        const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true, isActive: true } });
        const label = before.confirmName;

        const sub = await tx.subscription.findFirst({ where: { companyId } });
        if (sub && sub.status !== 'cancelled' && sub.status !== 'rejected') {
          await tx.subscription.update({ where: { id: sub.id }, data: { status: 'cancelled', version: { increment: 1 } } });
          await tx.subscriptionEvent.create({
            data: {
              id: newUuidV7Bin(),
              companyId,
              subscriptionId: sub.id,
              kind: 'cancelled',
              note: 'Prepared for deletion by a platform administrator; no refund issued',
              periodEndAfter: sub.currentPeriodEnd,
              branchesAfter: sub.subscribedBranchCount,
              seatsAfter: sub.additionalSeats,
              actor: actor.admin.email,
            },
          });
        }
        // The free trial can never start for it now; a claim already made stays, as a fact.
        await tx.trialEligibility.updateMany({ where: { companyId, closedAt: null }, data: { closedAt: now, closedReason: 'cancelled' } });
        await this.audit.record(
          { admin: actor.admin, action: 'business.deletion.subscription_cancelled', targetType: 'Company', targetId: companyId, targetLabel: label, before: { status: sub?.status ?? null }, after: { status: sub ? (sub.status === 'rejected' ? 'rejected' : 'cancelled') : null, refund: 'none' }, ip: actor.ip, at: now },
          tx,
        );

        await tx.company.update({ where: { id: companyId }, data: { isActive: false } });
        const sessions = await tx.authSession.updateMany({ where: { companyId, revokedAt: null }, data: { revokedAt: now } });
        await tx.portalClaimLink.updateMany({ where: { companyId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
        await tx.subscriptionNotice.updateMany({
          where: { companyId, state: { in: ['pending', 'sending'] } },
          data: { state: 'cancelled', cancelReason: 'closed', claimToken: null, claimedUntil: null, completedAt: now },
        });
        await this.audit.record(
          { admin: actor.admin, action: 'business.deletion.deactivated', targetType: 'Company', targetId: companyId, targetLabel: label, before: { isActive: company.isActive }, after: { isActive: false, sessionsRevoked: sessions.count }, ip: actor.ip, at: now },
          tx,
        );

        await tx.businessDeletion.create({
          data: { id: newUuidV7Bin(), companyId, stage: 'prepared', preparedAt: now, preparedByAdminId: actor.admin.id, preparedBy: actor.admin.email },
        });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return this.view(businessId);
  }

  async delete(businessId: string, typedName: string, actor: Actor): Promise<BusinessDeletionView> {
    const companyId = this.idOf(businessId);
    const now = new Date();
    let receiptKeys: string[] = [];
    let deletionId: Buffer | null = null;
    await this.prisma.$transaction(
      async (tx) => {
        await lockSubscription(tx, companyId);
        const before = await this.read(tx, companyId);
        if (before.stage === 'completed') return; // Repeated: already deleted, nothing recorded twice.
        if (before.deleteBlockers.length > 0) throw refused('deletion_blocked', 'This business cannot be deleted yet.', before.deleteBlockers);
        if (!before.confirmName || typedName?.trim() !== before.confirmName) {
          throw new ForbiddenException({ code: 'deletion_name_mismatch', message: 'Type the business’s name exactly as shown to delete it.' });
        }
        const record = await tx.businessDeletion.findUniqueOrThrow({ where: { companyId } });
        const owner = await tx.user.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
        // Uploaded and generated files the closure does not reach: unit photos, the logo, report exports. Collected before
        // their rows let go of them, removed from storage after the commit.
        const [unitImages, logo, reports] = await Promise.all([
          tx.unit.findMany({ where: { companyId, imageRef: { not: null } }, select: { imageRef: true } }),
          tx.company.findUnique({ where: { id: companyId }, select: { logoRef: true } }),
          tx.reportSnapshot.findMany({ where: { companyId, fileRef: { not: null } }, select: { fileRef: true } }),
        ]);
        const files = [...unitImages.map((u) => u.imageRef), logo?.logoRef, ...reports.map((r) => r.fileRef)].filter((k): k is string => !!k);
        const { summary, receiptKeys: keys } = await this.deletion.deidentifyBusiness(tx, companyId, owner?.id ?? companyId, now);
        receiptKeys = [...keys, ...files];
        // Operational detail no record of money needs (owner, 2026-11-03): device identifiers and photos of the stock, and
        // free text written about people — on repairs, transfers, consignments and closings. Amounts, dates, costs and the
        // rows themselves stay; none of these tables refuses the change, and no protected table is written here.
        const units = await tx.unit.updateMany({ where: { companyId }, data: { imeiPrimary: null, imeiSecondary: null, serialNo: null, imageRef: null } });
        const repairs = await tx.maintenanceRecord.updateMany({ where: { companyId }, data: { description: 'Repair', note: null } });
        await tx.stockTransfer.updateMany({ where: { companyId }, data: { decisionReason: null } });
        // A consignment shared with another business is that business's record too: only its own, unshared ones.
        await tx.consignment.updateMany({ where: { sourceCompanyId: companyId, destinationCompanyId: null }, data: { note: null, disputeReason: null } });
        await tx.dailyClosing.updateMany({ where: { companyId }, data: { notes: null } });
        await tx.reportSnapshot.updateMany({ where: { companyId }, data: { fileRef: null } });
        // The images an Owner uploaded as payment proof: people's bank screens. The proof's amount and decision stay.
        const proofs = await tx.paymentProof.updateMany({ where: { companyId, file: { not: null } }, data: { file: null, purgedAt: now } });
        await tx.company.update({ where: { id: companyId }, data: { name: null, nameAr: null, deletedAt: now } });
        const kept = { ...summary, kind: 'business_deletion', paymentProofFilesRemoved: proofs.count, unitsDeidentified: units.count, repairsDeidentified: repairs.count, filesRemoved: receiptKeys.length, retentionPolicy: RETENTION_POLICY, retained: { ...((summary.retained as object) ?? {}), categories: RETAINED } };
        const moved = await tx.businessDeletion.updateMany({
          where: { id: record.id, stage: 'prepared' },
          data: { stage: 'completed', completedAt: now, completedByAdminId: actor.admin.id, completedBy: actor.admin.email, retentionPolicy: RETENTION_POLICY, summary: kept as Prisma.InputJsonValue, version: { increment: 1 } },
        });
        if (moved.count !== 1) throw refused('deletion_conflict', 'Another deletion of this business is under way.');
        deletionId = record.id;
        await tx.auditLog.create({
          data: { companyId, entityType: 'BusinessDeletion', entityId: record.id, action: 'delete', after: kept as Prisma.InputJsonValue, reason: 'Business deleted by a platform administrator' },
        });
        await this.audit.record(
          { admin: actor.admin, action: 'business.deletion.completed', targetType: 'Company', targetId: companyId, targetLabel: binToUuid(companyId), after: kept, ip: actor.ip, at: now },
          tx,
        );
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    if (deletionId) await this.deletion.removeReceiptFiles(receiptKeys, deletionId);
    return this.view(businessId);
  }

  /** Where the business stands, and what still stops each step, read from the rows themselves. */
  private async read(db: Prisma.TransactionClient | PrismaService, companyId: Buffer): Promise<BusinessDeletionView> {
    const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true, isActive: true, deletedAt: true } });
    if (!company) throw new NotFoundException('No business has that id.');
    const [record, sub, proofs, seats, ownerDeletion, store] = await Promise.all([
      db.businessDeletion.findUnique({ where: { companyId } }),
      db.subscription.findFirst({ where: { companyId }, select: { status: true } }),
      db.paymentProof.count({ where: { companyId, status: { in: ['submitted', 'under_review'] } } }),
      db.seatAllocation.count({ where: { companyId, status: 'pending_payment' } }),
      db.accountDeletionRequest.count({ where: { companyId, status: { in: ['confirmed', 'processing'] } } }),
      db.branch.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' }, select: { name: true } }),
    ]);
    const stage = (record?.stage as 'prepared' | 'completed' | undefined) ?? 'none';
    const pending: DeletionBlocker[] = [];
    if (proofs > 0) pending.push('payment_pending');
    if (seats > 0) pending.push('seat_payment_pending');
    if (ownerDeletion > 0) pending.push('owner_deletion_in_progress');

    const prepareBlockers: DeletionBlocker[] = stage === 'completed' || company.deletedAt ? ['already_deleted'] : [...pending];
    const deleteBlockers: DeletionBlocker[] =
      stage === 'completed' || company.deletedAt
        ? ['already_deleted']
        : [
            ...(stage === 'none' ? (['not_prepared'] as const) : []),
            ...(company.isActive ? (['still_active'] as const) : []),
            ...(sub && sub.status !== 'cancelled' && sub.status !== 'rejected' ? (['subscription_usable'] as const) : []),
            ...pending,
          ];
    return {
      businessId: binToUuid(companyId),
      confirmName: company.deletedAt ? null : (company.name?.trim() || store?.name?.trim() || null),
      stage,
      preparedAt: record?.preparedAt.toISOString() ?? null,
      preparedBy: record?.preparedBy ?? null,
      completedAt: record?.completedAt?.toISOString() ?? null,
      completedBy: record?.completedBy ?? null,
      retentionPolicy: record?.retentionPolicy ?? null,
      prepareBlockers,
      deleteBlockers,
      retained: RETAINED,
    };
  }

  private idOf(businessId: string): Buffer {
    try {
      return uuidToBin(businessId);
    } catch {
      throw new NotFoundException('No business has that id.');
    }
  }
}
