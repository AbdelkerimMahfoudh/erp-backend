import type { BillingDb } from '../billing/billing.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { openStoreTx } from './store-opening';

export interface ActivatedBranch {
  requestId: string;
  name: string;
  /** `opened`: the branch exists now. `scheduled`: paid during the free trial, it opens when the trial ends (D176). */
  outcome: 'opened' | 'scheduled';
  branchId: string | null;
}

/**
 * The branches added in the app and waiting for activation, activated by an approved payment (0130; the owner's brief of
 * 2026-11-05) — inside the caller's transaction, the one that applies the paid period, so the period, the branches and
 * their records commit together or not at all.
 *
 * - Each pending store request of its own (not one taking an archived store's place) is marked paid by the payment.
 * - It opens now — the branch created, every Owner assigned, the subscribed store count raised (`openStoreTx`) — or,
 *   while the business's free trial runs, it is scheduled to open when the trial ends: a new branch never receives
 *   trial time.
 * - The Owners are told in the app that the branch is active (or will be when the trial ends).
 *
 * Idempotent: only requests still `pending_payment` move, guarded by their version; a repeated approval finds none.
 */
export async function activatePendingBranchesTx(
  tx: BillingDb,
  input: { companyId: Buffer; subscriptionId: Buffer; paymentId: Buffer | null; actor: string; reference: string; now: Date },
): Promise<ActivatedBranch[]> {
  const { companyId, now } = input;
  const pending = await tx.seatAllocation.findMany({
    where: { companyId, kind: 'store', status: 'pending_payment', replacesBranchId: null },
    orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
  });
  if (pending.length === 0) return [];
  const claim = await tx.trialClaim.findUnique({ where: { companyId }, select: { endsAt: true } });
  const trialEndsAt = claim && claim.endsAt.getTime() > now.getTime() ? claim.endsAt : null;
  const done: ActivatedBranch[] = [];

  for (const row of pending) {
    const name = row.label ?? 'New branch';
    const moved = await tx.seatAllocation.updateMany({
      where: { id: row.id, companyId, status: 'pending_payment', version: row.version },
      data: trialEndsAt
        ? { status: 'scheduled', paymentId: input.paymentId, confirmedBy: input.actor, confirmedAt: now, effectiveAt: trialEndsAt, version: { increment: 1 } }
        : { status: 'paid', paymentId: input.paymentId, confirmedBy: input.actor, confirmedAt: now, effectiveAt: now, version: { increment: 1 } },
    });
    if (moved.count !== 1) continue;
    let branchId: Buffer | null = null;
    if (!trialEndsAt) {
      const activity = row.activityTo ?? 'electronics';
      branchId = await openStoreTx(tx, {
        companyId,
        subscriptionId: input.subscriptionId,
        name,
        nameAr: row.labelAr,
        activity,
        address: row.location,
        actor: input.actor,
        note: `Branch "${name}" (${activity}), added in the app, opened with payment ${input.reference}.`,
      });
      await tx.seatAllocation.updateMany({ where: { id: row.id, branchId: null }, data: { branchId } });
    }
    done.push({ requestId: binToUuid(row.id), name, outcome: trialEndsAt ? 'scheduled' : 'opened', branchId: branchId ? binToUuid(branchId) : null });
  }

  // The Owners, in the app: the branch is active — or opens when the trial ends.
  if (done.length) {
    const owners = await tx.user.findMany({
      where: { companyId, deletedAt: null, isActive: true, userBranches: { some: { role: { key: 'owner' } } } },
      select: { id: true },
    });
    for (const b of done) {
      for (const o of owners) {
        await tx.notification.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            targetUserId: o.id,
            type: b.outcome === 'opened' ? 'branch.activated' : 'branch.scheduled',
            title: b.outcome === 'opened' ? `Branch ${b.name} is active` : `Branch ${b.name} opens when the free trial ends`,
            body: b.outcome === 'opened' ? 'Open it from your branch list.' : null,
            dedupeKey: `branch:${b.requestId}:${b.outcome}`.slice(0, 120),
            payload: { requestId: b.requestId, branchId: b.branchId, name: b.name, outcome: b.outcome },
            createdAt: now,
          },
        });
      }
    }
  }
  return done;
}
