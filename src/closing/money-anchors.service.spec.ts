import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { binToUuid, uuidToBin } from '../common/utils/uuid.util';
import { dateValue } from '../common/business-day/business-day.service';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { DELEGATABLE_PERMISSIONS, isCompanyPermission } from '../rbac/permission-scope';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { periodFigures } from '../analytics/period-figures';
import { buildChannels } from './channels';
import { ClosingModule } from './closing.module';
import { ClosingService } from './closing.service';
import { MoneyAnchorsController } from './money-anchors.controller';
import { MoneyAnchorsService } from './money-anchors.service';
import { anchorFingerprint, type DeclaredAnchor } from './money-positions';

jest.mock('../analytics/period-figures', () => ({ periodFigures: jest.fn() }));

/**
 * Recording what an account holds (`POST /money/anchors`) and the tracked
 * positions Money's top card reads. The database is mocked, so what is asserted
 * is exactly what would be locked, read and written.
 */

const COMPANY = Buffer.from('01a091c77eac76ada3384092cc1e12e4', 'hex');
const BRANCH = Buffer.from('01a091c77f1e7f5db52a64ee21b95896', 'hex');
const USER = Buffer.from('01a091c77f2b764da36774d37794e74f', 'hex');
const BANKILY = '01a0b1c2-0000-7000-8000-00000000000b';
const MASRVI = '01a0b1c2-0000-7000-8000-00000000000c';
const RETIRED = '01a0b1c2-0000-7000-8000-00000000000d';
const KEY = '01a0b1c2-0000-7000-8000-0000000000aa';

interface StoredAnchor {
  id: Buffer;
  receivingAccountId: Buffer;
  labelSnapshot: string;
  amount: number;
  at: Date;
  businessDate: Date;
  trackedBefore: number | null;
  difference: number | null;
  note: string | null;
  clientUuid: Buffer;
  clientRequestHash: string;
  createdAt: Date;
}

type MovementRaw = { account_id: Buffer; component: string; amount: string };

/** The read that asks which deactivated, unanchored accounts ever recorded money. */
const isEverMoved = (sql: Prisma.Sql) => sql.sql.includes('UNION SELECT receiving_account_id FROM supplier_payments');
/** The read of what moved through the accounts on one business day (keyed by the day, never windowed by an instant). */
const isDayMovement = (sql: Prisma.Sql) => sql.sql.includes('p.business_date = ?');

const stored = (over: Partial<StoredAnchor> = {}): StoredAnchor => ({
  id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f1'),
  receivingAccountId: uuidToBin(BANKILY),
  labelSnapshot: 'Bankily',
  amount: 1000,
  at: new Date('2026-09-26T06:30:00Z'),
  businessDate: dateValue('2026-09-26'),
  trackedBefore: null,
  difference: null,
  note: null,
  clientUuid: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f2'),
  clientRequestHash: 'x'.repeat(64),
  createdAt: new Date('2026-09-26T06:30:00Z'),
  ...over,
});

const decimal = (n: number | null) => (n == null ? null : new Prisma.Decimal(n));

function harness(
  opts: {
    account?: { label: string; isActive: boolean } | null;
    anchors?: StoredAnchor[];
    movementsAfter?: (after: Date) => MovementRaw[];
    /** What the day-movement read answers for a business day. */
    dayMovements?: (day: string) => MovementRaw[];
    /** Accounts that recorded money at some point, as the "ever moved" read finds them. */
    moved?: string[];
    beforeCreate?: (anchors: StoredAnchor[]) => void;
  } = {},
) {
  const anchors = [...(opts.anchors ?? [])];
  const account = opts.account === undefined ? { label: 'Bankily', isActive: true } : opts.account;
  const queries: Prisma.Sql[] = [];
  const $queryRaw = jest.fn(async (sql: Prisma.Sql) => {
    queries.push(sql);
    if (sql.sql.includes('FOR UPDATE')) {
      return account ? [{ id: uuidToBin(BANKILY), label: account.label, is_active: account.isActive ? 1 : 0, sort_order: 1 }] : [];
    }
    if (isEverMoved(sql)) {
      const asked = sql.values.filter((v): v is Buffer => Buffer.isBuffer(v));
      return (opts.moved ?? []).filter((id) => asked.some((b) => b.equals(uuidToBin(id)))).map((id) => ({ account_id: uuidToBin(id) }));
    }
    if (isDayMovement(sql)) {
      const day = sql.values.find((v): v is string => typeof v === 'string');
      return day && opts.dayMovements ? opts.dayMovements(day) : [];
    }
    const after = sql.values.find((v): v is Date => v instanceof Date);
    return after && opts.movementsAfter ? opts.movementsAfter(after) : [];
  });
  const moneyAnchor = {
    findFirst: jest.fn(async (args: { where: { clientUuid?: Buffer; receivingAccountId?: Buffer } }) => {
      if (args.where.clientUuid) {
        const hit = anchors.find((a) => a.clientUuid.equals(args.where.clientUuid!));
        return hit ? { id: hit.id, clientRequestHash: hit.clientRequestHash } : null;
      }
      const [latest] = anchors
        .filter((a) => a.receivingAccountId.equals(args.where.receivingAccountId!))
        .sort((a, b) => b.at.getTime() - a.at.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
      return latest ? { amount: decimal(latest.amount), at: latest.at, businessDate: latest.businessDate, recordedBy: { name: 'Owner' } } : null;
    }),
    findFirstOrThrow: jest.fn(async (args: { where: { id: Buffer } }) => {
      const a = anchors.find((x) => x.id.equals(args.where.id))!;
      return {
        ...a,
        amount: decimal(a.amount),
        trackedBefore: decimal(a.trackedBefore),
        difference: decimal(a.difference),
        recordedBy: { name: 'Owner' },
        receivingAccount: { id: uuidToBin(BANKILY), label: account?.label ?? 'Bankily', isActive: account?.isActive ?? true, sortOrder: 1 },
      };
    }),
    create: jest.fn(async ({ data }: { data: Omit<StoredAnchor, 'createdAt'> }) => {
      opts.beforeCreate?.(anchors);
      anchors.push({ ...data, createdAt: new Date() });
      return data;
    }),
  };
  const tx = { $queryRaw, moneyAnchor };
  const db = { $queryRaw, moneyAnchor, $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { recordTx: jest.fn(async () => undefined) };
  const businessDay = { assign: jest.fn(async () => '2026-09-26'), today: jest.fn(async () => '2026-09-26') };
  const tenant = { companyId: () => COMPANY, requireBranchId: () => BRANCH, requireUserId: () => USER };
  const svc = new MoneyAnchorsService(db as never, tenant as never, audit as never, businessDay as never);
  return { svc, db, tx, audit, businessDay, anchors, queries, moneyAnchor };
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  return { error: e, code: ((e as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined)?.code };
};

describe('POST /money/anchors — the route and who may use it', () => {
  it('is the Owner’s own key, on its own path', () => {
    const handler = MoneyAnchorsController.prototype.record;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('money/anchors');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, handler)).toEqual(['money.anchor.record']);
  });

  it('held by the Owner role only, never delegated, and resolved in a branch like every money record', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('money.anchor.record');
    for (const role of ['administrator', 'store_manager', 'store_employee', 'branch_manager'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('money.anchor.record');
    }
    expect(DELEGATABLE_PERMISSIONS.has('money.anchor.record')).toBe(false);
    expect(isCompanyPermission('money.anchor.record')).toBe(false);
  });

  it('is registered in the closing module beside the closing', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ClosingModule)).toContain(MoneyAnchorsController);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ClosingModule)).toContain(MoneyAnchorsService);
  });
});

describe('recording what an account holds', () => {
  it('locks the account, records the amount on the server’s clock and answers 201 with the anchor and its method', async () => {
    const h = harness();
    const before = Date.now();
    const result = await h.svc.record({ clientUuid: KEY, accountId: BANKILY, amount: 2000, note: '  Bankily app  ' });

    // The account row is the first thing the transaction touches, tenant-checked and locked.
    const lock = h.queries[0];
    expect(lock.sql).toMatch(/FROM receiving_accounts\s+WHERE id = \? AND company_id = \?\s+FOR UPDATE/);
    expect(lock.values).toEqual([uuidToBin(BANKILY), COMPANY]);

    const data = h.moneyAnchor.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      companyId: COMPANY,
      receivingAccountId: uuidToBin(BANKILY),
      labelSnapshot: 'Bankily',
      amount: 2000,
      businessDate: dateValue('2026-09-26'),
      trackedBefore: null,
      difference: null,
      note: 'Bankily app',
      recordedById: USER,
      recordedAtBranchId: BRANCH,
      clientUuid: uuidToBin(KEY),
      clientRequestHash: anchorFingerprint({ accountId: BANKILY, amount: 2000, note: 'Bankily app' }),
    });
    expect(data.at.getTime()).toBeGreaterThanOrEqual(before);
    // The business date is the recording branch's, at that same instant.
    expect(h.businessDay.assign).toHaveBeenCalledWith(BRANCH, data.at, h.tx);

    expect(h.audit.recordTx).toHaveBeenCalledWith(h.tx, {
      entityType: 'MoneyAnchor',
      entityId: data.id,
      action: 'create',
      after: { accountId: BANKILY, label: 'Bankily', amount: 2000, trackedBefore: null, difference: null, businessDate: '2026-09-26' },
      branchId: BRANCH,
    });

    expect(result).toEqual({
      anchor: {
        id: binToUuid(data.id),
        accountId: BANKILY,
        label: 'Bankily',
        amount: 2000,
        at: data.at.toISOString(),
        businessDate: '2026-09-26',
        trackedBefore: null,
        difference: null,
        note: 'Bankily app',
        byName: 'Owner',
      },
      method: {
        key: `account:${BANKILY}`,
        channel: 'account',
        accountId: BANKILY,
        label: 'Bankily',
        scope: 'company',
        isActive: true,
        known: true,
        position: 2000,
        unknownReason: null,
        anchor: { source: 'declared', amount: 2000, at: data.at.toISOString(), businessDate: '2026-09-26', byName: 'Owner' },
        sinceAnchorNet: 0,
        movement: { businessDate: '2026-09-26', inflows: 0, outflows: 0, net: 0 },
      },
    });
  });

  it('keeps what the app tracked just before, and the difference', async () => {
    // Anchored at 1 000 this morning; 500 arrived after; the Owner now reads 1 450.
    const morning = stored();
    const h = harness({
      anchors: [morning],
      movementsAfter: (after) => (after.getTime() === morning.at.getTime() ? [{ account_id: uuidToBin(BANKILY), component: 'salesIn', amount: '500.00' }] : []),
    });
    const result = await h.svc.record({ clientUuid: KEY, accountId: BANKILY, amount: 1450 });
    expect(h.moneyAnchor.create.mock.calls[0][0].data).toMatchObject({ trackedBefore: 1500, difference: -50 });
    expect(result.anchor).toMatchObject({ amount: 1450, trackedBefore: 1500, difference: -50 });
    // From now on the account holds what was recorded, plus what moves after it.
    expect(result.method).toMatchObject({ known: true, position: 1450, sinceAnchorNet: 0, anchor: { amount: 1450 } });
  });

  it('the latest record is the one a position is built on', async () => {
    const first = stored({ amount: 1000, at: new Date('2026-09-26T06:30:00Z') });
    const second = stored({ id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f3'), clientUuid: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f4'), amount: 700, at: new Date('2026-09-26T12:00:00Z') });
    const h = harness({
      anchors: [second, first],
      movementsAfter: (after) => (after.getTime() === second.at.getTime() ? [{ account_id: uuidToBin(BANKILY), component: 'salesIn', amount: '100.00' }] : []),
    });
    await h.svc.record({ clientUuid: KEY, accountId: BANKILY, amount: 800 });
    const latest = h.moneyAnchor.findFirst.mock.calls.find(([args]) => 'receivingAccountId' in args.where)![0];
    expect(latest).toMatchObject({ where: { receivingAccountId: uuidToBin(BANKILY) }, orderBy: [{ at: 'desc' }, { createdAt: 'desc' }] });
    expect(h.moneyAnchor.create.mock.calls[0][0].data).toMatchObject({ trackedBefore: 800, difference: 0 });
  });

  it('a deactivated account can still be recorded: its money did not vanish', async () => {
    const h = harness({ account: { label: 'Old Sedad', isActive: false } });
    const result = await h.svc.record({ clientUuid: KEY, accountId: BANKILY, amount: 250 });
    expect(result.method).toMatchObject({ isActive: false, known: true, position: 250 });
  });

  it('a retry with the same key and payload returns the same anchor and writes nothing', async () => {
    const first = stored({ clientUuid: uuidToBin(KEY), clientRequestHash: anchorFingerprint({ accountId: BANKILY, amount: 1000 }) });
    const h = harness({ anchors: [first] });
    const result = await h.svc.record({ clientUuid: KEY, accountId: BANKILY.toUpperCase(), amount: 1000 });
    expect(result.anchor.id).toBe(binToUuid(first.id));
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.moneyAnchor.create).not.toHaveBeenCalled();
  });

  it('the same key with a different payload is refused: idempotency_conflict', async () => {
    const first = stored({ clientUuid: uuidToBin(KEY), clientRequestHash: anchorFingerprint({ accountId: BANKILY, amount: 1000 }) });
    const h = harness({ anchors: [first] });
    const { error, code } = await refusal(h.svc.record({ clientUuid: KEY, accountId: BANKILY, amount: 1200 }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(code).toBe('idempotency_conflict');
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('two identical retries racing: the loser answers with the winner’s anchor', async () => {
    const hash = anchorFingerprint({ accountId: BANKILY, amount: 900 });
    const winner = stored({ clientUuid: uuidToBin(KEY), clientRequestHash: hash, amount: 900 });
    const h = harness({
      beforeCreate: (anchors) => {
        anchors.push(winner);
        throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
      },
    });
    const result = await h.svc.record({ clientUuid: KEY, accountId: BANKILY, amount: 900 });
    expect(result.anchor.id).toBe(binToUuid(winner.id));
  });

  it('a negative amount or a third decimal is refused by name, before anything is read', async () => {
    for (const amount of [-5, 10.005]) {
      const h = harness();
      const { error, code } = await refusal(h.svc.record({ clientUuid: KEY, accountId: BANKILY, amount }));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(code).toBe('amount_invalid');
      expect(h.moneyAnchor.findFirst).not.toHaveBeenCalled();
      expect(h.db.$transaction).not.toHaveBeenCalled();
    }
  });

  it('an account outside the company is not found, and nothing is written', async () => {
    const h = harness({ account: null });
    const { error, code } = await refusal(h.svc.record({ clientUuid: KEY, accountId: BANKILY, amount: 100 }));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(code).toBe('account_not_found');
    expect(h.moneyAnchor.create).not.toHaveBeenCalled();
    expect(h.audit.recordTx).not.toHaveBeenCalled();
  });
});

describe('the movement window: the closing’s components, from each anchor’s instant', () => {
  const source = readFileSync(join(__dirname, 'money-anchors.service.ts'), 'utf8');
  const movements = source.slice(source.indexOf('private async movementsSince('));
  // The query's sources, one per UNION ALL branch, so a pin cannot pass on a neighbour's window.
  const query = movements.slice(movements.indexOf('client.$queryRaw'), movements.indexOf('`);'));
  const branches = query.split('UNION ALL');
  const branch = (marker: string) => {
    const hits = branches.filter((b) => b.includes(marker));
    expect(hits).toHaveLength(1);
    return hits[0];
  };
  const movementsSince = (h: ReturnType<typeof harness>, anchors: DeclaredAnchor[], today = '2026-09-27') =>
    (h.svc as unknown as { movementsSince: (db: unknown, companyId: Buffer, a: DeclaredAnchor[], today: string) => Promise<unknown> }).movementsSince(
      h.db,
      COMPANY,
      anchors,
      today,
    );

  it('each account is windowed by its own anchor: its date bound for the index, strictly after its instant', async () => {
    const h = harness();
    await movementsSince(h, [
      { accountId: BANKILY, amount: 1000, at: new Date('2026-09-26T06:30:00Z'), businessDate: '2026-09-26', byName: null },
      { accountId: MASRVI, amount: 0, at: new Date('2026-09-26T09:15:00Z'), businessDate: '2026-09-26', byName: null },
    ]);
    const sql = h.queries[0];
    // Ten sources windowed by an instant, each with one window per anchored account.
    expect((sql.sql.match(/ = \? AND [^?]+ >= \? AND [^?]+ > \?\)/g) ?? []).length).toBe(20);
    expect(sql.sql).not.toMatch(/_at >= \?/);
    // Two windowed by day (a fixed expense, and a fix of one): after the anchor's own day, and never ahead of today.
    expect((sql.sql.match(/ = \? AND [\w.]+ > \? AND [\w.]+ <= \?\)/g) ?? []).length).toBe(4);
    expect(sql.values.filter((v) => v === '2026-09-27')).toHaveLength(4);
    // The instants, the day-before bounds and the days are the anchors' own.
    expect(sql.values.filter((v) => v instanceof Date).map((v) => (v as Date).toISOString())).toEqual(
      Array.from({ length: 10 }, () => ['2026-09-26T06:30:00.000Z', '2026-09-26T09:15:00.000Z']).flat(),
    );
    expect(sql.values.filter((v) => v === '2026-09-25')).toHaveLength(20);
    expect(sql.values.filter((v) => v === '2026-09-26')).toHaveLength(4);
  });

  it('nothing anchored, nothing read', async () => {
    const h = harness();
    await expect(movementsSince(h, [])).resolves.toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('eleven sources: the closing’s seven, with fixed expenses and each kind of record fix on their own window', () => {
    expect(branches).toHaveLength(11);
  });

  it('money received, and purchases paid at receipt: when they were paid', () => {
    expect(branch('FROM payments p')).toContain("${after('p.receiving_account_id', 'p.business_date', 'p.paid_at')}");
    const atReceipt = branch('FROM supplier_payments sp');
    expect(atReceipt).toContain('JOIN purchases pu ON pu.id = sp.purchase_id');
    expect(atReceipt).toContain("${after('sp.receiving_account_id', 'sp.business_date', 'sp.paid_at')}");
  });

  it('report → anchor → confirm: a refund, a supplier payment and a variable expense count from when they were reported', () => {
    // The money left at the report, so an anchor taken before the Owner confirms already shows it.
    expect(branch('FROM refund_payouts')).toContain("${after('receiving_account_id', 'confirmation_date', 'reported_at')}");
    expect(branch('FROM supplier_settlements')).toContain("${after('receiving_account_id', 'confirmation_date', 'reported_at')}");
    // A legacy expense confirmed without a report counts from its confirmation.
    expect(branch("AND expense_class <> 'fixed'")).toContain(
      "${after('receiving_account_id', 'confirmation_date', 'COALESCE(reported_at, confirmed_at)')}",
    );
    // Nothing is windowed on the confirmation alone any more.
    expect(query).not.toMatch(/'(?:\w+\.)?confirmed_at'\)/);
  });

  it('a fixed expense counts on its due day, when that day is after the anchor’s', () => {
    expect(branch("AND expense_class = 'fixed'")).toContain("${afterDay('receiving_account_id', 'due_date')}");
    expect(movements).toMatch(/\$\{Prisma\.raw\(date\)\} > \$\{w\.day\}/);
  });

  it('a correction that fixes a record counts at that record’s own moment; a cancellation when it was approved', () => {
    const fixes = "fc.action IN ('reverse', 'reclassify')";
    // A payment moved or never received: at the payment's moment.
    const payment = branch('JOIN payments p ON p.id = l.source_payment_id');
    expect(payment).toContain(`fc.target_kind = 'sale_payment' AND ${fixes}`);
    expect(payment).toContain("${after('l.receiving_account_id', 'p.business_date', 'p.paid_at')}");
    // A purchase payment moved: at its own moment.
    const purchase = branch('JOIN supplier_payments sp ON sp.id = l.source_supplier_payment_id');
    expect(purchase).toContain(`fc.target_kind = 'supplier_payment' AND ${fixes}`);
    expect(purchase).toContain("${after('l.receiving_account_id', 'sp.business_date', 'sp.paid_at')}");
    // An expense reversed: at the expense's report (or confirmation), a fixed one on its due day.
    const expense = branch('JOIN expenses e ON e.id = l.source_expense_id');
    expect(expense).toContain(`fc.target_kind = 'expense' AND ${fixes}`);
    expect(expense).toMatch(
      /\(e\.expense_class <> 'fixed' AND \(\$\{after\('l\.receiving_account_id', 'e\.confirmation_date', 'COALESCE\(e\.reported_at, e\.confirmed_at\)'\)\}\)\)\s+OR \(e\.expense_class = 'fixed' AND \(\$\{afterDay\('l\.receiving_account_id', 'e\.due_date'\)\}\)\)/,
    );
    // Every other correction's legs — a sale or a purchase cancelled — at the approval, and only those:
    // the record fixes above are left out here, so no leg is counted twice.
    const others = branch('AND NOT (');
    expect(others).toContain(`AND NOT (fc.target_kind IN ('sale_payment', 'supplier_payment', 'expense') AND ${fixes})`);
    expect(others).toContain("${after('l.receiving_account_id', 'fc.correction_date', 'fc.decided_at')}");
    expect(others).not.toMatch(/JOIN (payments|supplier_payments|expenses) /);
    expect((query.match(/fc\.decided_at/g) ?? []).length).toBe(1);
    // A refund or supplier payment that never happened: at the payout's own report.
    expect(branch('FROM financial_corrections fc')).toContain(
      "${after('COALESCE(rp.receiving_account_id, ss.receiving_account_id)', 'COALESCE(rp.confirmation_date, ss.confirmation_date)', 'COALESCE(rp.reported_at, ss.reported_at)')}",
    );
  });

  it('with the closing’s own status filters and components, company-wide, accounts only', () => {
    expect((movements.match(/status = 'confirmed'/g) ?? []).length).toBe(4);
    expect((movements.match(/fc\.status = 'approved'/g) ?? []).length).toBe(5);
    expect(movements).toMatch(/fc\.target_kind IN \('refund_payout', 'supplier_settlement'\)/);
    expect((movements.match(/IF\(l\.direction = 'in', 'correctionsIn', 'correctionsOut'\)/g) ?? []).length).toBe(4);
    expect(movements).toMatch(/SUM\(reported_amount\)/);
    for (const component of ["'salesIn'", "'refundsOut'", "'supplierOut'", "'expensesOut'", "'correctionsIn'", "'correctionsOut'"]) {
      expect(movements).toContain(component);
    }
    // Every branch of the company: no source narrows to one.
    expect(movements).not.toMatch(/branch_id/);
    // Cash is the drawer's, never an account's.
    expect((movements.match(/method <> 'cash'/g) ?? []).length).toBe(11);
  });
});

describe('tracked money through the service', () => {
  const DAY = '2026-09-27';
  const closeRow = (status: string, countedCash: number | null) => ({
    status,
    countedCash: countedCash == null ? null : new Prisma.Decimal(countedCash),
    closedAt: new Date('2026-09-25T22:30:00Z'),
    closedBy: { name: 'Owner' },
    channelCounts: [{ countedAt: new Date('2026-09-25T22:10:00Z'), countedBy: { name: 'Aicha' } }],
  });

  type AccountStub = { id: Buffer; label: string; isActive: boolean; sortOrder: number };
  const shop: AccountStub[] = [
    { id: uuidToBin(BANKILY), label: 'Bankily', isActive: true, sortOrder: 1 },
    { id: uuidToBin(MASRVI), label: 'Masrvi', isActive: true, sortOrder: 2 },
  ];
  const retired: AccountStub = { id: uuidToBin(RETIRED), label: 'Old Sedad', isActive: false, sortOrder: 0 };

  function build(
    closes: Record<string, ReturnType<typeof closeRow> | null>,
    anchors: StoredAnchor[],
    movements: MovementRaw[],
    more: { accounts?: AccountStub[]; moved?: string[]; dayMovements?: MovementRaw[] } = {},
  ) {
    const h = harness({ anchors, movementsAfter: () => movements, moved: more.moved, dayMovements: () => more.dayMovements ?? [] });
    const db = Object.assign(h.db, {
      dailyClosing: {
        findUnique: jest.fn(async (args: { where: { branchId_closingDate: { closingDate: Date } } }) =>
          closes[args.where.branchId_closingDate.closingDate.toISOString().slice(0, 10)] ?? null,
        ),
      },
      receivingAccount: { findMany: jest.fn(async () => more.accounts ?? shop) },
      branch: { count: jest.fn(async () => 2) },
    });
    return { ...h, db };
  }

  const opening = { amount: 3400, anchorDate: '2026-09-25', anchorVerified: true, carriedDays: 1 };
  const anchors = [
    stored({ amount: 0, at: new Date('2026-09-26T06:30:00Z') }),
    stored({ id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f5'), receivingAccountId: uuidToBin(MASRVI), amount: 0, at: new Date('2026-09-26T06:30:00Z') }),
  ];
  const day2 = [
    { account_id: uuidToBin(BANKILY), component: 'salesIn', amount: '2000.00' },
    { account_id: uuidToBin(MASRVI), component: 'salesIn', amount: '1600.00' },
  ];

  it('the next morning: the drawer carried from day 1’s count, the accounts from their anchors — 7 000', async () => {
    const { svc, db } = build({ '2026-09-25': closeRow('locked', 0) }, anchors, day2);
    const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400 }, true);
    expect(card.methods.map((m) => [m.key, m.position])).toEqual([
      ['cash', 3400],
      [`account:${BANKILY}`, 2000],
      [`account:${MASRVI}`, 1600],
    ]);
    expect(card).toMatchObject({ businessDate: DAY, basis: 'anchor_plus_recorded_movement', branchCount: 2, total: 7000, unknownKeys: [] });
    expect(card.methods[0].anchor).toEqual({ source: 'counted_close', amount: 0, at: '2026-09-25T22:10:00.000Z', businessDate: '2026-09-25', byName: 'Aicha' });
    expect(db.branch.count).toHaveBeenCalledWith({ where: { type: 'store', isActive: true, deletedAt: null } });
  });

  it('a close whose drawer was not counted anchors nothing, so the drawer is unknown and there is no total', async () => {
    const { svc } = build({ '2026-09-25': closeRow('locked', null) }, anchors, day2);
    const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400 }, true);
    expect(card.methods[0]).toMatchObject({ known: false, position: null, unknownReason: 'no_counted_close' });
    expect(card.total).toBeNull();
    expect(card.unknownKeys).toEqual(['cash']);
  });

  it('today closed with a counted drawer: the drawer holds the count', async () => {
    const { svc } = build({ [DAY]: closeRow('locked', 3350), '2026-09-25': closeRow('locked', 0) }, anchors, day2);
    const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400 }, true);
    expect(card.methods[0]).toMatchObject({ position: 3350, anchor: { businessDate: DAY, amount: 3350 }, sinceAnchorNet: 0 });
  });

  it('a day counted but not locked, or reopened, is not an anchor', async () => {
    for (const status of ['counting', 'counted', 'reopened']) {
      const { svc } = build({ [DAY]: closeRow(status, 3350), '2026-09-25': closeRow('locked', 0) }, anchors, day2);
      const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400 }, true);
      expect(card.methods[0]).toMatchObject({ position: 3400, anchor: { businessDate: '2026-09-25' } });
    }
  });

  it('a shop that never counted a closed drawer does not know what it holds', async () => {
    const { svc, db } = build({}, anchors, day2);
    const card = await svc.trackedMoney(BRANCH, DAY, { opening: { amount: 3400, anchorDate: null, anchorVerified: false, carriedDays: 0 }, expected: 3400 }, true);
    expect(card.methods[0]).toMatchObject({ known: false, position: null, unknownReason: 'no_counted_close' });
    // Only today's row was looked for: there is no anchor date to read.
    expect(db.dailyClosing.findUnique).toHaveBeenCalledTimes(1);
  });

  it('someone who may not record the accounts reads none of them: this branch’s drawer only, and no total', async () => {
    const { svc, db, moneyAnchor, queries } = build({ '2026-09-25': closeRow('locked', 0) }, anchors, day2, { accounts: [...shop, retired], moved: [RETIRED] });
    const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400 }, false);
    expect(card).toMatchObject({ accountsVisible: false, total: null, unknownKeys: [] });
    expect(card.methods.map((m) => [m.key, m.position])).toEqual([['cash', 3400]]);
    // No account, anchor or movement is even read.
    expect(db.receivingAccount.findMany).not.toHaveBeenCalled();
    expect(moneyAnchor.findFirst).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
  });

  it('a deactivated account that recorded money and was never anchored is listed unknown, and there is no total', async () => {
    const { svc, queries } = build({ '2026-09-25': closeRow('locked', 0) }, anchors, day2, { accounts: [...shop, retired], moved: [RETIRED] });
    const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400 }, true);
    expect(card.methods.map((m) => m.label || m.key)).toEqual(['cash', 'Bankily', 'Masrvi', 'Old Sedad']);
    expect(card.methods[3]).toMatchObject({ isActive: false, known: false, position: null, unknownReason: 'no_anchor' });
    expect(card.total).toBeNull();
    expect(card.unknownKeys).toEqual([`account:${RETIRED}`]);
    // Only that account was asked about — in every source, at every branch of the company.
    const [ever] = queries.filter(isEverMoved);
    const asked = ever.values.filter((v): v is Buffer => Buffer.isBuffer(v) && !v.equals(COMPANY));
    expect(asked).toHaveLength(6);
    expect(asked.every((b) => b.equals(uuidToBin(RETIRED)))).toBe(true);
    expect(ever.sql).not.toMatch(/branch_id/);
  });

  it('a deactivated account that never recorded money and was never anchored is not listed', async () => {
    const { svc } = build({ '2026-09-25': closeRow('locked', 0) }, anchors, day2, { accounts: [...shop, retired], moved: [] });
    const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400 }, true);
    expect(card.methods.map((m) => m.key)).not.toContain(`account:${RETIRED}`);
    expect(card.total).toBe(7000);
  });

  it('with no deactivated, unanchored account there is nothing to ask about: the read is skipped', async () => {
    const anchoredRetired = stored({ id: uuidToBin('01a0b1c2-0000-7000-8000-0000000000f6'), receivingAccountId: uuidToBin(RETIRED), amount: 250 });
    const cases: [AccountStub[], StoredAnchor[]][] = [
      [shop, anchors],
      [[...shop, retired], [...anchors, anchoredRetired]],
    ];
    for (const [accounts, anchored] of cases) {
      const { svc, queries } = build({ '2026-09-25': closeRow('locked', 0) }, anchored, day2, { accounts, moved: [RETIRED] });
      await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400 }, true);
      expect(queries.filter(isEverMoved)).toHaveLength(0);
    }
  });
  describe('what moved on the day, beside each position (the brief of 2026-10-07)', () => {
    const SEDAD = MASRVI;
    const sedadSale = [{ account_id: uuidToBin(SEDAD), component: 'salesIn', amount: '20000.00' }];
    const drawerRows = [
      { channel: 'cash' as const, accountId: null, component: 'salesIn' as const, amount: 1500 },
      { channel: 'cash' as const, accountId: null, component: 'expensesOut' as const, amount: 200 },
    ];

    it('Sedad never recorded, 20 000 received through it today: still Unknown, no total, and the 20 000 said beside it', async () => {
      // Only Bankily is anchored; Sedad has no record of what it held.
      const { svc, queries } = build({ '2026-09-25': closeRow('locked', 0) }, [anchors[0]], [], { dayMovements: sedadSale });
      const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400, dayRows: drawerRows }, true);
      const sedad = card.methods.find((m) => m.key === `account:${SEDAD}`)!;
      expect(sedad).toMatchObject({ known: false, position: null, unknownReason: 'no_anchor', anchor: null, sinceAnchorNet: null });
      expect(sedad.movement).toEqual({ businessDate: DAY, inflows: 20000, outflows: 0, net: 20000 });
      expect(card.total).toBeNull();
      expect(card.unknownKeys).toEqual([`account:${SEDAD}`]);
      // The anchored account moved nothing today; the drawer's own day rows are this branch's.
      expect(card.methods.find((m) => m.key === `account:${BANKILY}`)!.movement).toEqual({ businessDate: DAY, inflows: 0, outflows: 0, net: 0 });
      expect(card.methods[0].movement).toEqual({ businessDate: DAY, inflows: 1500, outflows: 200, net: 1300 });
      // One day read, for the company and the requesting branch's business day — no branch narrows it.
      const [day] = queries.filter(isDayMovement);
      expect(queries.filter(isDayMovement)).toHaveLength(1);
      expect(day.values.filter((v) => v === DAY)).toHaveLength(7);
      expect(day.values.filter((v) => Buffer.isBuffer(v) && v.equals(COMPANY))).toHaveLength(7);
      expect(day.sql).not.toMatch(/branch_id/);
    });

    it('Bankily recorded at 5 000, the same 20 000 received: 25 000 — the movement is counted once, in the position and beside it', async () => {
      const bankilySale = [{ account_id: uuidToBin(BANKILY), component: 'salesIn', amount: '20000.00' }];
      const five = [stored({ amount: 5000, at: new Date('2026-09-27T06:30:00Z'), businessDate: dateValue(DAY) })];
      const { svc } = build({ '2026-09-25': closeRow('locked', 0) }, five, bankilySale, { accounts: [shop[0]], dayMovements: bankilySale });
      const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400, dayRows: [] }, true);
      expect(card.methods[1]).toMatchObject({ known: true, position: 25000, sinceAnchorNet: 20000, movement: { inflows: 20000, outflows: 0, net: 20000 } });
      expect(card.total).toBe(28400);
    });

    it('an account recorded at exactly 0 is known, and shows 0', async () => {
      const zero = [stored({ amount: 0, at: new Date('2026-09-27T06:30:00Z'), businessDate: dateValue(DAY) })];
      const { svc } = build({ '2026-09-25': closeRow('locked', 0) }, zero, [], { accounts: [shop[0]] });
      const card = await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400, dayRows: [] }, true);
      expect(card.methods[1]).toMatchObject({ known: true, position: 0, unknownReason: null, movement: { net: 0 } });
      expect(card.total).toBe(3400);
    });

    it('nobody who may not see the accounts triggers the day read', async () => {
      const { svc, queries } = build({ '2026-09-25': closeRow('locked', 0) }, anchors, day2, { dayMovements: sedadSale });
      await svc.trackedMoney(BRANCH, DAY, { opening, expected: 3400, dayRows: drawerRows }, false);
      expect(queries.filter(isDayMovement)).toHaveLength(0);
    });
  });
});

describe('the day read: the closing’s seven sources on one business day, company-wide, accounts only', () => {
  const source = readFileSync(join(__dirname, 'money-anchors.service.ts'), 'utf8');
  const start = source.indexOf('private async accountDayMovements(');
  const query = source.slice(source.indexOf('client.$queryRaw', start), source.indexOf('`);', start));
  const branches = query.split('UNION ALL');
  const branch = (marker: string) => {
    const hits = branches.filter((b) => b.includes(marker));
    expect(hits).toHaveLength(1);
    return hits[0];
  };

  it('seven sources, each keyed by the day the closing books it on', () => {
    expect(branches).toHaveLength(7);
    expect(branch('FROM payments p')).toContain("p.method <> 'cash' AND p.business_date = ${day}");
    expect(branch('FROM supplier_payments sp')).toContain('sp.business_date = ${day}');
    expect(branch('FROM refund_payouts')).toContain("status = 'confirmed' AND confirmation_date = ${day}");
    expect(branch('FROM supplier_settlements')).toContain("status = 'confirmed' AND confirmation_date = ${day}");
    expect(branch('FROM expenses')).toContain("IF(expense_class = 'fixed', due_date, confirmation_date) = ${day}");
    expect(branch("fc.target_kind IN ('refund_payout', 'supplier_settlement')")).toContain("fc.status = 'approved' AND fc.correction_date = ${day}");
    expect(branch('FROM financial_correction_legs l')).toContain("fc.status = 'approved' AND fc.correction_date = ${day}");
  });

  it('a day, never a window: nothing is bounded by an instant or an anchor', () => {
    expect(query).not.toMatch(/>=? \$\{/);
    expect(query).not.toMatch(/paid_at|reported_at|decided_at|confirmed_at/);
  });

  it('with the closing’s own status filters and components, every branch of the company, accounts only', () => {
    expect((query.match(/status = 'confirmed'/g) ?? []).length).toBe(3);
    expect((query.match(/fc\.status = 'approved'/g) ?? []).length).toBe(2);
    expect((query.match(/method <> 'cash'/g) ?? []).length).toBe(7);
    expect(query).toMatch(/IF\(l\.direction = 'in', 'correctionsIn', 'correctionsOut'\)/);
    expect(query).toMatch(/SUM\(reported_amount\)/);
    for (const component of ["'salesIn'", "'refundsOut'", "'supplierOut'", "'expensesOut'", "'correctionsIn'"]) expect(query).toContain(component);
    expect(query).not.toMatch(/branch_id/);
  });
});

describe('the overview carries trackedMoney beside its existing fields, unchanged', () => {
  const tracked = { asOf: 'now', businessDate: '2026-09-27', basis: 'anchor_plus_recorded_movement', branchCount: 1, accountsVisible: true, methods: [], total: 7000, unknownKeys: [] };
  const accounts = [{ id: BANKILY, label: 'Bankily', isActive: true, sortOrder: 1 }];

  function overviewOf(permissions?: string[]) {
    (periodFigures as jest.Mock).mockResolvedValue({
      invoices: { count: 0, value: 0, units: 0, phones: 0, cost: 0, margin: 0 },
      cancellations: { count: 0, value: 0, units: 0, phones: 0, cost: 0, margin: 0 },
      returns: { count: 0, value: 0, grossRefund: 0, adjustments: 0, costCredited: 0, profitEffect: 0, phones: 0 },
      expenses: { recorded: 0, recordedCount: 0, reversed: 0, reversedCount: 0, net: 0 },
      net: { salesValue: 0, salesCount: 0, units: 0, phones: 0 },
    });
    const opening = { amount: 3400, anchorDate: '2026-09-25', anchorVerified: true, carriedDays: 1 };
    const svc = Object.create(ClosingService.prototype) as ClosingService & Record<string, unknown>;
    const moneyAnchors = { trackedMoney: jest.fn(async () => tracked) };
    const expectedChannels = jest.fn(async (_c: Buffer, _b: Buffer, _from: string, _to: string, cashOpening = 0) => buildChannels([], accounts, cashOpening));
    // The day as the closing reads it (docs/63): its opening, no amount set today.
    const dayChannels = jest.fn(async () => ({ opening, carriedFrom: null, declaredToday: null, adjustment: 0, channels: buildChannels([], accounts, opening.amount) }));
    Object.assign(svc, {
      db: {
        sale: { aggregate: jest.fn(async () => ({ _sum: { balanceDue: new Prisma.Decimal(0) }, _count: 0 })) },
        expense: { findMany: jest.fn(async () => []) },
        financialCorrection: { findMany: jest.fn(async () => []) },
      },
      tenant: { companyId: () => COMPANY, requireBranchId: () => BRANCH },
      businessDay: { today: jest.fn(async () => '2026-09-27') },
      dayChannels,
      expectedChannels,
      moneyAnchors,
      cls: { get: (key: string) => (key === 'permissions' && permissions ? new Set(permissions) : undefined) },
    });
    return { svc, moneyAnchors, expectedChannels, dayChannels, opening };
  }

  it('adds trackedMoney and leaves every other field as it was', async () => {
    const { svc, moneyAnchors, dayChannels, opening } = overviewOf(['report.view', 'money.anchor.record']);
    const view = await svc.overview('2026-09-27', '2026-09-27');
    expect(Object.keys(view)).toEqual([
      'from', 'to', 'today', 'cashNow', 'cashOpening', 'moneyToday', 'accountsToday', 'period', 'outstandingAll', 'expensesToday', 'trackedMoney',
    ]);
    expect(view.trackedMoney).toBe(tracked);
    // The drawer's figures stay the day's expected cash with its opening; the day's movement stays movement.
    expect(view.cashNow).toBe(3400);
    expect(view.cashOpening).toBe(3400);
    expect(view.moneyToday.total).toEqual({ moneyIn: 0, moneyOut: 0, net: 0 });
    expect(view.accountsToday).toEqual([{ accountId: BANKILY, label: 'Bankily', isUnattributed: false, moneyIn: 0, moneyOut: 0, net: 0 }]);
    expect(dayChannels).toHaveBeenCalledWith(COMPANY, BRANCH, '2026-09-27');
    // The drawer's position is built on the same opening, the same expected figure and the decision anchoring it.
    expect(moneyAnchors.trackedMoney).toHaveBeenCalledWith(BRANCH, '2026-09-27', { opening, expected: 3400, opened: null, dayRows: [] }, true);
  });

  it('the accounts are read only for a caller who may record them', async () => {
    const cases: [string[] | undefined, boolean][] = [
      [['report.view', 'money.anchor.record'], true],
      [['report.view'], false],
      [undefined, false],
    ];
    for (const [permissions, visible] of cases) {
      const { svc, moneyAnchors, opening } = overviewOf(permissions);
      await svc.overview('2026-09-27', '2026-09-27');
      expect(moneyAnchors.trackedMoney).toHaveBeenCalledWith(BRANCH, '2026-09-27', { opening, expected: 3400, opened: null, dayRows: [] }, visible);
    }
  });

  it('the existing fields are still computed exactly as before (source pin)', () => {
    const service = readFileSync(join(__dirname, 'closing.service.ts'), 'utf8');
    const block = service.slice(service.indexOf('async overview('), service.indexOf('async openView('));
    expect(block).toMatch(/cashNow: round2\(cash\?\.expected \?\? 0\),/);
    expect(block).toMatch(/cashOpening: round2\(cash\?\.openingBalance \?\? 0\),/);
    expect(block).toMatch(/moneyToday: moneyByMethod\(todayChannels\),/);
    expect(block).toMatch(/moneyIn: round2\(c\.salesIn \+ c\.correctionsIn\),/);
    expect(block).toMatch(/moneyOut: round2\(c\.refundsOut \+ c\.supplierOut \+ c\.expensesOut \+ c\.correctionsOut\),/);
    // Today through the one place a day is read (docs/63): its opening, and an amount set when the shop opened.
    expect(block).toMatch(/const drawer = await this\.dayChannels\(companyId, branchId, today\);/);
    expect(block).toMatch(/Promise\.resolve\(drawer\.channels\),/);
    // Whether the accounts are listed is the caller's own permission, read from the request.
    expect(block).toMatch(/const accountsVisible = this\.cls\.get\('permissions'\)\?\.has\('money\.anchor\.record'\) \?\? false;/);
    expect(block).toMatch(
      /\{ opening, expected: cash\?\.expected \?\? 0, opened: openedAnchorOf\(drawer\.declaredToday \?\? drawer\.carriedFrom\), dayRows: cashDayRows\(cash\) \},\s*accountsVisible,/,
    );
  });
});
