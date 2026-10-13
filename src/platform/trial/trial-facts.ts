import type { Prisma } from '@prisma/client';
import type { SubscriptionRecord } from '../../entitlement/entitlement-rules';
import { trialFactsOf, type OwnerContacts } from './trial-rules';

/**
 * What every free trial route reads, the same way (0095; docs/76): who is asking, and the business they ask about —
 * its subscription and its trial rows, read together on the connection given.
 *
 * Shared by the claim, the website's card and the setup instructions, so "the Owner" and "the state" are decided by
 * one reading rule wherever the trial is touched: an Owner refused here is refused everywhere, and a state computed
 * here is the state every request is judged by.
 */

/** Who asks: the company and the person of the authenticated session — never anything the request says about itself. */
export interface TrialPrincipal {
  companyId: Buffer;
  userId: Buffer;
}

/** The business, its subscription and its trial rows — read together, on the connection given. */
export function readFacts(db: Prisma.TransactionClient, companyId: Buffer) {
  return db.company.findUnique({
    where: { id: companyId },
    select: {
      name: true,
      timezone: true,
      isActive: true,
      closedAt: true,
      subscription: {
        select: {
          id: true,
          status: true,
          currentPeriodEnd: true,
          isComplimentary: true,
          complimentaryUntil: true,
          subscribedBranchCount: true,
          additionalSeats: true,
        },
      },
      trialEligibility: { select: { id: true, registrationMethod: true, closedAt: true } },
      trialClaim: {
        select: {
          claimedAt: true,
          startedAt: true,
          endsAt: true,
          idempotencyKey: true,
          requestHash: true,
          subscriptionVersionAfter: true,
        },
      },
    },
  });
}

/** One reading of a business for the trial. */
export type TrialFactsRow = NonNullable<Awaited<ReturnType<typeof readFacts>>>;

/**
 * The caller as the trial knows them: an active, undeleted person of THIS company holding the Owner role — or null.
 * The role itself, not a permission: a permission can be delegated, and the trial is the Owner's alone. A Manager,
 * an Employee or a legacy administrator is refused before anything about the trial is read or told.
 */
export function readOwner(db: Prisma.TransactionClient, who: TrialPrincipal): Promise<OwnerContacts | null> {
  return db.user.findFirst({
    where: {
      id: who.userId,
      companyId: who.companyId,
      isActive: true,
      deletedAt: null,
      userBranches: { some: { role: { key: 'owner' } } },
    },
    select: { email: true, emailVerifiedAt: true, phone: true, phoneVerifiedAt: true },
  });
}

/**
 * The subscription as the entitlement rules read it, with the trial's facts — the same rules every request is
 * judged by, so the state here is the state everywhere. No subscription row reads as never subscribed, with no
 * trial: exactly as the entitlement reads it.
 */
export function subscriptionRecordOf(row: TrialFactsRow): SubscriptionRecord {
  const sub = row.subscription;
  return {
    subscribedBranchCount: sub?.subscribedBranchCount ?? 0,
    additionalSeats: sub?.additionalSeats ?? 0,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    isComplimentary: sub?.isComplimentary ?? false,
    complimentaryUntil: sub?.complimentaryUntil ?? null,
    status: sub?.status ?? 'activated',
    trial: sub ? trialFactsOf(row.trialEligibility, row.trialClaim) : null,
  };
}

/** Closed for good: the company was closed or deactivated, or its subscription cancelled. */
export function isClosed(row: TrialFactsRow): boolean {
  return !row.isActive || row.closedAt !== null || row.subscription?.status === 'cancelled';
}
