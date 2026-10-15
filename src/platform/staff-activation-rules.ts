import { NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { seatCensus } from '../entitlement/seat-census';
import { seatMath, type SubscriptionRecord } from '../entitlement/entitlement-rules';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';

/**
 * Whether a staff account may become usable, and making it so (docs/21, 2026-10-05) — the rules, apart from the
 * service that also prices a missing seat, so a caller that already holds the subscription lock can activate people
 * without ever creating a request.
 */

export type PendingReason = 'email_verification' | 'phone_verification' | 'seat_payment' | 'seat_unavailable';

export interface ActivationOutcome {
  activated: boolean;
  /** True when nothing happened because the account was already usable. */
  alreadyActive: boolean;
  pending: PendingReason[];
}

/** Any client the rules read and write through: the service's, or a transaction's. */
export type ActivationDb = Pick<PrismaClient, 'user' | 'subscription' | 'seatAllocation' | 'branch' | '$queryRaw' | 'subscriptionEvent'>;

const SELECT = {
  id: true,
  companyId: true,
  name: true,
  email: true,
  phone: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  invitedAt: true,
  activatedAt: true,
  isActive: true,
  userBranches: {
    select: {
      branchId: true,
      branch: { select: { name: true, isActive: true, deletedAt: true } },
      role: { select: { key: true } },
    },
  },
  seatAllocations: {
    where: {
      kind: 'seat' as const,
      status: { in: ['pending_payment', 'paid', 'granted'] as const },
    },
    select: { branchId: true, status: true },
  },
} satisfies Prisma.UserSelect;

type Row = Prisma.UserGetPayload<{ select: typeof SELECT }>;

export interface Evaluation extends ActivationOutcome {
  row: Row | null;
  /** False for an account nobody invited through Team: a legacy deactivated one, not ours to switch on. */
  eligible: boolean;
  /** Stores where the person has no seat held for them and none is free. */
  storesWithoutSeat: Buffer[];
}

export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** What still stands between this account and activation. Reads only. */
export async function evaluateActivation(db: ActivationDb, userId: Buffer): Promise<Evaluation> {
  const row = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: SELECT,
  });
  if (!row) throw new NotFoundException('Unknown user');

  if (row.activatedAt)
    return {
      activated: true,
      alreadyActive: true,
      pending: [],
      row,
      storesWithoutSeat: [],
      eligible: true,
    };
  // Not an invited account: a legacy deactivated one. Not ours to switch on.
  if (!row.invitedAt)
    return {
      activated: false,
      alreadyActive: false,
      pending: [],
      row,
      storesWithoutSeat: [],
      eligible: false,
    };

  const pending: PendingReason[] = [];
  if (row.email && !row.emailVerifiedAt) pending.push('email_verification');
  if (row.phone && !row.phoneVerifiedAt) pending.push('phone_verification');

  const storesWithoutSeat: Buffer[] = [];
  const seatStores = row.userBranches.filter(
    (ub) => ub.role.key !== 'owner' && ub.branch.isActive && ub.branch.deletedAt === null,
  );
  if (seatStores.length > 0) {
    const sub = await db.subscription.findFirst({
      where: { companyId: row.companyId },
    });
    const record: SubscriptionRecord = {
      subscribedBranchCount: sub?.subscribedBranchCount ?? 0,
      additionalSeats: sub?.additionalSeats ?? 0,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      isComplimentary: sub?.isComplimentary ?? false,
      complimentaryUntil: sub?.complimentaryUntil ?? null,
      status: sub?.status,
    };
    const census = await seatCensus(db, row.companyId);
    const math = seatMath(record, census);

    // Seats held for OTHER people who are not yet active must not be taken
    // by this one: a seat paid for Fatima is Fatima's.
    const reservedRows = await db.seatAllocation.findMany({
      where: {
        companyId: row.companyId,
        kind: 'seat',
        status: { in: ['paid', 'granted'] },
        userId: { not: null, notIn: [userId] },
        user: { activatedAt: null, deletedAt: null },
      },
      select: { branchId: true },
    });
    const reservedBy = new Map<string, number>();
    for (const r of reservedRows) {
      if (!r.branchId) continue;
      const k = binToUuid(r.branchId);
      reservedBy.set(k, (reservedBy.get(k) ?? 0) + 1);
    }
    const overflow = math.branches.reduce((n, b) => n + Math.max(0, b.seatsUsed - b.seatLimit), 0);

    for (const ub of seatStores) {
      const own = row.seatAllocations.find((a) => a.branchId !== null && a.branchId.equals(ub.branchId));
      if (own?.status === 'pending_payment') {
        pending.push('seat_payment');
        continue;
      }
      if (own) continue; // paid or granted, held for this very person
      const id = binToUuid(ub.branchId);
      const line = math.branches.find((b) => b.branchId === id);
      const room = line ? line.seatLimit - (reservedBy.get(id) ?? 0) - line.seatsUsed : 0;
      const pooledRoom = math.pooledSeats - overflow;
      if (room <= 0 && pooledRoom <= 0) {
        pending.push('seat_unavailable');
        storesWithoutSeat.push(ub.branchId);
      }
    }
  }

  return {
    activated: false,
    alreadyActive: false,
    pending: unique(pending),
    row,
    storesWithoutSeat,
    eligible: true,
  };
}

/**
 * Activate the account if every condition holds — re-evaluated here, inside the caller's transaction — and say what
 * is missing otherwise. It activates only: it never prices a seat or creates a request.
 *
 * The caller holds the subscription row's lock, so two people verifying their codes at the same instant cannot both
 * take the last seat: the census is read behind it.
 */
export async function activateIfReadyTx(tx: ActivationDb, userId: Buffer, now: Date, actor: string): Promise<ActivationOutcome> {
  const again = await evaluateActivation(tx, userId);
  if (again.alreadyActive) return { activated: true, alreadyActive: true, pending: [] };
  if (!again.eligible) return { activated: false, alreadyActive: false, pending: [] };
  if (again.pending.length > 0 || again.storesWithoutSeat.length > 0) {
    const pending = again.pending.map((p) => (p === 'seat_unavailable' ? 'seat_payment' : p));
    return {
      activated: false,
      alreadyActive: false,
      pending: unique(pending),
    };
  }
  const moved = await tx.user.updateMany({
    where: { id: userId, activatedAt: null, deletedAt: null },
    data: { isActive: true, activatedAt: now },
  });
  if (moved.count === 0) return { activated: true, alreadyActive: true, pending: [] };

  const companyId = again.row!.companyId;
  const sub = await tx.subscription.findFirst({
    where: { companyId },
    select: { id: true },
  });
  if (sub) {
    const stores = again
      .row!.userBranches.filter((ub) => ub.role.key !== 'owner')
      .map((ub) => ub.branch.name)
      .join(', ');
    await tx.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: sub.id,
        kind: 'staff_activated',
        note: `${again.row!.name} activated${stores ? ` at ${stores}` : ''}: every selected contact verified, a seat held.`.slice(
          0,
          255,
        ),
        actor: actor.slice(0, 120),
      },
    });
  }
  return { activated: true, alreadyActive: false, pending: [] };
}
