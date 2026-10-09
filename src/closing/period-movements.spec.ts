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
    // cash payments, account payments, refunds, settlements, purchase payments, expenses, the older
    // corrections, every other correction's legs through one ledger (0078's two arms folded in, 0079),
    // and the agent counter's cash legs (D154): nine reads of the range, each on a stored date.
    expect((movements.match(/BETWEEN \$\{fromDay\} AND \$\{toDay\}/g) ?? []).length).toBe(9);
    // The agent legs: the drawer's channel, no account, in and out by the leg's direction; a float leg never arrives here.
    expect(movements).toMatch(/SELECT 'cash', NULL, IF\(m\.direction = 'inflow', 'agentIn', 'agentOut'\), SUM\(m\.amount\)\s+FROM agent_movements m\s+WHERE m\.company_id = \$\{companyId\} AND m\.branch_id = \$\{branchId\}\s+AND m\.account_kind = 'cash' AND m\.business_date BETWEEN \$\{fromDay\} AND \$\{toDay\}\s+GROUP BY m\.direction/);
    expect(movements).toMatch(/fc\.correction_date BETWEEN \$\{fromDay\} AND \$\{toDay\}\s+GROUP BY l\.method, l\.receiving_account_id, l\.direction/);
  });

  it("the older corrections group by exactly what they select — MySQL's default ONLY_FULL_GROUP_BY accepts it", () => {
    // Grouping by the bare COALESCE while selecting it inside IF() failed every
    // closing read on a server with the default sql_mode (live runs it empty).
    const branch = movements.slice(movements.indexOf("'correctionsIn', SUM(fc.amount)"), movements.indexOf('FROM financial_correction_legs'));
    expect(branch).toMatch(
      /GROUP BY IF\(fc\.method = 'cash', 'cash', 'account'\),\s+IF\(fc\.method = 'cash', NULL, COALESCE\(rp\.receiving_account_id, ss\.receiving_account_id\)\)/,
    );
    expect(branch).not.toMatch(/GROUP BY fc\.method, COALESCE/);
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
    // One place asks for a day's channels, with its opening and the amount set when the shop opened (docs/63):
    // the count, the live view, the report (which the close is built on) and Money all read the day through it.
    expect((service.match(/expectedChannels\(companyId, branchId, day, day, chain\.opening\.amount, adjustment\)/g) ?? []).length).toBe(1);
    expect((service.match(/await this\.dayChannels\(companyId, branchId, (day|today)\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(service).not.toMatch(/expectedChannels\(companyId, branchId, day, day, openingCash\)/);
    // Money's period view never carries an opening balance: a period's net is what moved.
    expect(service).toMatch(/expectedChannels\(companyId, branchId, from, to\)/);
  });

  it('in and out are the closing components, and net is its expected figure', () => {
    const block = service.slice(service.indexOf('async periodMovements('), service.indexOf('async openView('));
    // The drawer's in and out carry the agent counter's cash since D154, so net = in − out still holds for the drawer.
    expect(block).toMatch(/moneyIn: round2\(ch\.salesIn \+ ch\.correctionsIn \+ ch\.agentIn\)/);
    expect(block).toMatch(/moneyOut: round2\(ch\.refundsOut \+ ch\.supplierOut \+ ch\.expensesOut \+ ch\.correctionsOut \+ ch\.agentOut\)/);
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
