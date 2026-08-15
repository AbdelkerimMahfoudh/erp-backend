import { BadRequestException, ConflictException } from '@nestjs/common';

/**
 * The payable rules, kept pure so they can be reasoned about and tested
 * directly — allocation arithmetic is exactly the sort of logic that looks
 * obviously right and quietly is not.
 *
 * Nothing here reads the database. What is outstanding is always computed from
 * immutable rows by the caller and handed in; these functions decide what may
 * be done with it.
 */

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** One purchase, and what is still owed on it. */
export interface OutstandingPurchase {
  purchaseId: string;
  /** What was agreed with the supplier. Never rewritten. */
  total: number;
  /** Sum of confirmed allocations against it. */
  paid: number;
  outstanding: number;
  /** Oldest first — the order money is offered against by default. */
  date: Date;
}

export interface AllocationInput {
  purchaseId: string;
  amount: number;
}

/**
 * Spread an amount across the oldest unpaid purchases.
 *
 * Offered as a CONVENIENCE, never applied silently: the caller shows the
 * result before anything is submitted, and the server returns the allocation it
 * actually recorded. Money that lands somewhere the person did not look at is
 * money nobody can explain later.
 */
export function allocateOldestFirst(
  amount: number,
  purchases: OutstandingPurchase[],
): AllocationInput[] {
  let left = round2(amount);
  const out: AllocationInput[] = [];
  const oldest = [...purchases]
    .filter((p) => p.outstanding > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const p of oldest) {
    if (left <= 0) break;
    const take = round2(Math.min(left, p.outstanding));
    if (take > 0) {
      out.push({ purchaseId: p.purchaseId, amount: take });
      left = round2(left - take);
    }
  }
  return out;
}

/**
 * Check an allocation against what is actually outstanding.
 *
 * Every refusal names the purchase and the figures, because "payment refused"
 * tells the person at the counter nothing they can act on.
 */
export function assertAllocationFits(
  amount: number,
  allocations: AllocationInput[],
  outstandingByPurchase: Map<string, OutstandingPurchase>,
): void {
  if (allocations.length === 0) {
    throw new BadRequestException('Say which purchases this payment settles');
  }

  const seen = new Set<string>();
  const problems: Record<string, unknown>[] = [];
  let total = 0;

  for (const a of allocations) {
    if (a.amount <= 0) {
      problems.push({ purchaseId: a.purchaseId, reason: 'amount must be more than zero' });
      continue;
    }
    if (seen.has(a.purchaseId)) {
      // Two lines for one purchase is how a duplicate hides in a total that
      // still adds up.
      problems.push({ purchaseId: a.purchaseId, reason: 'listed twice' });
      continue;
    }
    seen.add(a.purchaseId);

    const p = outstandingByPurchase.get(a.purchaseId);
    if (!p) {
      problems.push({ purchaseId: a.purchaseId, reason: 'not an open purchase for this supplier' });
      continue;
    }
    if (round2(a.amount) > round2(p.outstanding)) {
      problems.push({
        purchaseId: a.purchaseId,
        reason: 'more than is owed on this purchase',
        outstanding: round2(p.outstanding),
        requested: round2(a.amount),
      });
      continue;
    }
    total = round2(total + a.amount);
  }

  if (problems.length > 0) {
    throw new BadRequestException({ message: 'That payment cannot be applied', problems });
  }
  if (round2(total) !== round2(amount)) {
    throw new BadRequestException({
      message: 'The allocation does not add up to the amount paid',
      problems: [{ amount: round2(amount), allocated: round2(total) }],
    });
  }
}

/**
 * The last gate, run inside the confirmation transaction against committed
 * rows — not against what the screen was showing when somebody pressed the
 * button.
 *
 * This is what makes two managers confirming at once safe: the second one
 * re-reads the outstanding figure the first has already reduced, and is
 * refused rather than overpaying.
 */
export function assertStillPayable(
  allocations: AllocationInput[],
  outstandingByPurchase: Map<string, OutstandingPurchase>,
): void {
  for (const a of allocations) {
    const p = outstandingByPurchase.get(a.purchaseId);
    if (!p || round2(a.amount) > round2(p.outstanding)) {
      throw new ConflictException({
        code: 'refresh_required',
        message: 'Some of this has already been paid. Refresh and try again.',
        problems: [
          {
            purchaseId: a.purchaseId,
            outstanding: p ? round2(p.outstanding) : 0,
            requested: round2(a.amount),
          },
        ],
      });
    }
  }
}

/** How fully a purchase has been paid, derived — never a stored decision. */
export function purchaseStatusOf(total: number, paid: number): 'unpaid' | 'partial' | 'paid' {
  if (round2(paid) <= 0) return 'unpaid';
  if (round2(paid) >= round2(total)) return 'paid';
  return 'partial';
}

/**
 * A stable fingerprint of what was reported, so replaying a request id with a
 * DIFFERENT payment is a conflict rather than a misleading success.
 *
 * Allocation ORDER carries no meaning and must not change the answer — the same
 * money against the same purchases is the same payment however it was listed.
 */
export function settlementFingerprint(input: {
  supplierId: string;
  amount: number;
  method: string;
  receivingAccountId?: string | null;
  allocations: AllocationInput[];
}): string {
  const canonical = {
    supplierId: input.supplierId.toLowerCase(),
    amount: round2(input.amount).toFixed(2),
    method: input.method,
    account: input.receivingAccountId?.toLowerCase() ?? null,
    allocations: input.allocations
      .map((a) => `${a.purchaseId.toLowerCase()}:${round2(a.amount).toFixed(2)}`)
      .sort(),
  };
  // Required lazily so this module stays importable without node crypto in a
  // pure test context.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
