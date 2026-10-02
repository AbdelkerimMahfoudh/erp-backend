import { NotFoundException } from '@nestjs/common';
import { CatalogService } from '../../catalog/catalog.service';
import { ConnectionsService } from '../../consignment/connections.service';
import { ConsignmentsService } from '../../consignment/consignments.service';
import { DiscountApprovalsService } from '../../discount-approvals/discount-approvals.service';
import { GoalsService } from '../../goals/goals.service';
import { LoansService } from '../../loans/loans.service';
import { TransfersService } from '../../transfers/transfers.service';

/**
 * A record id that is not a uuid — a mistyped deep link, a stale notification,
 * a probe — is "not found", never a crash.
 *
 * `uuidToBin` throws a plain Error on anything but 36 uuid characters, and a
 * plain Error is a 500 with a stack trace in the log. Every read by id answers
 * exactly as it does for a well-formed id that names nothing: 404, before the
 * database is asked anything. Sales, returns, expenses and corrections already
 * did; these did not.
 */
const BAD = 'not-a-uuid';
const COMPANY = Buffer.alloc(16, 1);
const BRANCH = Buffer.alloc(16, 2);
const USER = Buffer.alloc(16, 3);
const tenant = { companyId: () => COMPANY, requireBranchId: () => BRANCH, branchId: () => BRANCH, userId: () => USER };

/** A service with only the collaborators the id guard runs before. */
function bare(ctor: new (...args: never[]) => unknown, fields: Record<string, unknown>): any {
  return Object.assign(Object.create(ctor.prototype), fields);
}

/** A delegate that must not be reached: a malformed id is answered before any query. */
const untouched = () => ({
  findFirst: jest.fn(async () => {
    throw new Error('the database was asked about a malformed id');
  }),
  findUnique: jest.fn(async () => {
    throw new Error('the database was asked about a malformed id');
  }),
});

describe('a malformed record id is not found, never a crash', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['consignments: reading one', () => bare(ConsignmentsService, { tenant, prisma: { consignment: untouched() } }).get(BAD)],
    ['consignments: acting on one', () => bare(ConsignmentsService, { tenant, prisma: { consignment: untouched() } }).mine(BAD)],
    ['connections: the summary of one', () => bare(ConnectionsService, { tenant, prisma: { storeConnection: untouched() } }).summary(BAD)],
    ['discount approvals: reading one', () => bare(DiscountApprovalsService, { tenant, db: { discountApproval: untouched() }, cls: { get: () => new Set() } }).get(BAD)],
    ['discount approvals: cancelling one', () => bare(DiscountApprovalsService, { tenant, db: { discountApproval: untouched() } }).cancel(BAD)],
    [
      'discount approvals: deciding one',
      () =>
        bare(DiscountApprovalsService, { tenant, db: { discountApproval: untouched() }, cls: { get: () => new Set(['discount.override']) } }).decide(BAD, {
          approve: true,
          expectedVersion: 0,
        }),
    ],
    ['goals: reading one', () => bare(GoalsService, { tenant, db: { goal: untouched() } }).get(BAD)],
    ['goals: archiving one', () => bare(GoalsService, { tenant, db: { goal: untouched() } }).archive(BAD, { reason: 'typo' })],
    ['loans: reading one', () => bare(LoansService, { tenant, prisma: { loan: untouched() } }).get(BAD)],
    ['loans: acting on one', () => bare(LoansService, { tenant, prisma: { loan: untouched() } }).mine(BAD)],
    ['transfers: reading one', () => bare(TransfersService, { tenant, db: { stockTransfer: untouched() } }).getById(BAD)],
    ['transfers: acting on one', () => bare(TransfersService, { tenant, db: { stockTransfer: untouched() } }).load(BAD)],
  ])('%s', async (_name, run) => {
    await expect(run()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a product suggestion for a malformed id is "nothing matched", as for an unknown one', async () => {
    const svc = bare(CatalogService, { db: { product: untouched() } });
    await expect(svc.findOrSuggest({ productId: BAD })).resolves.toBeNull();
  });
});
