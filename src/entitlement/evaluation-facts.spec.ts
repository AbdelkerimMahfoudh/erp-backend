import { Logger } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { evaluationFactsOf, evaluationRead, type EvaluationColumns } from './evaluation-facts';
import { evaluationColumnsOf, isEvaluationRead } from './__testing__/evaluation-columns';

/**
 * The entitlement evaluation's one statement (review finding R1-F4): the subscription, the company's name and zone, and
 * the free trial's eligibility (its closure) and claim — read together on every evaluation, with no cache, in one
 * round trip instead of four.
 */

const COMPANY = Buffer.alloc(16, 7);
const HOUR = 3600_000;
const NOW = new Date('2026-10-15T12:00:00.000Z');

const columns = (over: Partial<EvaluationColumns> = {}): EvaluationColumns => ({
  id: new Uint8Array(16).fill(1),
  status: 'pending_activation',
  current_period_end: null,
  is_complimentary: 0,
  complimentary_until: null,
  subscribed_branch_count: 2n,
  additional_seats: 1n,
  company_name: 'Boutique',
  company_timezone: 'Africa/Casablanca',
  eligibility_id: null,
  eligibility_closed_at: null,
  eligibility_closed_reason: null,
  claim_id: null,
  claim_claimed_at: null,
  claim_started_at: null,
  claim_ends_at: null,
  claim_expiry_recorded_at: null,
  ...over,
});

describe('the statement', () => {
  it('is one SELECT: the subscription by its company, its company, and the two trial rows LEFT JOINed on company_id', () => {
    const sql = evaluationRead(COMPANY);
    const text = sql.strings.join('?').replace(/\s+/g, ' ').trim();
    expect(text.match(/\bSELECT\b/g)).toHaveLength(1);
    expect(text).toContain('FROM subscriptions s JOIN companies c ON c.id = s.company_id');
    expect(text).toContain('LEFT JOIN trial_eligibilities e ON e.company_id = s.company_id');
    expect(text).toContain('LEFT JOIN trial_claims t ON t.company_id = s.company_id');
    expect(text).toMatch(/WHERE s\.company_id = \? LIMIT 1$/);
    // The company is a bound parameter, never text in the statement.
    expect(sql.values).toEqual([COMPANY]);
    expect(isEvaluationRead(sql.strings)).toBe(true);
  });
});

describe('the row, in the shape the evaluation always read', () => {
  it('ids as Buffers, counts as numbers, the flag as a boolean — however MySQL typed them', () => {
    const facts = evaluationFactsOf(columns({ is_complimentary: 1, complimentary_until: NOW }));
    expect(Buffer.isBuffer(facts.id)).toBe(true);
    expect(facts).toMatchObject({ subscribedBranchCount: 2, additionalSeats: 1, isComplimentary: true, complimentaryUntil: NOW });
    expect(evaluationFactsOf(columns({ is_complimentary: true, subscribed_branch_count: 3 })).isComplimentary).toBe(true);
    expect(evaluationFactsOf(columns({ is_complimentary: 0n })).isComplimentary).toBe(false);
    expect(evaluationFactsOf(columns({ is_complimentary: false })).isComplimentary).toBe(false);
  });

  it('no trial rows: neither an eligibility nor a claim', () => {
    expect(evaluationFactsOf(columns()).company).toEqual({ name: 'Boutique', timezone: 'Africa/Casablanca', trialEligibility: null, trialClaim: null });
  });

  it('an open eligibility is one — an eligibility row is told from none by its id, not by its closure', () => {
    const open = evaluationFactsOf(columns({ eligibility_id: new Uint8Array(16).fill(2) }));
    expect(open.company.trialEligibility).toEqual({ closedAt: null, closedReason: null });
    const closed = evaluationFactsOf(columns({ eligibility_id: new Uint8Array(16).fill(2), eligibility_closed_at: NOW, eligibility_closed_reason: 'approved' }));
    expect(closed.company.trialEligibility).toEqual({ closedAt: NOW, closedReason: 'approved' });
  });

  it('a claim with its id and its instants, as stored', () => {
    const claimedAt = new Date(NOW.getTime() - HOUR);
    const endsAt = new Date(claimedAt.getTime() + 168 * HOUR);
    const facts = evaluationFactsOf(
      columns({ claim_id: new Uint8Array(16).fill(3), claim_claimed_at: claimedAt, claim_started_at: claimedAt, claim_ends_at: endsAt, claim_expiry_recorded_at: null }),
    );
    expect(facts.company.trialClaim).toEqual({ id: Buffer.alloc(16, 3), claimedAt, startedAt: claimedAt, endsAt, expiryRecordedAt: null });
  });

  it('a status MySQL coerced to an empty string is carried as it is — the rules read it as expired, never as access', () => {
    expect(evaluationFactsOf(columns({ status: '' })).status).toBe('');
  });
});

describe('one evaluation, one statement', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  /** A database that answers the evaluation's statement, and writes down every call made to it. */
  function recorded(row: EvaluationColumns | null) {
    const calls: string[] = [];
    const model = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, op: string) => async () => {
            calls.push(`${name}.${op}`);
            // The renewal check's own read: a business with nothing due.
            return name === 'subscription' ? { id: Buffer.alloc(16, 1), status: 'activated', currentPeriodEnd: null } : null;
          },
        },
      );
    const prisma = new Proxy(
      {},
      {
        get: (_target, key: string) => {
          if (key === '$queryRaw') {
            return async (q: { strings?: readonly string[] }) => {
              if (isEvaluationRead(q.strings)) {
                calls.push('evaluation read');
                return row ? [row] : [];
              }
              calls.push('raw');
              return [];
            };
          }
          return model(key);
        },
      },
    );
    return { prisma, calls };
  }

  const cases: [string, EvaluationColumns][] = [
    ['a paid business', evaluationColumnsOf({ status: 'activated', currentPeriodEnd: new Date(NOW.getTime() + 30 * 24 * HOUR) }, { name: 'Shop', timezone: 'UTC' }, null, null)],
    [
      'a trial running',
      evaluationColumnsOf({ status: 'pending_activation', currentPeriodEnd: null }, { name: 'Shop', timezone: 'UTC' }, { closedAt: null }, {
        id: Buffer.alloc(16, 9),
        claimedAt: new Date(NOW.getTime() - HOUR),
        startedAt: new Date(NOW.getTime() - HOUR),
        endsAt: new Date(NOW.getTime() + 167 * HOUR),
        expiryRecordedAt: null,
      }),
    ],
  ];

  it.each(cases)('%s: the write gate, within the renewal check’s minute, issues the joined read and nothing else', async (_name, row) => {
    const { prisma, calls } = recorded(row);
    const e = new EntitlementService(prisma as never, {} as never, { now: () => NOW });
    await e.writeRefusal(COMPANY);
    calls.length = 0;
    await e.writeRefusal(COMPANY);
    await e.operationalAccessBlocked(COMPANY);
    expect(calls).toEqual(['evaluation read', 'evaluation read']);
  });

  it('a status MySQL coerced to an empty string is refused as expired — read, never written', async () => {
    const { prisma } = recorded(columns({ status: '' }));
    const e = new EntitlementService(prisma as never, {} as never, { now: () => NOW });
    await expect(e.writeRefusal(COMPANY)).resolves.toMatchObject({ state: 'expired' });
    await expect(e.operationalAccessBlocked(COMPANY)).resolves.toBeNull();
  });

  it('no subscription row: one statement, answered as never subscribed', async () => {
    const { prisma, calls } = recorded(null);
    const e = new EntitlementService(prisma as never, {} as never, { now: () => NOW });
    await e.writeRefusal(COMPANY);
    calls.length = 0;
    await expect(e.writeRefusal(COMPANY)).resolves.toMatchObject({ state: 'expired' });
    expect(calls).toEqual(['evaluation read']);
  });
});
