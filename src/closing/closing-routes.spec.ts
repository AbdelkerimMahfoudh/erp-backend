import 'reflect-metadata';
import { ClosingController } from './closing.controller';
import { CorrectionsController } from '../corrections/corrections.controller';
import { timelinePayload } from './closing.service';
import { DashboardController } from '../analytics/dashboard.controller';
import { ConnectionsController } from '../consignment/connections.controller';
import { UsersController } from '../users/users.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { DELEGATABLE_PERMISSIONS, mayHoldDelegated } from '../rbac/permission-scope';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';

const perms = (ctor: { prototype: object }, method: string): string[] | undefined =>
  Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, (ctor.prototype as Record<string, unknown>)[method] as object);

/**
 * Who may reach what (docs/50 §3.3): the closing authority is one key held by
 * the Owner and the two delegates; the early start is the Owner's alone; Home
 * is everyone's and gates itself inside; the ranking is a partner read.
 */
describe('closing routes and authority (0076)', () => {
  it('reopening needs the same authority as closing', () => {
    expect(perms(ClosingController, 'reopen')).toEqual(['closing.perform']);
    expect(perms(ClosingController, 'close')).toEqual(['closing.perform']);
  });

  it('opening the boutique is whoever may count; a closed day is reopened with the closing authority', () => {
    expect(perms(ClosingController, 'open')).toEqual(['closing.count']);
  });

  it('the Daily closing report is readable by whoever may count; reading it confers nothing (docs/51 D6)', () => {
    expect(perms(ClosingController, 'report')).toEqual(['closing.count']);
    // Closing stays the closing authority — the Owner and at most two delegates.
    expect(perms(ClosingController, 'close')).toEqual(['closing.perform']);
    expect(perms(ClosingController, 'reopen')).toEqual(['closing.perform']);
  });

  it('"Correct a transaction" lists sources to counters, gated again in the service; a preview needs the correction authority', () => {
    expect(perms(ClosingController, 'sources')).toEqual(['closing.count']);
    expect(perms(CorrectionsController, 'preview')).toEqual(['financial.correction.request']);
    expect(perms(CorrectionsController, 'request')).toEqual(['financial.correction.request']);
    expect(perms(CorrectionsController, 'approve')).toEqual(['financial.correction.approve']);
  });

  it('the timeline never carries a close’s stored report, sales total or profit (docs/51 §12.1)', () => {
    const stored = { expectedCash: 28_800, countedCash: null, difference: null, verified: false, unverifiedCount: 2, netProfit: 7_750, totalSales: 45_500, report: { result: { grossProfit: 7_750 } }, clientUuid: 'x', verification: { reason: 'App down' } };
    const shown = timelinePayload('closed', stored);
    expect(shown).toEqual({ expectedCash: 28_800, countedCash: null, difference: null, verified: false, unverifiedCount: 2 });
    expect(JSON.stringify(timelinePayload('reclosed', stored))).not.toMatch(/netProfit|totalSales|report|grossProfit/);
    expect(timelinePayload('unknown_kind', stored)).toEqual({});
  });

  it('by role, only the Owner holds the closing authority (0078); every delegate is named', () => {
    for (const role of ['administrator', 'branch_manager', 'store_manager', 'store_employee'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('closing.perform');
    }
    expect(ROLE_PERMISSIONS.owner).toContain('closing.perform');
  });

  it('the business day and the live view are readable by whoever may count', () => {
    expect(perms(ClosingController, 'businessDay')).toEqual(['closing.count']);
    expect(perms(ClosingController, 'openView')).toEqual(['closing.count']);
    expect(perms(ClosingController, 'recordCount')).toEqual(['closing.count']);
  });

  it('Home carries no route permission — every section is gated inside', () => {
    expect(perms(DashboardController, 'home')).toBeUndefined();
    expect(perms(DashboardController, 'full')).toEqual(['report.view']);
  });

  it('the partner ranking is a partner read', () => {
    expect(perms(ConnectionsController, 'partnerRanking')).toEqual(['consignment.view']);
  });

  it('naming a closing delegate is the Owner’s, through the same explicit route shape as price editing', () => {
    expect(perms(UsersController, 'grantClosing')).toEqual(['user.manage']);
    expect(perms(UsersController, 'revokeClosing')).toEqual(['user.manage']);
    expect(perms(UsersController, 'grantPriceEdit')).toEqual(['user.manage']);
  });

  it('closing.perform is delegatable to a manager or an employee; the early start to nobody', () => {
    expect(DELEGATABLE_PERMISSIONS.has('closing.perform')).toBe(true);
    expect(DELEGATABLE_PERMISSIONS.has('closing.start_early')).toBe(false);
    expect(mayHoldDelegated('closing.perform', 'store_manager')).toBe(true);
    expect(mayHoldDelegated('closing.perform', 'store_employee')).toBe(true);
    expect(mayHoldDelegated('closing.perform', 'owner')).toBe(false);
    expect(mayHoldDelegated('price.edit', 'store_employee')).toBe(false);
  });

  it('by role, no store role but the Owner closes, and only the Owner starts a day early', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('closing.perform');
    expect(ROLE_PERMISSIONS.owner).toContain('closing.start_early');
    for (const role of ['store_manager', 'store_employee'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('closing.perform');
    }
    // The platform's internal Administrator (D11) keeps its technical
    // super-set, minus the money-sensitive keys and the shop's own early start.
    for (const role of ['store_manager', 'store_employee', 'administrator'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('closing.start_early');
    }
    expect(ROLE_PERMISSIONS.store_manager).toContain('closing.count');
    expect(ROLE_PERMISSIONS.store_employee).toContain('closing.count');
  });
});
