import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { BusinessDayService, dateKey, dateValue } from '../common/business-day/business-day.service';
import type { AccountRow, Component, MovementRow } from './channels';
import type { OpeningCash } from './closing-report';
import { RecordMoneyAnchorDto } from './dto/record-money-anchor.dto';
import {
  accountMethod,
  anchorFingerprint,
  assertAnchorAmount,
  movementWindow,
  trackedMoney,
  type CountedClose,
  type DeclaredAnchor,
  type TrackedMethod,
  type TrackedMoney,
} from './money-positions';

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The request's client or a transaction's: positions read the same through either. */
type PositionReader = Pick<TenantPrisma, '$queryRaw' | 'moneyAnchor'>;

const toAccountRow = (a: { id: Buffer; label: string; isActive: boolean; sortOrder: number }): AccountRow => ({
  id: binToUuid(a.id),
  label: a.label,
  isActive: a.isActive,
  sortOrder: a.sortOrder,
});

/** An anchor as the phone reads it back, with the account its method is built from. */
const anchorSelect = {
  id: true,
  labelSnapshot: true,
  amount: true,
  at: true,
  businessDate: true,
  trackedBefore: true,
  difference: true,
  note: true,
  recordedBy: { select: { name: true } },
  receivingAccount: { select: { id: true, label: true, isActive: true, sortOrder: true } },
} satisfies Prisma.MoneyAnchorSelect;

/**
 * Tracked money held per method (docs/60): Money's top card, and the Owner
 * recording what an account holds.
 *
 * The rules live in `money-positions.ts`; this reads what they need. The drawer
 * is anchored by the Daily closing's counted close and carried by the closing's
 * own expected figure, handed in by `ClosingService.overview`. An account is
 * anchored by its latest `money_anchors` row and carried by its movements at
 * every branch after that instant — the closing's components and signs, windowed
 * by when each movement happened instead of by business date.
 */
@Injectable()
export class MoneyAnchorsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly businessDay: BusinessDayService,
  ) {}

  /** Every method's position at this branch now, and their total when all are known. */
  async trackedMoney(
    branchId: Buffer,
    businessDate: string,
    drawer: { opening: OpeningCash; expected: number },
    accountsVisible: boolean,
  ): Promise<TrackedMoney> {
    const companyId = this.tenant.companyId();
    const asOf = new Date();
    const [countedToday, openingAnchor, accounts, branchCount] = await Promise.all([
      this.countedClose(branchId, businessDate),
      drawer.opening.anchorDate ? this.countedClose(branchId, drawer.opening.anchorDate) : null,
      accountsVisible ? this.db.receivingAccount.findMany({ select: { id: true, label: true, isActive: true, sortOrder: true } }) : [],
      // Accounts are the company's; the phone says so when there is more than one shop.
      this.db.branch.count({ where: { type: 'store', isActive: true, deletedAt: null } }),
    ]);
    const rows = accounts.map(toAccountRow);
    const anchors = (await Promise.all(rows.map((a) => this.latestAnchor(this.db, a.id)))).filter(
      (a): a is DeclaredAnchor => a !== null,
    );
    const [movements, withMovement] = await Promise.all([
      this.movementsSince(this.db, companyId, anchors, businessDate),
      this.everMoved(companyId, rows.filter((a) => !a.isActive && !anchors.some((x) => x.accountId === a.id)).map((a) => a.id)),
    ]);
    return trackedMoney({
      asOf,
      businessDate,
      branchCount,
      drawer: { countedToday, openingAnchor, expected: drawer.expected },
      accounts: rows,
      anchors,
      movements,
      withMovement,
      accountsVisible,
    });
  }

  /** Which of these accounts ever recorded money, in any direction — they may still hold some. */
  private async everMoved(companyId: Buffer, accountIds: string[]): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    const ids = Prisma.join(accountIds.map(uuidToBin));
    const rows = await this.db.$queryRaw<{ account_id: Buffer }[]>(Prisma.sql`
      SELECT receiving_account_id AS account_id FROM payments WHERE company_id = ${companyId} AND receiving_account_id IN (${ids})
      UNION SELECT receiving_account_id FROM supplier_payments WHERE company_id = ${companyId} AND receiving_account_id IN (${ids})
      UNION SELECT receiving_account_id FROM refund_payouts WHERE company_id = ${companyId} AND status = 'confirmed' AND receiving_account_id IN (${ids})
      UNION SELECT receiving_account_id FROM supplier_settlements WHERE company_id = ${companyId} AND status = 'confirmed' AND receiving_account_id IN (${ids})
      UNION SELECT receiving_account_id FROM expenses WHERE company_id = ${companyId} AND status = 'confirmed' AND receiving_account_id IN (${ids})
      UNION SELECT receiving_account_id FROM financial_correction_legs WHERE company_id = ${companyId} AND receiving_account_id IN (${ids})
    `);
    return new Set(rows.filter((r) => r.account_id != null).map((r) => binToUuid(r.account_id)));
  }

  /**
   * Record what an account holds now. The Owner's alone (`money.anchor.record`).
   *
   * Append-only: a later anchor supersedes this one and this one stays. What the
   * app tracked just before is kept beside it, with the difference, so a gap
   * between the records and the provider is written down rather than absorbed.
   */
  async record(dto: RecordMoneyAnchorDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.requireUserId();
    assertAnchorAmount(dto.amount);
    const clientUuid = uuidToBin(dto.clientUuid);
    const hash = anchorFingerprint(dto);

    // A retry of an anchor already recorded answers with it.
    const replay = await this.replay(clientUuid, hash);
    if (replay) return replay;

    const accountBin = uuidToBin(dto.accountId);
    const id = newUuidV7Bin();
    try {
      await this.db.$transaction(async (tx) => {
        /**
         * The account row first, locked. A movement being written against the
         * account checks this row, so one in flight commits before the position is
         * read and one starting now waits for the anchor.
         */
        const [account] = await tx.$queryRaw<{ id: Buffer; label: string; is_active: unknown; sort_order: number }[]>(Prisma.sql`
          SELECT id, label, is_active, sort_order FROM receiving_accounts
           WHERE id = ${accountBin} AND company_id = ${companyId}
           FOR UPDATE`);
        if (!account) {
          throw new NotFoundException({ code: 'account_not_found', message: 'That receiving account does not exist' });
        }
        const at = new Date();
        const businessDate = await this.businessDay.assign(branchId, at, tx as unknown as Prisma.TransactionClient);
        const before = await this.methodOf(tx, companyId, businessDate, {
          id: binToUuid(account.id),
          label: account.label,
          isActive: Number(account.is_active) === 1,
          sortOrder: Number(account.sort_order),
        });
        const trackedBefore = before.position;
        const difference = trackedBefore === null ? null : round2(dto.amount - trackedBefore);
        await tx.moneyAnchor.create({
          data: {
            id,
            companyId,
            receivingAccountId: accountBin,
            labelSnapshot: account.label,
            amount: dto.amount,
            at,
            businessDate: dateValue(businessDate),
            trackedBefore,
            difference,
            note: dto.note?.trim() || null,
            recordedById: userId,
            recordedAtBranchId: branchId,
            clientUuid,
            clientRequestHash: hash,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'MoneyAnchor',
          entityId: id,
          action: 'create',
          after: { accountId: binToUuid(account.id), label: account.label, amount: dto.amount, trackedBefore, difference, businessDate },
          branchId,
        });
      });
    } catch (e) {
      // Two identical retries raced and the other committed first: answer with it, or refuse a different payload.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.replay(clientUuid, hash);
        if (winner) return winner;
      }
      throw e;
    }
    return this.view(id);
  }

  /** The anchor an earlier request with this key recorded, or null if there was none. */
  private async replay(clientUuid: Buffer, hash: string) {
    const prior = await this.db.moneyAnchor.findFirst({
      where: { clientUuid },
      select: { id: true, clientRequestHash: true },
    });
    if (!prior) return null;
    if (prior.clientRequestHash !== hash) {
      throw new ConflictException({
        code: 'idempotency_conflict',
        message: 'That request id was already used for a different amount.',
      });
    }
    return this.view(prior.id);
  }

  /** The anchor as recorded, and its account's position as it stands now. */
  private async view(id: Buffer) {
    const row = await this.db.moneyAnchor.findFirstOrThrow({ where: { id }, select: anchorSelect });
    const account = toAccountRow(row.receivingAccount);
    return {
      anchor: {
        id: binToUuid(row.id),
        accountId: account.id,
        label: row.labelSnapshot,
        amount: num(row.amount),
        at: row.at.toISOString(),
        businessDate: dateKey(row.businessDate),
        trackedBefore: row.trackedBefore == null ? null : num(row.trackedBefore),
        difference: row.difference == null ? null : num(row.difference),
        note: row.note,
        byName: row.recordedBy.name,
      },
      method: await this.methodOf(this.db, this.tenant.companyId(), await this.businessDay.today(this.tenant.requireBranchId()), account),
    };
  }

  /** One account's method: its latest anchor and the movements after it. */
  private async methodOf(client: PositionReader, companyId: Buffer, today: string, account: AccountRow): Promise<TrackedMethod> {
    const anchor = await this.latestAnchor(client, account.id);
    const movements = anchor ? await this.movementsSince(client, companyId, [anchor], today) : [];
    return accountMethod(account, anchor, movements);
  }

  /** The latest amount recorded for an account: the latest instant, then the latest written. */
  private async latestAnchor(client: PositionReader, accountId: string): Promise<DeclaredAnchor | null> {
    const row = await client.moneyAnchor.findFirst({
      where: { receivingAccountId: uuidToBin(accountId) },
      orderBy: [{ at: 'desc' }, { createdAt: 'desc' }],
      select: { amount: true, at: true, businessDate: true, recordedBy: { select: { name: true } } },
    });
    if (!row) return null;
    return { accountId, amount: num(row.amount), at: row.at, businessDate: dateKey(row.businessDate), byName: row.recordedBy.name };
  }

  /**
   * A close that anchors the drawer: locked, with the cash counted. An attested,
   * not-verified or skipped drawer, and a day still counting or reopened, anchor
   * nothing.
   */
  private async countedClose(branchId: Buffer, date: string): Promise<CountedClose | null> {
    const row = await this.db.dailyClosing.findUnique({
      where: { branchId_closingDate: { branchId, closingDate: dateValue(date) } },
      select: {
        status: true,
        countedCash: true,
        closedAt: true,
        closedBy: { select: { name: true } },
        channelCounts: { where: { channel: 'cash' }, select: { countedAt: true, countedBy: { select: { name: true } } } },
      },
    });
    if (!row || row.status !== 'locked' || row.countedCash == null) return null;
    const count = row.channelCounts[0];
    return {
      closingDate: date,
      countedCash: num(row.countedCash),
      at: count?.countedAt ?? row.closedAt,
      byName: count?.countedBy?.name ?? row.closedBy?.name ?? null,
    };
  }

  /**
   * What moved through each anchored account after its anchor, at every branch
   * of the company, per component. The same sources, status filters and signs as
   * the closing's `channelMovements`; only the window differs — each movement
   * counts from the moment the money moved, strictly after the anchor, because
   * the anchor is what the provider's app showed at its own moment:
   * - money received, and purchases paid at receipt: when it was paid;
   * - refunds, supplier settlements and variable expenses: when they were
   *   REPORTED — the money left then, and the Owner's confirmation later does not
   *   move it again;
   * - a fixed expense: on its due day, as the closing counts it — once that day
   *   has come (`today`, this branch's business date), never ahead of it;
   * - a correction that fixes a record (a payment moved to its real account, a
   *   payment or payout that never happened): at the corrected record's own
   *   moment, so an anchor taken after the mistake — already true — is not
   *   corrected twice;
   * - a cancellation: when it was approved, since the money is handed back then.
   * Money that named no account belongs to no method.
   */
  private async movementsSince(
    client: Pick<TenantPrisma, '$queryRaw'>,
    companyId: Buffer,
    anchors: DeclaredAnchor[],
    today: string,
  ): Promise<MovementRow[]> {
    if (anchors.length === 0) return [];
    const windows = anchors.map((a) => ({ account: uuidToBin(a.accountId), ...movementWindow(a) }));
    const after = (account: string, date: string, instant: string) =>
      Prisma.join(
        windows.map(
          (w) => Prisma.sql`(${Prisma.raw(account)} = ${w.account} AND ${Prisma.raw(date)} >= ${w.fromDate} AND ${Prisma.raw(instant)} > ${w.after})`,
        ),
        ' OR ',
      );
    // A day-dated movement (a fixed expense on its due day) counts when its day is after the anchor's and has come.
    const afterDay = (account: string, date: string) =>
      Prisma.join(
        windows.map(
          (w) => Prisma.sql`(${Prisma.raw(account)} = ${w.account} AND ${Prisma.raw(date)} > ${w.day} AND ${Prisma.raw(date)} <= ${today})`,
        ),
        ' OR ',
      );
    const rows = await client.$queryRaw<{ account_id: Buffer; component: string; amount: unknown }[]>(Prisma.sql`
      -- Money received from sales into the account, from when it arrived.
      SELECT p.receiving_account_id AS account_id, 'salesIn' AS component, SUM(p.amount) AS amount
      FROM payments p
      WHERE p.company_id = ${companyId} AND p.method <> 'cash'
        AND (${after('p.receiving_account_id', 'p.business_date', 'p.paid_at')})
      GROUP BY p.receiving_account_id

      UNION ALL
      -- Refunds, from when they were paid out (reported).
      SELECT receiving_account_id, 'refundsOut', SUM(reported_amount)
      FROM refund_payouts
      WHERE company_id = ${companyId} AND status = 'confirmed' AND method <> 'cash'
        AND (${after('receiving_account_id', 'confirmation_date', 'reported_at')})
      GROUP BY receiving_account_id

      UNION ALL
      -- Supplier payments, from when they were paid (reported).
      SELECT receiving_account_id, 'supplierOut', SUM(amount)
      FROM supplier_settlements
      WHERE company_id = ${companyId} AND status = 'confirmed' AND method <> 'cash'
        AND (${after('receiving_account_id', 'confirmation_date', 'reported_at')})
      GROUP BY receiving_account_id

      UNION ALL
      -- Purchases paid at receipt, from when they were paid.
      SELECT sp.receiving_account_id, 'supplierOut', SUM(sp.amount)
      FROM supplier_payments sp
      JOIN purchases pu ON pu.id = sp.purchase_id
      WHERE sp.company_id = ${companyId} AND sp.method <> 'cash'
        AND (${after('sp.receiving_account_id', 'sp.business_date', 'sp.paid_at')})
      GROUP BY sp.receiving_account_id

      UNION ALL
      -- Variable expenses, from when they were paid (reported; a legacy row without a report, when confirmed).
      SELECT receiving_account_id, 'expensesOut', SUM(amount)
      FROM expenses
      WHERE company_id = ${companyId} AND status = 'confirmed' AND method <> 'cash' AND expense_class <> 'fixed'
        AND (${after('receiving_account_id', 'confirmation_date', 'COALESCE(reported_at, confirmed_at)')})
      GROUP BY receiving_account_id

      UNION ALL
      -- Fixed expenses, on their due day.
      SELECT receiving_account_id, 'expensesOut', SUM(amount)
      FROM expenses
      WHERE company_id = ${companyId} AND status = 'confirmed' AND method <> 'cash' AND expense_class = 'fixed'
        AND (${afterDay('receiving_account_id', 'due_date')})
      GROUP BY receiving_account_id

      UNION ALL
      -- A refund or supplier payment that never happened: undone at the payout's own moment.
      SELECT COALESCE(rp.receiving_account_id, ss.receiving_account_id), 'correctionsIn', SUM(fc.amount)
      FROM financial_corrections fc
      LEFT JOIN refund_payouts rp ON rp.id = fc.target_refund_payout_id
      LEFT JOIN supplier_settlements ss ON ss.id = fc.target_supplier_settlement_id
      WHERE fc.company_id = ${companyId}
        AND fc.target_kind IN ('refund_payout', 'supplier_settlement')
        AND fc.status = 'approved' AND fc.method <> 'cash'
        AND (${after('COALESCE(rp.receiving_account_id, ss.receiving_account_id)', 'COALESCE(rp.confirmation_date, ss.confirmation_date)', 'COALESCE(rp.reported_at, ss.reported_at)')})
      GROUP BY COALESCE(rp.receiving_account_id, ss.receiving_account_id)

      UNION ALL
      -- A payment moved to its real account, or one that never arrived: at the payment's own moment (0079).
      SELECT l.receiving_account_id,
             IF(l.direction = 'in', 'correctionsIn', 'correctionsOut'),
             SUM(l.amount)
      FROM financial_correction_legs l
      JOIN financial_corrections fc ON fc.id = l.correction_id
      JOIN payments p ON p.id = l.source_payment_id
      WHERE fc.company_id = ${companyId} AND fc.status = 'approved' AND l.method <> 'cash'
        AND fc.target_kind = 'sale_payment' AND fc.action IN ('reverse', 'reclassify')
        AND (${after('l.receiving_account_id', 'p.business_date', 'p.paid_at')})
      GROUP BY l.receiving_account_id, l.direction

      UNION ALL
      -- A purchase payment fixed the same way: at its own moment.
      SELECT l.receiving_account_id,
             IF(l.direction = 'in', 'correctionsIn', 'correctionsOut'),
             SUM(l.amount)
      FROM financial_correction_legs l
      JOIN financial_corrections fc ON fc.id = l.correction_id
      JOIN supplier_payments sp ON sp.id = l.source_supplier_payment_id
      WHERE fc.company_id = ${companyId} AND fc.status = 'approved' AND l.method <> 'cash'
        AND fc.target_kind = 'supplier_payment' AND fc.action IN ('reverse', 'reclassify')
        AND (${after('l.receiving_account_id', 'sp.business_date', 'sp.paid_at')})
      GROUP BY l.receiving_account_id, l.direction

      UNION ALL
      -- An expense fixed the same way: at the expense's own moment (a fixed one on its due day).
      SELECT l.receiving_account_id,
             IF(l.direction = 'in', 'correctionsIn', 'correctionsOut'),
             SUM(l.amount)
      FROM financial_correction_legs l
      JOIN financial_corrections fc ON fc.id = l.correction_id
      JOIN expenses e ON e.id = l.source_expense_id
      WHERE fc.company_id = ${companyId} AND fc.status = 'approved' AND l.method <> 'cash'
        AND fc.target_kind = 'expense' AND fc.action IN ('reverse', 'reclassify')
        AND (
          (e.expense_class <> 'fixed' AND (${after('l.receiving_account_id', 'e.confirmation_date', 'COALESCE(e.reported_at, e.confirmed_at)')}))
          OR (e.expense_class = 'fixed' AND (${afterDay('l.receiving_account_id', 'e.due_date')}))
        )
      GROUP BY l.receiving_account_id, l.direction

      UNION ALL
      -- Every other correction's legs (a sale or purchase cancelled, money handed back): when it was approved.
      SELECT l.receiving_account_id,
             IF(l.direction = 'in', 'correctionsIn', 'correctionsOut'),
             SUM(l.amount)
      FROM financial_correction_legs l
      JOIN financial_corrections fc ON fc.id = l.correction_id
      WHERE fc.company_id = ${companyId} AND fc.status = 'approved' AND l.method <> 'cash'
        AND NOT (fc.target_kind IN ('sale_payment', 'supplier_payment', 'expense') AND fc.action IN ('reverse', 'reclassify'))
        AND (${after('l.receiving_account_id', 'fc.correction_date', 'fc.decided_at')})
      GROUP BY l.receiving_account_id, l.direction
    `);

    return rows
      .filter((r) => r.amount != null && r.account_id != null)
      .map((r) => ({
        channel: 'account' as const,
        accountId: binToUuid(r.account_id),
        component: r.component as Component,
        amount: round2(num(r.amount as Prisma.Decimal)),
      }));
  }
}
