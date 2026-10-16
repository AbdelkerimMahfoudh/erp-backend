import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConsignmentsService } from './consignments.service';
import { binToUuid } from '../common/utils/uuid.util';

/**
 * Reporting a multi-phone consignment as sold (2026-10-16 audit, BE6-01/02).
 *
 * The amount two shops agree on is for ALL the phones ("Amount for all of
 * them"). Two things went wrong with more than one phone, both reproduced over
 * real HTTP between two connected stores:
 *
 * - accepting copied that total onto every line and selling summed the lines,
 *   so three phones agreed at 30 000 raised a receivable of 90 000;
 * - reporting only some lines moved the whole consignment to "sold", and the
 *   phones left in custody could then never be sold, returned or cancelled.
 */

const SOURCE = Buffer.alloc(16, 1);
const HOLDER = Buffer.alloc(16, 2);
const BRANCH = Buffer.alloc(16, 3);
const USER = Buffer.alloc(16, 4);
const ID = Buffer.alloc(16, 5);
const lineId = (n: number) => Buffer.alloc(16, 0x10 + n);
const unitId = (n: number) => Buffer.alloc(16, 0x20 + n);

/** Three phones in the holder's shop, agreed at 30 000 for all of them. */
function harness(lineAmount: number | null) {
  const consignment = {
    id: ID,
    status: 'in_custody',
    version: 4,
    sourceCompanyId: SOURCE,
    sourceBranchId: BRANCH,
    destinationCompanyId: HOLDER,
    agreedAmount: new Prisma.Decimal(30000),
  };
  const lines = [1, 2, 3].map((n) => ({
    id: lineId(n),
    consignmentId: ID,
    unitId: unitId(n),
    status: 'in_custody',
    // What an accept before the fix wrote on every line: the whole amount.
    agreedAmount: lineAmount == null ? null : new Prisma.Decimal(lineAmount),
  }));
  const writes = { ledger: [] as any[], lines: [] as any[], units: [] as any[], status: [] as any[] };
  const db: any = {
    consignment: {
      findFirst: jest.fn(async () => consignment),
      updateMany: jest.fn(async (a: any) => (writes.status.push(a.data.status), { count: 1 })),
    },
    consignmentLine: {
      findMany: jest.fn(async () => lines),
      update: jest.fn(async (a: any) => writes.lines.push(a)),
    },
    unit: { updateMany: jest.fn(async (a: any) => (writes.units.push(a), { count: 1 })) },
    consignmentLedgerEntry: { create: jest.fn(async (a: any) => writes.ledger.push(a.data)) },
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const service = Object.assign(Object.create(ConsignmentsService.prototype), {
    prisma: db,
    tenant: { companyId: () => HOLDER, userId: () => USER },
    audit: { record: jest.fn(async () => undefined) },
    notifications: { emit: jest.fn(async () => undefined) },
  }) as ConsignmentsService;
  jest.spyOn(service, 'get').mockResolvedValue({} as never);
  return { service, writes, lines };
}

describe('reporting a multi-phone consignment as sold', () => {
  it('raises the agreed amount once, not once per phone (data written before the fix)', async () => {
    const { service, writes } = harness(30000);
    await service.reportSold(binToUuid(ID), {});
    expect(writes.ledger).toHaveLength(1);
    expect(writes.ledger[0]).toMatchObject({ kind: 'receivable_raised', amount: 30000 });
  });

  it('raises the agreed amount when the lines carry none', async () => {
    const { service, writes } = harness(null);
    await service.reportSold(binToUuid(ID), {});
    expect(writes.ledger[0]).toMatchObject({ kind: 'receivable_raised', amount: 30000 });
    expect(writes.units).toHaveLength(3);
  });

  it('naming every phone is the same as naming none', async () => {
    const { service, writes, lines } = harness(null);
    await service.reportSold(binToUuid(ID), { lineIds: lines.map((l) => binToUuid(l.id)) });
    expect(writes.ledger[0]).toMatchObject({ amount: 30000 });
    expect(writes.status).toEqual(['sold_awaiting_settlement']);
  });

  it('refuses some of the phones, and writes nothing — the rest would be stranded', async () => {
    const { service, writes, lines } = harness(null);
    await expect(
      service.reportSold(binToUuid(ID), { lineIds: [binToUuid(lines[0].id)] }),
    ).rejects.toThrow(BadRequestException);
    expect(writes).toEqual({ ledger: [], lines: [], units: [], status: [] });
  });
});
