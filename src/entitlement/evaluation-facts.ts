import { Prisma, type SubscriptionStatus, type TrialEligibilityClosedReason } from '@prisma/client';

/**
 * What one entitlement evaluation reads about a company (review finding R1-F4): its subscription, its name and its
 * configured zone, and its free trial's two rows — the eligibility (its closure: when and why) and the claim.
 *
 * Every tenant request is evaluated (the entitlement interceptor), and the free trial's facts must be read on every
 * evaluation with no cache: a claim made on the website is what the very next request sees, and an ended trial stops
 * writes at its exact end (SPEC §2.2). Read through Prisma's relations they cost four round trips — subscriptions,
 * then companies, trial_eligibilities and trial_claims, each by company — where one indexed statement answers: the
 * subscription by its unique company key, and each other table by its own unique company key.
 */
export interface EvaluationFacts {
  id: Buffer;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  isComplimentary: boolean;
  complimentaryUntil: Date | null;
  subscribedBranchCount: number;
  additionalSeats: number;
  company: {
    name: string;
    timezone: string;
    trialEligibility: { closedAt: Date | null; closedReason: TrialEligibilityClosedReason | null } | null;
    trialClaim: { id: Buffer; claimedAt: Date; startedAt: Date; endsAt: Date; expiryRecordedAt: Date | null } | null;
  };
}

/** The statement's columns as MySQL answers them through `$queryRaw`. */
export interface EvaluationColumns {
  id: Uint8Array;
  status: string;
  current_period_end: Date | null;
  /** `TINYINT(1)`: a boolean, or the number MySQL stores. */
  is_complimentary: boolean | number | bigint;
  complimentary_until: Date | null;
  /** `INT UNSIGNED`: a number, or a bigint. */
  subscribed_branch_count: number | bigint;
  additional_seats: number | bigint;
  company_name: string;
  company_timezone: string;
  /** Present exactly when the eligibility row is: what tells "no eligibility" from "an open one". */
  eligibility_id: Uint8Array | null;
  eligibility_closed_at: Date | null;
  eligibility_closed_reason: string | null;
  /** Present exactly when the claim row is. */
  claim_id: Uint8Array | null;
  claim_claimed_at: Date | null;
  claim_started_at: Date | null;
  claim_ends_at: Date | null;
  claim_expiry_recorded_at: Date | null;
}

/**
 * The one statement: the subscription, joined to its company, LEFT JOINed to its eligibility and its claim — each on
 * `company_id`, each unique per company, so a company yields at most one row. No subscription row, no row: the
 * evaluation then reads the company as never subscribed, as before.
 */
export function evaluationRead(companyId: Buffer): Prisma.Sql {
  return Prisma.sql`
    SELECT s.id, s.status, s.current_period_end, s.is_complimentary, s.complimentary_until,
           s.subscribed_branch_count, s.additional_seats,
           c.name AS company_name, c.timezone AS company_timezone,
           e.id AS eligibility_id, e.closed_at AS eligibility_closed_at, e.closed_reason AS eligibility_closed_reason,
           t.id AS claim_id, t.claimed_at AS claim_claimed_at, t.started_at AS claim_started_at,
           t.ends_at AS claim_ends_at, t.expiry_recorded_at AS claim_expiry_recorded_at
      FROM subscriptions s
      JOIN companies c ON c.id = s.company_id
      LEFT JOIN trial_eligibilities e ON e.company_id = s.company_id
      LEFT JOIN trial_claims t ON t.company_id = s.company_id
     WHERE s.company_id = ${companyId}
     LIMIT 1`;
}

/**
 * The row in the shape the evaluation has always read (the Prisma relations it replaces): ids as Buffers, counts as
 * numbers, the flag as a boolean, and each trial row present exactly when its id is. A status MySQL coerced to `''`
 * (an empty `sql_mode`) is carried as it is, for the rules to read as no known status — expired, never permissive.
 */
export function evaluationFactsOf(row: EvaluationColumns): EvaluationFacts {
  const claim =
    row.claim_id && row.claim_claimed_at && row.claim_started_at && row.claim_ends_at
      ? {
          id: Buffer.from(row.claim_id),
          claimedAt: row.claim_claimed_at,
          startedAt: row.claim_started_at,
          endsAt: row.claim_ends_at,
          expiryRecordedAt: row.claim_expiry_recorded_at,
        }
      : null;
  return {
    id: Buffer.from(row.id),
    status: row.status as SubscriptionStatus,
    currentPeriodEnd: row.current_period_end,
    isComplimentary: Number(row.is_complimentary) === 1,
    complimentaryUntil: row.complimentary_until,
    subscribedBranchCount: Number(row.subscribed_branch_count),
    additionalSeats: Number(row.additional_seats),
    company: {
      name: row.company_name,
      timezone: row.company_timezone,
      trialEligibility: row.eligibility_id
        ? { closedAt: row.eligibility_closed_at, closedReason: row.eligibility_closed_reason as TrialEligibilityClosedReason | null }
        : null,
      trialClaim: claim,
    },
  };
}
