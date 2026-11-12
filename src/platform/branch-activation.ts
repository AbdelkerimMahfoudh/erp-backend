import type { BillingDb } from '../billing/billing.service';
import { binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';
import { openStoreTx } from './store-opening';
import type { BranchEntitlementService } from '../entitlement/branch-entitlement.service';

export interface ActivatedBranch {
  requestId: string;
  name: string;
  /** 0132: always `opened` — a paid branch opens at approval, never at the first branch's trial end (docs/122). */
  outcome: 'opened';
  branchId: string;
  /** Its own paid period. */
  startsAt: string;
  endsAt: string;
}

/**
 * The branches added in the app and waiting for activation, activated by an approved payment (0130; the owner's brief of
 * 2026-11-05) — inside the caller's transaction, the one that applies the paid period, so the period, the branches and
 * their records commit together or not at all.
 *
 * - Each pending store request of its own (not one taking an archived store's place) is marked paid by the payment.
 * - It opens now — the branch created, every Owner assigned, the subscribed store count raised (`openStoreTx`) — with
 *   its own paid entitlement for the months paid, from this approval (0132; docs/122). The business's free trial, if
 *   one runs, is the first branch's alone: the new branch neither receives it nor waits for its end.
 * - The Owners are told in the app that the branch is active.
 *
 * Idempotent: only requests still `pending_payment` move, guarded by their version; a repeated approval finds none.
 */
export async function activatePendingBranchesTx(
  tx: BillingDb,
  input: {
    companyId: Buffer;
    subscriptionId: Buffer;
    paymentId: Buffer | null;
    proofId: Buffer | null;
    months: number;
    /** Each waiting request's priced line, by request id (the proof's lines); absent: priced by the catalogue. */
    amounts?: Map<string, number>;
    actor: string;
    reference: string;
    now: Date;
    branches: Pick<BranchEntitlementService, 'applyPaidTx'>;
  },
): Promise<ActivatedBranch[]> {
  const { companyId, now } = input;
  const pending = await tx.seatAllocation.findMany({
    where: { companyId, kind: 'store', status: 'pending_payment', replacesBranchId: null },
    orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
  });
  if (pending.length === 0) return [];
  const done: ActivatedBranch[] = [];

  for (const row of pending) {
    const name = row.label ?? 'New branch';
    const moved = await tx.seatAllocation.updateMany({
      where: { id: row.id, companyId, status: 'pending_payment', version: row.version },
      data: { status: 'paid', paymentId: input.paymentId, confirmedBy: input.actor, confirmedAt: now, effectiveAt: now, version: { increment: 1 } },
    });
    if (moved.count !== 1) continue;
    const activity = row.activityTo ?? 'electronics';
    const branchId = await openStoreTx(tx, {
      companyId,
      subscriptionId: input.subscriptionId,
      name,
      nameAr: row.labelAr,
      activity,
      address: row.location,
      actor: input.actor,
      note: `Branch "${name}" (${activity}), added in the app, opened with payment ${input.reference}.`,
      entitlement: 'own',
    });
    await tx.seatAllocation.updateMany({ where: { id: row.id, branchId: null }, data: { branchId } });
    const period = await input.branches.applyPaidTx(tx as never, {
      companyId,
      branchId,
      months: input.months,
      amount: input.amounts?.get(binToUuid(row.id)) ?? null,
      paymentId: input.paymentId,
      proofId: input.proofId,
      actor: input.actor,
      now,
    });
    // 0137: its own paid month covers it; the business's billing period skips its fee until then.
    await tx.seatAllocation.updateMany({ where: { id: row.id }, data: { ownPaidUntil: period.endsAt } });
    done.push({ requestId: binToUuid(row.id), name, outcome: 'opened', branchId: binToUuid(branchId), startsAt: period.startsAt.toISOString(), endsAt: period.endsAt.toISOString() });
  }

  // The Owners, in the app: the branch is active.
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
            type: 'branch.activated',
            title: `Branch ${b.name} is active`,
            body: 'Open it from your branch list.',
            dedupeKey: `branch:${b.requestId}:${b.outcome}`.slice(0, 120),
            payload: { requestId: b.requestId, branchId: b.branchId, name: b.name, outcome: b.outcome, endsAt: b.endsAt },
            createdAt: now,
          },
        });
      }
    }
  }
  return done;
}
