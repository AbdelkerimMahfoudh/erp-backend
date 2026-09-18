import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { ClosingController } from './closing.controller';
import { ClosingService } from './closing.service';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';

/**
 * Money's per-channel movement for a period (`GET closings/movements`).
 *
 * It must be the closing's own movement query over a range — not a second way
 * of adding money up — so the two screens cannot disagree.
 */

const service = readFileSync(join(__dirname, 'closing.service.ts'), 'utf8');
const movements = service.slice(
  service.indexOf('private async channelMovements('),
  service.indexOf('private async buildDigestLines('),
);

describe('period movements', () => {
  it('needs report.view, like the rest of Money', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, ClosingController.prototype.periodMovements)).toEqual([
      'report.view',
    ]);
  });

  it('every DATE-keyed component reads the whole range, none only one day', () => {
    expect(movements).not.toMatch(/= \$\{day\}/);
    expect((movements.match(/BETWEEN \$\{fromDay\} AND \$\{toDay\}/g) ?? []).length).toBe(4);
  });

  it('timestamp-keyed components use the half-open window of the range', () => {
    expect(movements).toMatch(/p\.paid_at >= \$\{start\} AND p\.paid_at < \$\{end\}/);
    expect(movements).toMatch(/paid_at >= \$\{start\} AND sp\.paid_at < \$\{end\}/);
    expect(movements).toMatch(/getTime\(\) \+ 86_400_000/);
  });

  it('sale money is dated by when it arrived, never by the sale (0074)', () => {
    // A later collection must land on the day it was received. Dating it by
    // the sale would count it on a day that may already be signed off.
    expect(movements).not.toMatch(/s\.sold_at >= \$\{start\}/);
    expect((movements.match(/p\.paid_at >= \$\{start\} AND p\.paid_at < \$\{end\}/g) ?? []).length).toBe(2);
  });

  it('the closing still asks for exactly one day', () => {
    expect(service).not.toMatch(/expectedChannels\(companyId, branchId, day, dayDate\)/);
    expect((service.match(/expectedChannels\(companyId, branchId, day, day\)/g) ?? []).length).toBe(3);
  });

  it('in and out are the closing components, and net is its expected figure', () => {
    const block = service.slice(service.indexOf('async periodMovements('), service.indexOf('async openView('));
    expect(block).toMatch(/moneyIn: round2\(ch\.salesIn \+ ch\.correctionsIn\)/);
    expect(block).toMatch(/moneyOut: round2\(ch\.refundsOut \+ ch\.supplierOut \+ ch\.expensesOut\)/);
    expect(block).toMatch(/net: ch\.expected/);
    expect(block).toMatch(/requireBranchId\(\)/);
  });

  it('refuses a malformed or reversed range before reading anything', async () => {
    const db = { receivingAccount: { findMany: jest.fn() }, $queryRaw: jest.fn() };
    const tenant = { companyId: () => Buffer.alloc(16), requireBranchId: () => Buffer.alloc(16) };
    const svc = Object.create(ClosingService.prototype) as ClosingService & Record<string, unknown>;
    Object.assign(svc, { db, tenant });
    await expect(svc.periodMovements('2026-09-10', '2026-09-01')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.periodMovements('10/09/2026', '2026-09-10')).rejects.toBeInstanceOf(BadRequestException);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
