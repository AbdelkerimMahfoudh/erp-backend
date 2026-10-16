import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConsignmentsService } from './consignments.service';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * Two money acts on one consignment at the same moment (2026-10-16 audit, BE6-03).
 *
 * Over real HTTP, ten simultaneous confirmations of ONE reported payment wrote
 * ten `payment_confirmed` rows, and ten write-offs at once each passed the
 * balance check against the same balance. The ledger is append-only, so every
 * duplicate was permanent.
 *
 * The world below interleaves every query (each one yields before answering)
 * and models the consignment row's `FOR UPDATE` as a lock held to the end of
 * the transaction: exactly the two things a race needs.
 */

const SOURCE = Buffer.alloc(16, 1);
const HOLDER = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 4);
const ID = Buffer.alloc(16, 5);
const REPORTED = Buffer.alloc(16, 6);

const tick = () => new Promise<void>((r) => setImmediate(r));
const same = (a: unknown, b: unknown) =>
  Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b;

function world() {
  const consignment = {
    id: ID,
    status: 'sold_awaiting_settlement',
    version: 6,
    sourceCompanyId: SOURCE,
    sourceBranchId: Buffer.alloc(16, 3),
    destinationCompanyId: HOLDER,
  };
  const ledger: any[] = [
    { id: Buffer.alloc(16, 7), consignmentId: ID, kind: 'receivable_raised', amount: 30000, refersToId: null },
    { id: REPORTED, consignmentId: ID, kind: 'payment_reported', amount: 1000, method: 'cash', refersToId: null },
  ];
  const matches = (where: Record<string, unknown>) => (row: any) =>
    Object.entries(where).every(([k, v]) => same(row[k], v));

  let held: Promise<void> | null = null;
  const db: any = {
    consignment: {
      findFirst: async () => (await tick(), consignment),
      updateMany: async () => (await tick(), { count: 1 }),
    },
    consignmentLedgerEntry: {
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

  const service = Object.assign(Object.create(ConsignmentsService.prototype), {
    prisma: db,
    tenant: { companyId: () => SOURCE, userId: () => USER },
    audit: { record: async () => undefined },
    notifications: { emit: async () => undefined },
  }) as ConsignmentsService;
  jest.spyOn(service, 'get').mockResolvedValue({} as never);
  const count = (kind: string) => ledger.filter((r) => r.kind === kind).length;
  return { service, count };
}

describe('money acts racing on one consignment', () => {
  it('a payment confirmed twice at once is confirmed once; the other is told', async () => {
    const { service, count } = world();
    const confirm = () =>
      service.payment(binToUuid(ID), { action: 'confirm', entryId: binToUuid(REPORTED) } as never);
    const answers = await Promise.allSettled([confirm(), confirm()]);
    expect(count('payment_confirmed')).toBe(1);
    expect(answers.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const refused = answers.find((a) => a.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ConflictException);
  });

  it('two write-offs of the whole balance at once forgive it once', async () => {
    const { service, count } = world();
    const forgive = () => service.forgive(binToUuid(ID), { amount: 30000, reason: 'Shop closed for good' });
    const answers = await Promise.allSettled([forgive(), forgive()]);
    expect(count('forgiven')).toBe(1);
    const refused = answers.find((a) => a.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(BadRequestException);
  });
});
