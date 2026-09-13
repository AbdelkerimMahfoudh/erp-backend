import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import {
  assertMayStartDealing,
  newDealingRefusal,
  type ConnectionStatusLike,
  type CounterpartyKindLike,
} from '../consignment/dealing-authorization';
import {
  assertDecision,
  assertForgivenessAllowed,
  assertPaymentAllowed,
  breakdown,
  directionFor,
  fingerprintPayment,
  GROUP_OF,
  LoanRefused,
  readable,
  remaining,
  type Direction,
  type LedgerKind,
  type LoanStatus,
} from './loan-rules';
import { CreateLoanDto, DecideLoanDto, ForgiveLoanDto, LoanPaymentDto } from './dto/loan.dto';

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));

/**
 * Money owed, in both directions (Milestone I).
 *
 * Like consignments, a loan between two application companies belongs to two
 * tenants, so this uses the **unscoped** Prisma client and filters every read
 * on `companyId = me OR counterpartyCompanyId = me`. A company on neither side
 * gets a 404, never a 403 — a 403 would confirm the loan exists and let ids be
 * enumerated to learn who owes whom.
 *
 * The rule that shapes the whole service: **the creditor is decided by the
 * DIRECTION, not by who created the record.** A shop that borrows money creates
 * the loan just as often as one that lends it, and getting this backwards would
 * let a debtor confirm their own repayment.
 */
@Injectable()
export class LoansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Both company columns, so either party can read it. */
  private visible(me: Buffer): Prisma.LoanWhereInput {
    return { OR: [{ companyId: me }, { counterpartyCompanyId: me }] };
  }

  async propose(dto: CreateLoanDto) {
    const me = this.tenant.companyId();
    const branchId = this.tenant.branchId() ?? null;
    const userId = this.tenant.userId() ?? null;

    if (dto.clientUuid) {
      const replay = await this.prisma.loan.findFirst({
        where: { companyId: me, clientUuid: uuidToBin(dto.clientUuid) },
      });
      if (replay) return this.get(binToUuid(replay.id));
    }

    const counterparty = await this.prisma.counterparty.findFirst({
      where: { id: uuidToBin(dto.counterpartyId), companyId: me, isActive: true },
      include: { connection: true },
    });
    if (!counterparty) throw new NotFoundException('No such counterparty');

    /**
     * A new debt with another STORE needs a connection that store has accepted
     * (Partners rule). Before this, only `blocked` was refused, so a pending
     * request — or a shop typed in by hand — could already start a loan. Lending
     * to a person or an employee is not an inter-store dealing and is unaffected.
     * Checked early for a fast answer, and again inside the commit.
     */
    const early = newDealingRefusal({
      kind: counterparty.kind as CounterpartyKindLike,
      connectionStatus: (counterparty.connection?.status as ConnectionStatusLike | undefined) ?? null,
    });
    if (early) throw new ConflictException({ code: early.code, message: early.message });

    const id = newUuidV7Bin();
    await this.prisma.$transaction(async (tx) => {
    await assertMayStartDealing(tx, counterparty.id);
    await tx.loan.create({
      data: {
        id,
        companyId: me,
        branchId,
        counterpartyId: counterparty.id,
        counterpartyCompanyId: counterparty.connectedCompanyId,
        connectionId: counterparty.connectionId,
        direction: dto.direction,
        status: 'proposed',
        proposedAmount: dto.amount,
        note: dto.note?.trim() || null,
        /**
         * The company whose offer is on the table. This is what makes "you
         * cannot accept your own offer" answerable from the row rather than
         * from a guess about who spoke last.
         */
        proposedByCompanyId: me,
        proposedById: userId,
        clientUuid: dto.clientUuid ? uuidToBin(dto.clientUuid) : null,
      },
    });
    });

    await this.audit.record({
      entityType: 'Loan',
      entityId: id,
      action: 'create',
      after: { direction: dto.direction, amount: dto.amount, to: counterparty.name },
      branchId: branchId ?? undefined,
    });

    if (counterparty.connectedCompanyId) {
      await this.notifications.emit({
        type: 'loan.proposed',
        title: 'A store proposed a debt',
        body: `${dto.amount} — you can accept, counter or dispute it`,
      });
    }
    return this.get(binToUuid(id));
  }

  /**
   * Browse loans.
   *
   * `opts.all` lifts the 200-row cap, for the report export only. The cap is
   * right for a screen — nobody scrolls two hundred debts — and wrong for a
   * file, where a silent stop at row 200 is a balance sheet missing debts
   * nothing in the file mentions.
   */
  async list(group?: 'pending' | 'accepted' | 'confirmed', opts?: { all?: boolean }) {
    const me = this.tenant.companyId();
    const rows = await this.prisma.loan.findMany({
      where: this.visible(me),
      include: {
        counterparty: { select: { name: true, kind: true } },
        company: { select: { name: true } },
        ledger: { select: { kind: true, amount: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...(opts?.all ? {} : { take: 200 }),
    });
    return {
      rows: rows.map((l) => this.summarise(l, me)).filter((r) => !group || r.group === group),
    };
  }

  async get(id: string) {
    const me = this.tenant.companyId();
    const loan = await this.prisma.loan.findFirst({
      where: { id: uuidToBin(id), ...this.visible(me) },
      include: {
        counterparty: { select: { name: true, kind: true } },
        company: { select: { name: true } },
        ledger: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!loan) throw new NotFoundException('No such loan');

    /**
     * Ids and links included: `breakdown` needs them to tell a report that has
     * been confirmed from one still waiting.
     */
    const rows = loan.ledger.map((e) => ({
      kind: e.kind as LedgerKind,
      amount: num(e.amount),
      id: binToUuid(e.id),
      refersToId: e.refersToId ? binToUuid(e.refersToId) : null,
    }));
    return {
      ...this.summarise(loan, me),
      note: loan.note,
      disputeReason: loan.disputeReason,
      /** Every figure the server computed, so no screen re-derives a balance. */
      breakdown: breakdown(rows),
      ledger: loan.ledger.map((e) => ({
        id: binToUuid(e.id),
        kind: e.kind,
        amount: num(e.amount),
        /**
         * Which entry this one answers. The screens need it to tell a report
         * still waiting from one already confirmed, and guessing by position
         * would pick the wrong entry once two payments overlap.
         */
        refersToId: e.refersToId ? binToUuid(e.refersToId) : null,
        method: e.method,
        accountLabel: e.accountLabelSnapshot,
        reference: e.reference,
        evidenceRef: e.evidenceRef,
        reason: e.reason,
        date: e.entryDate,
        byMe: e.actingCompanyId.equals(me),
      })),
    };
  }

  /** Accept, counter, dispute, reject or cancel. */
  async decide(id: string, dto: DecideLoanDto) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;
    const loan = await this.mine(id);

    /**
     * Whose offer is on the table. For a MANUAL counterparty there is nobody on
     * the other side to answer, so the Owner records the other party's decision
     * — and `isOwnOffer` is false, because they are acting for them.
     */
    const isOwnOffer = Boolean(loan.counterpartyCompanyId) && loan.proposedByCompanyId.equals(me);

    let next: LoanStatus;
    try {
      next = assertDecision({
        action: dto.action,
        from: loan.status as LoanStatus,
        isOwnOffer,
        amount: dto.amount,
        reason: dto.reason,
      });
    } catch (e) {
      if (e instanceof LoanRefused) throw new ConflictException(e.message);
      throw e;
    }

    if (dto.expectedVersion != null && dto.expectedVersion !== loan.version) {
      throw new ConflictException('refresh_required: this loan changed while you were reading it');
    }

    /**
     * What is being accepted: the counter if there is one, otherwise the
     * original. Nobody accepts one number and owes another.
     */
    const agreed = num(loan.counterAmount ?? loan.proposedAmount);

    await this.prisma.$transaction(async (tx) => {
      /**
       * Accepting a debt, or countering with a new amount, is a new commitment
       * and needs the connection accepted at commit. Rejecting, disputing and
       * cancelling stay open after a connection ends.
       */
      if (dto.action === 'accept' || dto.action === 'counter') {
        await assertMayStartDealing(tx, loan.counterpartyId);
      }
      const won = await tx.loan.updateMany({
        where: { id: loan.id, version: loan.version, status: loan.status },
        data: {
          status: next,
          ...(dto.action === 'counter'
            ? { counterAmount: dto.amount, proposedByCompanyId: me, proposedById: userId }
            : {}),
          ...(dto.action === 'dispute' ? { disputeReason: dto.reason?.trim() } : {}),
          ...(dto.action === 'accept'
            ? { principal: agreed, acceptedAt: new Date(), decidedById: userId }
            : {}),
          version: { increment: 1 },
        },
      });
      if (won.count === 0) {
        throw new ConflictException('refresh_required: somebody else answered first');
      }

      if (dto.action === 'accept') {
        /**
         * The principal reaches the ledger in the SAME transaction that sets it
         * on the loan. A principal without its ledger row would make the
         * derived balance zero on an accepted debt — the balance is the ledger,
         * so the ledger has to carry it.
         */
        await tx.loanLedgerEntry.create({
          data: {
            id: newUuidV7Bin(),
            loanId: loan.id,
            companyId: loan.companyId,
            counterpartyCompanyId: loan.counterpartyCompanyId,
            kind: 'principal_accepted',
            amount: agreed,
            actingCompanyId: me,
            actingUserId: userId,
            entryDate: new Date(`${dayKey(new Date())}T00:00:00.000Z`),
          },
        });
      }
    });

    await this.audit.record({
      entityType: 'Loan',
      entityId: loan.id,
      action: 'status_change',
      before: { status: loan.status },
      after: { status: next, amount: dto.action === 'accept' ? agreed : (dto.amount ?? null) },
      branchId: loan.branchId ?? undefined,
    });
    return this.get(id);
  }

  /** Report a payment, or confirm one arrived. */
  async payment(id: string, dto: LoanPaymentDto) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;
    const loan = await this.mine(id);

    if (!loan.principal) {
      throw new ConflictException('Nothing has been agreed to pay yet');
    }

    const rows = await this.ledgerRows(loan.id);
    const owed = remaining(rows);

    if (dto.action === 'confirm') {
      this.assertCreditor(loan, me);

      const reported = await this.prisma.loanLedgerEntry.findFirst({
        where: { id: uuidToBin(dto.entryId ?? ''), loanId: loan.id, kind: 'payment_reported' },
      });
      if (!reported) throw new NotFoundException('No such reported payment');
      const already = await this.prisma.loanLedgerEntry.findFirst({
        where: { refersToId: reported.id, kind: 'payment_confirmed' },
      });
      if (already) throw new ConflictException('That payment has already been confirmed');

      try {
        assertPaymentAllowed({
          amount: num(reported.amount),
          method: (reported.method ?? 'cash') as 'cash' | 'account',
          receivingAccountId: reported.receivingAccountId ? binToUuid(reported.receivingAccountId) : null,
          remaining: owed,
        });
      } catch (e) {
        if (e instanceof LoanRefused) throw new ConflictException(e.message);
        throw e;
      }

      await this.prisma.loanLedgerEntry.create({
        data: {
          id: newUuidV7Bin(),
          loanId: loan.id,
          companyId: loan.companyId,
          counterpartyCompanyId: loan.counterpartyCompanyId,
          kind: 'payment_confirmed',
          amount: reported.amount,
          method: reported.method,
          receivingAccountId: reported.receivingAccountId,
          accountLabelSnapshot: reported.accountLabelSnapshot,
          reference: reported.reference,
          refersToId: reported.id,
          actingCompanyId: me,
          actingUserId: userId,
          entryDate: new Date(`${dayKey(new Date())}T00:00:00.000Z`),
        },
      });
      await this.settleIfClear(loan.id);
      return this.get(id);
    }

    if (dto.action === 'correct') {
      /**
       * Reversing a CONFIRMED payment, the same shape Milestone B established:
       * a new entry that puts the debt back, never an edit that erases the
       * claim anybody ever made.
       */
      this.assertCreditor(loan, me);
      if (!dto.reason?.trim()) throw new BadRequestException('Say why you are reversing it');

      const confirmed = await this.prisma.loanLedgerEntry.findFirst({
        where: { id: uuidToBin(dto.entryId ?? ''), loanId: loan.id, kind: 'payment_confirmed' },
      });
      if (!confirmed) throw new NotFoundException('No such confirmed payment');
      const undone = await this.prisma.loanLedgerEntry.findFirst({
        where: { refersToId: confirmed.id, kind: 'payment_corrected' },
      });
      if (undone) throw new ConflictException('That payment has already been reversed');

      await this.prisma.loanLedgerEntry.create({
        data: {
          id: newUuidV7Bin(),
          loanId: loan.id,
          companyId: loan.companyId,
          counterpartyCompanyId: loan.counterpartyCompanyId,
          kind: 'payment_corrected',
          amount: confirmed.amount,
          reason: dto.reason.trim(),
          refersToId: confirmed.id,
          actingCompanyId: me,
          actingUserId: userId,
          entryDate: new Date(`${dayKey(new Date())}T00:00:00.000Z`),
        },
      });
      // The debt is back, so a settled loan reopens.
      await this.prisma.loan.updateMany({
        where: { id: loan.id, status: { in: ['settled', 'forgiven_settled'] } },
        data: { status: 'partially_paid', settledAt: null },
      });
      return this.get(id);
    }

    // --- report ---
    /**
     * The fingerprint is what makes this safe to queue offline (Milestone J).
     *
     * Replaying on the key alone would answer an edited draft with the original
     * amount, and the phone would show it as synced — so the shop would believe
     * it had reported a figure the server never saw.
     */
    const fingerprint = fingerprintPayment({
      loanId: id,
      amount: dto.amount ?? 0,
      method: dto.method ?? 'cash',
      receivingAccountId: dto.receivingAccountId,
      reference: dto.reference,
      evidenceRef: dto.evidenceRef,
    });

    if (dto.clientUuid) {
      const replay = await this.prisma.loanLedgerEntry.findFirst({
        where: { actingCompanyId: me, clientUuid: uuidToBin(dto.clientUuid) },
      });
      if (replay) {
        // Null on rows written before J: those keep replaying as they always
        // did rather than becoming a conflict nobody can explain.
        if (replay.clientRequestHash && replay.clientRequestHash !== fingerprint) {
          throw new ConflictException({
            code: 'idempotency_conflict',
            message: 'That request id was already used to report a different payment.',
          });
        }
        return this.get(id);
      }
    }

    try {
      assertPaymentAllowed({
        amount: dto.amount ?? 0,
        method: dto.method ?? 'cash',
        receivingAccountId: dto.receivingAccountId ?? null,
        remaining: owed,
      });
    } catch (e) {
      if (e instanceof LoanRefused) throw new BadRequestException(e.message);
      throw e;
    }

    const account = dto.receivingAccountId
      ? await this.prisma.receivingAccount.findFirst({
          where: { id: uuidToBin(dto.receivingAccountId), companyId: me },
          select: { label: true },
        })
      : null;

    await this.prisma.loanLedgerEntry.create({
      data: {
        id: newUuidV7Bin(),
        loanId: loan.id,
        companyId: loan.companyId,
        counterpartyCompanyId: loan.counterpartyCompanyId,
        kind: 'payment_reported',
        amount: dto.amount as number,
        method: dto.method,
        receivingAccountId: dto.receivingAccountId ? uuidToBin(dto.receivingAccountId) : null,
        // Frozen: a later rename must not retitle a movement that happened.
        accountLabelSnapshot: account?.label ?? null,
        reference: dto.reference?.trim() || null,
        /**
         * A photo or document. **Not proof** — nothing external is checked, and
         * the screens must never present it as verification.
         */
        evidenceRef: dto.evidenceRef?.trim() || null,
        note: dto.note?.trim() || null,
        actingCompanyId: me,
        actingUserId: userId,
        entryDate: new Date(`${dayKey(new Date())}T00:00:00.000Z`),
        clientUuid: dto.clientUuid ? uuidToBin(dto.clientUuid) : null,
        clientRequestHash: dto.clientUuid ? fingerprint : null,
      },
    });
    await this.prisma.loan.updateMany({
      where: { id: loan.id, status: { in: ['accepted', 'partially_paid'] } },
      data: { status: 'payment_awaiting_confirmation' },
    });
    return this.get(id);
  }

  /** Write off part or all. Creditor's Owner only. */
  async forgive(id: string, dto: ForgiveLoanDto) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;
    const loan = await this.mine(id);
    this.assertCreditor(loan, me);

    if (!loan.principal) throw new ConflictException('Nothing has been agreed to write off');

    const owed = remaining(await this.ledgerRows(loan.id));
    try {
      assertForgivenessAllowed({ amount: dto.amount, reason: dto.reason, remaining: owed });
    } catch (e) {
      if (e instanceof LoanRefused) throw new BadRequestException(e.message);
      throw e;
    }

    await this.prisma.loanLedgerEntry.create({
      data: {
        id: newUuidV7Bin(),
        loanId: loan.id,
        companyId: loan.companyId,
        counterpartyCompanyId: loan.counterpartyCompanyId,
        kind: 'forgiven',
        amount: dto.amount,
        reason: dto.reason.trim(),
        actingCompanyId: me,
        actingUserId: userId,
        entryDate: new Date(`${dayKey(new Date())}T00:00:00.000Z`),
      },
    });

    await this.audit.record({
      entityType: 'Loan',
      entityId: loan.id,
      action: 'override',
      after: { forgiven: dto.amount, reason: dto.reason.trim() },
      branchId: loan.branchId ?? undefined,
    });
    await this.settleIfClear(loan.id, 'forgiven_settled');
    return this.get(id);
  }

  /**
   * What needs somebody's attention before the day is signed off.
   *
   * Surfaced BESIDE the closing, never inside it. A reminder must not alter
   * expected cash or profit — Milestone E spent a whole checkpoint pinning that
   * equation, and a loan is a balance-sheet movement that belongs nowhere in it.
   */
  async closingReminders() {
    const me = this.tenant.companyId();
    const loans = await this.prisma.loan.findMany({
      where: {
        ...this.visible(me),
        status: { in: ['proposed', 'counter_proposed', 'disputed', 'accepted', 'partially_paid', 'payment_awaiting_confirmation'] },
      },
      include: {
        counterparty: { select: { name: true } },
        company: { select: { name: true } },
        ledger: { select: { kind: true, amount: true } },
      },
      take: 100,
    });

    const needsAnswer = loans.filter(
      (l) =>
        ['proposed', 'counter_proposed', 'disputed'].includes(l.status) &&
        !(l.counterpartyCompanyId && l.proposedByCompanyId.equals(me)),
    );
    const awaitingConfirm = loans.filter((l) => l.status === 'payment_awaiting_confirmation');
    const outstanding = loans.filter(
      (l) => l.principal && remaining(l.ledger.map((e) => ({ kind: e.kind as LedgerKind, amount: num(e.amount) }))) > 0,
    );

    return {
      /** Counts only. The closing screen shows a nudge, not a second ledger. */
      proposalsNeedingAnswer: needsAnswer.length,
      paymentsAwaitingConfirmation: awaitingConfirm.length,
      balancesOutstanding: outstanding.length,
      totalOutstanding: outstanding.reduce(
        (s, l) => s + remaining(l.ledger.map((e) => ({ kind: e.kind as LedgerKind, amount: num(e.amount) }))),
        0,
      ),
      /**
       * Stated in the payload so no screen has to infer it: none of this touches
       * the till figure or the day's profit.
       */
      affectsExpectedCash: false,
    };
  }

  // --- helpers --------------------------------------------------------------

  private async mine(id: string) {
    const me = this.tenant.companyId();
    const loan = await this.prisma.loan.findFirst({
      where: { id: uuidToBin(id), ...this.visible(me) },
    });
    // 404, never 403: a 403 confirms the loan exists.
    if (!loan) throw new NotFoundException('No such loan');
    return loan;
  }

  /**
   * Only the creditor may confirm a payment or write a debt off.
   *
   * Decided by the DIRECTION, not by who created the record. `they_owe_us` on a
   * row created by A means A is owed; the same row read by B is `we_owe_them`,
   * and B is the debtor. Getting this backwards would let a debtor confirm
   * their own repayment.
   */
  private assertCreditor(
    loan: { companyId: Buffer; counterpartyCompanyId: Buffer | null; direction: string },
    me: Buffer,
  ): void {
    const iAmOwner = loan.companyId.equals(me);
    const creditorIsOwner = loan.direction === 'they_owe_us';
    if (iAmOwner !== creditorIsOwner) {
      throw new ForbiddenException('Only the person owed the money can do that');
    }
  }

  private async ledgerRows(loanId: Buffer) {
    const rows = await this.prisma.loanLedgerEntry.findMany({
      where: { loanId },
      select: { kind: true, amount: true },
    });
    return rows.map((r) => ({ kind: r.kind as LedgerKind, amount: num(r.amount) }));
  }

  private async settleIfClear(loanId: Buffer, as: 'settled' | 'forgiven_settled' = 'settled') {
    const owed = remaining(await this.ledgerRows(loanId));
    if (owed > 0) {
      await this.prisma.loan.updateMany({
        where: { id: loanId, status: { in: ['accepted', 'payment_awaiting_confirmation'] } },
        data: { status: 'partially_paid' },
      });
      return;
    }
    await this.prisma.loan.updateMany({
      where: { id: loanId, status: { in: ['accepted', 'partially_paid', 'payment_awaiting_confirmation'] } },
      data: { status: as, settledAt: new Date() },
    });
  }

  private summarise(
    loan: {
      id: Buffer;
      companyId: Buffer;
      counterpartyCompanyId: Buffer | null;
      direction: string;
      status: string;
      proposedAmount: Prisma.Decimal;
      counterAmount: Prisma.Decimal | null;
      principal: Prisma.Decimal | null;
      createdAt: Date;
      version: number;
      counterparty: { name: string; kind: string };
      company: { name: string };
      ledger: { kind: string; amount: Prisma.Decimal }[];
    },
    me: Buffer,
  ) {
    const iAmOwner = loan.companyId.equals(me);
    const rows = loan.ledger.map((e) => ({ kind: e.kind as LedgerKind, amount: num(e.amount) }));
    return {
      id: binToUuid(loan.id),
      status: loan.status,
      group: GROUP_OF[loan.status as LoanStatus],
      statusText: readable(loan.status as LoanStatus),
      /**
       * From THIS company's point of view. The same row reads `they_owe_us` to
       * one side and `we_owe_them` to the other, which is why there is one row.
       */
      direction: directionFor(
        { companyId: binToUuid(loan.companyId), direction: loan.direction as Direction },
        binToUuid(me),
      ),
      /** Always the OTHER party's name, whichever side you are on. */
      otherParty: iAmOwner ? loan.counterparty.name : loan.company.name,
      proposedAmount: num(loan.proposedAmount),
      counterAmount: loan.counterAmount == null ? null : num(loan.counterAmount),
      principal: loan.principal == null ? null : num(loan.principal),
      remaining: remaining(rows),
      createdAt: loan.createdAt,
      version: loan.version,
    };
  }
}
