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

  it('every component reads the whole range of STORED dates, none only one day (0076)', () => {
    expect(movements).not.toMatch(/= \$\{day\}/);
    // cash payments, account payments, refunds, settlements, purchase payments, expenses, corrections
    expect((movements.match(/BETWEEN \$\{fromDay\} AND \$\{toDay\}/g) ?? []).length).toBe(7);
  });

  it('no component reads a timestamp window any more — every day is a stored date', () => {
    expect(movements).not.toMatch(/paid_at >= /);
    expect(movements).not.toMatch(/86_400_000/);
    expect(movements).toMatch(/p\.business_date BETWEEN \$\{fromDay\} AND \$\{toDay\}/);
    expect(movements).toMatch(/sp\.business_date BETWEEN \$\{fromDay\} AND \$\{toDay\}/);
  });

  it('sale money is dated by the business date it arrived on, never by the sale (0074, 0076)', () => {
    // A later collection must land on the day it was received. Dating it by
    // the sale would count it on a day that may already be signed off.
    expect(movements).not.toMatch(/s\.sold_at/);
    expect((movements.match(/\bp\.business_date BETWEEN \$\{fromDay\} AND \$\{toDay\}/g) ?? []).length).toBe(2);
  });

  it('the closing still asks for exactly one day, with the drawer’s opening balance', () => {
    expect(service).not.toMatch(/expectedChannels\(companyId, branchId, day, dayDate\)/);
    expect((service.match(/expectedChannels\(companyId, branchId, day, day, openingCash\)/g) ?? []).length).toBe(3);
    // Money's period view never carries an opening balance: a period's net is what moved.
    expect(service).toMatch(/expectedChannels\(companyId, branchId, from, to\)/);
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
