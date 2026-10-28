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

/**
 * What still stands between a staff account and activation. `email_verification` is no longer produced (D214: an email
 * address is optional and never a condition); it stays in the type for records written before. `seat_scheduled` (D176):
 * a seat for this person — their
 * own, or one bought for the store that nobody holds — was paid for during the free trial and starts when it ends.
 * Nothing is asked of anyone: the account is activated then.
 */
export type PendingReason = 'email_verification' | 'phone_verification' | 'seat_payment' | 'seat_unavailable' | 'seat_scheduled';

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
  phoneVerification: true,
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
      // `scheduled` (D176) is the person's own seat as surely as a paid one: unseen, a second request would be made.
      status: { in: ['pending_payment', 'paid', 'granted', 'scheduled'] as const },
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
  /** Stores where a seat paid for during the free trial will seat them when it ends (D176): no request is made there. */
  coveredStores: Buffer[];
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
      coveredStores: [],
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
      coveredStores: [],
      eligible: false,
    };

  // The WhatsApp number is every employee's required contact, proved by the employee from their invitation (D214); an
  // email address is optional and verified later, if ever — it never stands in for the number, nor holds activation back.
  const pending: PendingReason[] = [];
  // A platform administrator's deferral (D224, a test business only) stands in for the proof — never as a proof: the
  // number stays unverified, and everything WhatsApp-dependent stays unavailable.
  const deferred = row.phoneVerification === 'deferred_by_platform';
  if (!deferred && (!row.phone || !row.phoneVerifiedAt)) pending.push('phone_verification');

  const storesWithoutSeat: Buffer[] = [];
  const coveredStores: Buffer[] = [];
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
      // Paid for during the free trial: theirs, and in force when it ends (D176).
      if (own?.status === 'scheduled') {
        pending.push('seat_scheduled');
        continue;
      }
      if (own) continue; // paid or granted, held for this very person
      const id = binToUuid(ub.branchId);
      const line = math.branches.find((b) => b.branchId === id);
      const room = line ? line.seatLimit - (reservedBy.get(id) ?? 0) - line.seatsUsed : 0;
      const pooledRoom = math.pooledSeats - overflow;
      if (room <= 0 && pooledRoom <= 0) {
        // The store is full now; a seat bought for it during the free trial and held by nobody is capacity already
        // paid for — the first people waiting there, in invitation order, are covered by it (D176 §8).
        const coverage = await scheduledCoverage(db, row.companyId, ub.branchId);
        const index = coverage.candidates.findIndex((c) => c.equals(userId));
        if (index >= 0 && index < room + coverage.seats) {
          pending.push('seat_scheduled');
          coveredStores.push(ub.branchId);
          continue;
        }
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
    coveredStores,
    eligible: true,
  };
}

/**
 * Activate the account if every condition holds — re-evaluated here, inside the caller's transaction — and say what
 * is missing otherwise. It activates only: it never prices a seat or creates a request. A missing seat reads as
 * `seat_payment`; a seat that starts when the free trial ends stays `seat_scheduled`.
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
        note: `${again.row!.name} activated${stores ? ` at ${stores}` : ''}: ${again.row!.phoneVerification === 'deferred_by_platform' ? 'WhatsApp verification deferred for testing' : 'the WhatsApp number verified'}, a seat held.`.slice(
          0,
          255,
        ),
        actor: actor.slice(0, 120),
      },
    });
  }
  return { activated: true, alreadyActive: false, pending: [] };
}

/** What a store's scheduled seats can cover, and for whom: {@link scheduledCoverage}. */
export interface ScheduledCoverage {
  /** Seats at the store paid for during a free trial, not yet in force, that no pending person holds. */
  seats: number;
  /** The pending people a seat there would go to, first invited first. */
  candidates: Buffer[];
}

/**
 * An unreserved scheduled seat is capacity already bought (D176 §8).
 *
 * A seat paid for during a free trial is `scheduled` until the trial ends: counted nowhere, so the store still reads
 * full. Without this rule the next person invited there would be priced a second seat. `seats` (K) counts the
 * scheduled seats at the store that no pending person holds — requested for nobody, or for somebody since activated
 * or deleted, as a held seat is read for {@link evaluateActivation}'s reservations. `candidates` are the company's
 * pending invitees assigned to the store with a non-Owner role and no seat request of their own there, in the order
 * they were invited (then by id). When the store is full, the candidate at index i is covered exactly when
 * i < room + K.
 *
 * Counts are unchanged: a scheduled seat still seats nobody now. Coverage only stops a second request being made.
 */
export async function scheduledCoverage(db: ActivationDb, companyId: Buffer, branchId: Buffer): Promise<ScheduledCoverage> {
  const scheduled = await db.seatAllocation.findMany({
    where: { companyId, kind: 'seat', status: 'scheduled', branchId },
    select: { userId: true, user: { select: { activatedAt: true, deletedAt: true } } },
  });
  const seats = scheduled.filter((s) => s.userId === null || !s.user || s.user.activatedAt !== null || s.user.deletedAt !== null).length;
  if (seats === 0) return { seats: 0, candidates: [] };
  const people = await db.user.findMany({
    where: {
      companyId,
      invitedAt: { not: null },
      activatedAt: null,
      deletedAt: null,
      userBranches: { some: { branchId, role: { key: { not: 'owner' } } } },
      seatAllocations: { none: { kind: 'seat', branchId, status: { in: ['pending_payment', 'paid', 'granted', 'scheduled'] } } },
    },
    select: { id: true },
    orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
  });
  return { seats, candidates: people.map((p) => p.id) };
}
