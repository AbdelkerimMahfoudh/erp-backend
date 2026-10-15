import type { EvaluationColumns } from '../evaluation-facts';

/**
 * The entitlement evaluation's one statement (R1-F4; evaluation-facts.ts) for the in-memory databases of the specs:
 * how a fake recognises it by its text, and the row MySQL would answer from the rows the fake holds.
 */

/** The joined read, recognised by its text whatever its whitespace. */
export function isEvaluationRead(strings: readonly string[] | undefined): boolean {
  const text = (strings ?? []).join('?').replace(/\s+/g, ' ');
  return /FROM subscriptions s JOIN companies c ON c\.id = s\.company_id LEFT JOIN trial_eligibilities e ON e\.company_id = s\.company_id LEFT JOIN trial_claims t ON t\.company_id = s\.company_id WHERE s\.company_id = \? LIMIT 1/.test(
    text,
  );
}

/** A subscription row as a fake holds it; what it leaves out reads as the column's default. */
export interface FakeSubscription {
  id?: Buffer;
  status: string;
  currentPeriodEnd: Date | null;
  isComplimentary?: boolean;
  complimentaryUntil?: Date | null;
  subscribedBranchCount?: number;
  additionalSeats?: number;
}

/**
 * The row MySQL answers for a subscription, its company and its two trial rows — typed as `$queryRaw` delivers them
 * there (measured on MySQL 8.0 through Prisma 5.22): the flag a number, the counts bigints, the ids Buffers.
 */
export function evaluationColumnsOf(
  sub: FakeSubscription,
  company: { name: string; timezone: string },
  eligibility: { id?: Buffer; closedAt: Date | null; closedReason?: string | null } | null,
  claim: { id: Buffer; claimedAt: Date; startedAt: Date; endsAt: Date; expiryRecordedAt: Date | null } | null,
): EvaluationColumns {
  return {
    id: sub.id ?? Buffer.alloc(16, 0x51),
    status: sub.status,
    current_period_end: sub.currentPeriodEnd,
    is_complimentary: sub.isComplimentary ? 1 : 0,
    complimentary_until: sub.complimentaryUntil ?? null,
    subscribed_branch_count: BigInt(sub.subscribedBranchCount ?? 1),
    additional_seats: BigInt(sub.additionalSeats ?? 0),
    company_name: company.name,
    company_timezone: company.timezone,
    eligibility_id: eligibility ? (eligibility.id ?? Buffer.alloc(16, 0xe1)) : null,
    eligibility_closed_at: eligibility?.closedAt ?? null,
    eligibility_closed_reason: eligibility?.closedReason ?? null,
    claim_id: claim?.id ?? null,
    claim_claimed_at: claim?.claimedAt ?? null,
    claim_started_at: claim?.startedAt ?? null,
    claim_ends_at: claim?.endsAt ?? null,
    claim_expiry_recorded_at: claim?.expiryRecordedAt ?? null,
  };
}
