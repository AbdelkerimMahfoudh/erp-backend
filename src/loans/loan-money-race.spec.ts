import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LoansService } from './loans.service';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * Two money acts on one loan at the same moment (2026-10-16 audit, BE3-01).
 *
 * Over real HTTP, ten simultaneous confirmations of ONE reported 5 000 wrote
 * seven `payment_confirmed` rows (remaining 10 000 → −25 000), ten reversals of
 * one confirmed payment wrote seven `payment_corrected` rows, and ten write-offs
 * of the whole balance wrote eight. The ledger is append-only, so every
 * duplicate was permanent.
 *
 * The world below interleaves every query (each one yields before answering)
 * and models the loan row's `FOR UPDATE` as a lock held to the end of the
 * transaction: exactly the two things a race needs.
 */

const LENDER = Buffer.alloc(16, 1);
const BORROWER = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 4);
const ID = Buffer.alloc(16, 5);
const REPORTED = Buffer.alloc(16, 6);
const CONFIRMED = Buffer.alloc(16, 8);

const tick = () => new Promise<void>((r) => setImmediate(r));
const same = (a: unknown, b: unknown) =>
  Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b;

/** 10 000 lent; a 5 000 report waiting; an earlier 2 000 already confirmed. */
function world() {
  const loan = {
    id: ID,
    companyId: LENDER,
    counterpartyCompanyId: BORROWER,
    direction: 'they_owe_us',
    status: 'payment_awaiting_confirmation',
    principal: new Prisma.Decimal(10000),
    branchId: null,
    version: 3,
  };
  const ledger: any[] = [
    { id: Buffer.alloc(16, 7), loanId: ID, kind: 'principal_accepted', amount: 10000, refersToId: null },
    { id: Buffer.alloc(16, 9), loanId: ID, kind: 'payment_reported', amount: 2000, method: 'cash', refersToId: null },
    { id: CONFIRMED, loanId: ID, kind: 'payment_confirmed', amount: 2000, refersToId: Buffer.alloc(16, 9) },
    { id: REPORTED, loanId: ID, kind: 'payment_reported', amount: 5000, method: 'cash', refersToId: null },
  ];
  const matches = (where: Record<string, unknown>) => (row: any) =>
    Object.entries(where).every(([k, v]) => same(row[k], v));

  let held: Promise<void> | null = null;
  const db: any = {
    loan: {
      findFirst: async () => (await tick(), loan),
      updateMany: async () => (await tick(), { count: 1 }),
    },
    loanLedgerEntry: {
      findFirst: async ({ where }: any) => (await tick(), ledger.find(matches(where)) ?? null),
      findMany: async ({ where }: any) => (await tick(), ledger.filter(matches(where))),
      create: async ({ data }: any) => (await tick(), ledger.push(data), data),
    },
  };
  db.$transaction = async (fn: (tx: unknown) => unknown) => {
    let release = () => undefined as void;
    const tx = {
      ...db,
      // `SELECT … FOR UPDATE`: wait while another transaction holds the row.
      $queryRaw: async () => {
        while (held) await held;
        held = new Promise<void>((r) => (release = () => ((held = null), r())));
        return [{ id: ID }];
      },
    };
    try {
      return await fn(tx);
    } finally {
      release();
    }
  };

  const service = Object.assign(Object.create(LoansService.prototype), {
    prisma: db,
    tenant: { companyId: () => LENDER, userId: () => USER },
    audit: { record: async () => undefined },
    notifications: { emit: async () => undefined },
  }) as LoansService;
  jest.spyOn(service, 'get').mockResolvedValue({} as never);
  const count = (kind: string) => ledger.filter((r) => r.kind === kind).length;
  return { service, count };
}

const twice = async (act: () => Promise<unknown>) => {
  const answers = await Promise.allSettled([act(), act()]);
  const refused = answers.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
  return { fulfilled: answers.length - refused.length, refused: refused.map((r) => r.reason) };
};

describe('money acts racing on one loan', () => {
  it('a payment confirmed twice at once is confirmed once; the other is told', async () => {
    const { service, count } = world();
    const r = await twice(() =>
      service.payment(binToUuid(ID), { action: 'confirm', entryId: binToUuid(REPORTED) } as never),
    );
    expect(count('payment_confirmed')).toBe(2); // the earlier 2 000, and this one once
    expect(r.fulfilled).toBe(1);
    expect(r.refused[0]).toBeInstanceOf(ConflictException);
  });

  it('a confirmed payment reversed twice at once is reversed once', async () => {
    const { service, count } = world();
    const r = await twice(() =>
      service.payment(binToUuid(ID), {
        action: 'correct',
        entryId: binToUuid(CONFIRMED),
        reason: 'The transfer bounced',
      } as never),
    );
    expect(count('payment_corrected')).toBe(1);
    expect(r.refused[0]).toBeInstanceOf(ConflictException);
  });

  it('two write-offs of the whole balance at once forgive it once', async () => {
    const { service, count } = world();
    const r = await twice(() => service.forgive(binToUuid(ID), { amount: 8000, reason: 'They closed the shop' }));
    expect(count('forgiven')).toBe(1);
    expect(r.refused[0]).toBeInstanceOf(BadRequestException);
  });
});
