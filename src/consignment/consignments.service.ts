import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import {
  assertMayStartDealing,
  newDealingRefusal,
  type ConnectionStatusLike,
  type CounterpartyKindLike,
} from './dealing-authorization';
import {
  assertDestination,
  assertSource,
  sideOf,
  visibleToCompany,
  type Side,
} from './consignment-scope';
import {
  assertIdentifierMatches,
  assertTransition,
  amountIsMutable,
  GROUP_OF,
  readable,
  TransitionRefused,
  type Action,
  type ConsignmentStatus,
} from './consignment-lifecycle';
import {
  ConsignmentPaymentDto,
  CreateConsignmentDto,
  CustodyDto,
  DecideConsignmentDto,
  ForgiveDto,
  ReportSoldDto,
  ReturnDto,
} from './dto/consignment.dto';
import {
  assertForgivenessAllowed,
  assertPaymentAllowed,
  fingerprintPayment,
  MoneyRefused,
  outstanding,
  type LedgerKind,
} from './consignment-money';
import { dayKey } from '../common/utils/date.util';

const num = (d: { toString(): string } | number | null): number => (d == null ? 0 : Number(d));

/**
 * Sending stock to another shop to sell on your behalf (H-CP3).
 *
 * Like `ConnectionsService`, this uses the **unscoped** Prisma client, because a
 * consignment belongs to two companies and the tenant extension can only scope
 * to one. Every read therefore passes `visibleToCompany(me)`, and every act
 * passes `sideOf`/`assertSource`/`assertDestination`. A stranger gets 404.
 *
 * The two guarantees worth stating outright:
 *
 * 1. **A phone can be claimed once.** The compare-and-swap on `units.status`
 *    and the generated `active_unit_id` on `consignment_lines` are two
 *    independent halves of the same promise; either alone would leave a race.
 * 2. **Ownership never moves.** No second unit is created in the destination
 *    company. Store 2 holds custody, and its right to sell comes from the
 *    consignment line, not from owning anything.
 */
@Injectable()
export class ConsignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Propose sending one or more phones.
   *
   * Reservation happens FIRST, before anything else is written. That ordering is
   * the lesson `transfers.service.ts` records: reserving last meant a clash only
   * surfaced at ship, by which point two people believed they had the phone.
   */
  async create(dto: CreateConsignmentDto) {
    const me = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId() ?? null;

    if (dto.unitIds.length === 0) throw new BadRequestException('Choose at least one phone');
    if (dto.unitIds.length > 50) {
      throw new BadRequestException('That is too many phones for one consignment');
    }

    if (dto.clientUuid) {
      const replay = await this.prisma.consignment.findFirst({
        where: { sourceCompanyId: me, clientUuid: uuidToBin(dto.clientUuid) },
      });
      if (replay) return this.get(binToUuid(replay.id));
    }

    const counterparty = await this.prisma.counterparty.findFirst({
      where: { id: uuidToBin(dto.counterpartyId), companyId: me, isActive: true },
      include: { connection: true },
    });
    if (!counterparty) throw new NotFoundException('No such counterparty');

    /**
     * A new consignment needs an ACCEPTED connection (Partners rule). Checked
     * early here so a refusal is fast, and again below inside the commit, where
     * it actually counts — see `assertMayStartDealing`.
     */
    const early = newDealingRefusal({
      kind: counterparty.kind as CounterpartyKindLike,
      connectionStatus: (counterparty.connection?.status as ConnectionStatusLike | undefined) ?? null,
    });
    if (early) throw new ConflictException({ code: early.code, message: early.message });

    const consignmentId = newUuidV7Bin();
    const created = await this.prisma.$transaction(async (tx) => {
      await assertMayStartDealing(tx, counterparty.id);
      /**
       * The parent row is written FIRST, because `fk_cline_consignment` requires
       * it — the live run failed here with "Related record constraint failed"
       * when the lines went in ahead of it.
       *
       * This does not weaken the reserve-first rule. Reservation still happens
       * before any line exists, and the whole thing is one transaction: if a
       * compare-and-swap loses, the consignment row rolls back with it and no
       * half-made proposal survives.
       */
      await tx.consignment.create({
        data: {
          id: consignmentId,
          sourceCompanyId: me,
          sourceBranchId: branchId,
          destinationCompanyId: counterparty.connectedCompanyId,
          counterpartyId: counterparty.id,
          connectionId: counterparty.connectionId,
          status: 'requested',
          proposedAmount: dto.proposedAmount,
          note: dto.note?.trim() || null,
          proposedById: userId,
          clientUuid: dto.clientUuid ? uuidToBin(dto.clientUuid) : null,
        },
      });

      const lines: { id: Buffer; identifier: string }[] = [];

      for (const rawUnitId of dto.unitIds) {
        const unitId = uuidToBin(rawUnitId);

        const unit = await tx.unit.findFirst({
          where: { id: unitId, companyId: me, branchId },
          include: { product: { select: { brand: true, model: true, variant: true } } },
        });
        if (!unit) throw new NotFoundException('One of those phones is not in this branch');

        /**
         * The compare-and-swap. `status: 'in_stock'` in the WHERE is the whole
         * guarantee: a second attempt re-reads a row that is already
         * `consigned_out` and matches nothing, so `count` is 0 and this loses.
         */
        const claimed = await tx.unit.updateMany({
          where: { id: unitId, status: 'in_stock' },
          data: { status: 'consigned_out' },
        });
        if (claimed.count === 0) {
          const identifier = unit.imeiPrimary ?? unit.serialNo ?? '';
          throw new ConflictException(
            `${identifier} is not available — it may be reserved, sold or already on consignment`,
          );
        }

        const lineId = newUuidV7Bin();
        await tx.consignmentLine.create({
          data: {
            id: lineId,
            consignmentId,
            sourceCompanyId: me,
            unitId,
            // Snapshotted: what the destination was shown and agreed to. A
            // later rename in our catalogue must not change what was consigned.
            brand: unit.product.brand,
            model: unit.product.model,
            variant: unit.product.variant,
            identifier: unit.imeiPrimary ?? unit.serialNo ?? '',
            conditionNote: dto.conditionNote?.trim() || null,
            // Explicit, so "I was not told" is answerable from the record.
            defectNote: dto.defectNote?.trim() || null,
            agreedAmount: null,
            status: 'proposed',
          },
        });
        lines.push({ id: lineId, identifier: unit.imeiPrimary ?? unit.serialNo ?? '' });
      }

      await this.audit.record({
        entityType: 'Consignment',
        entityId: consignmentId,
        action: 'create',
        after: {
          to: counterparty.name,
          phones: lines.length,
          proposed: dto.proposedAmount,
        },
        branchId,
      });
      return lines.length;
    });

    if (counterparty.connectedCompanyId) {
      await this.notifications.emit({
        type: 'consignment.requested',
        title: 'A store wants to send you stock',
        body: `${created} phone(s) offered at ${dto.proposedAmount}`,
      });
    }
    return this.get(binToUuid(consignmentId));
  }

  /** Consignments this company is part of, either side. */
  async list(group?: 'pending' | 'accepted' | 'confirmed') {
    const me = this.tenant.companyId();
    const rows = await this.prisma.consignment.findMany({
      where: visibleToCompany(me),
      include: {
        lines: true,
        counterparty: { select: { name: true, kind: true } },
        sourceCompany: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return {
      rows: rows
        .map((c) => this.summarise(c, sideOf(c, me)))
        .filter((r) => !group || r.group === group),
    };
  }

  async get(id: string) {
    const me = this.tenant.companyId();
    const c = await this.prisma.consignment.findFirst({
      where: { id: uuidToBin(id), ...visibleToCompany(me) },
      include: {
        lines: true,
        counterparty: { select: { name: true, kind: true } },
        sourceCompany: { select: { name: true } },
        ledger: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!c) throw new NotFoundException('No such consignment');
    const side = sideOf(c, me);

    return {
      ...this.summarise(c, side),
      note: c.note,
      disputeReason: c.disputeReason,
      /**
       * The lines carry no cost and no margin — the columns do not exist. This
       * is the privacy guarantee made structural rather than enforced by a
       * response shaper somebody might edit.
       */
      lines: c.lines.map((l) => ({
        id: binToUuid(l.id),
        brand: l.brand,
        model: l.model,
        variant: l.variant,
        identifier: l.identifier,
        conditionNote: l.conditionNote,
        defectNote: l.defectNote,
        status: l.status,
        disposition: l.disposition,
        returnCondition: l.returnCondition,
      })),
      /**
       * The ledger is shown to both sides. Each already knows every entry — one
       * of them wrote it and the other is party to the money — so there is
       * nothing to withhold here that is not withheld structurally.
       */
      ledger: c.ledger.map((e) => ({
        id: binToUuid(e.id),
        kind: e.kind,
        amount: num(e.amount),
        method: e.method,
        accountLabel: e.accountLabelSnapshot,
        reference: e.reference,
        reason: e.reason,
        date: e.entryDate,
        byMe: e.actingCompanyId.equals(me),
      })),
    };
  }

  /**
   * Accept, counter, dispute, reject or cancel.
   *
   * One entry point rather than five, because they share the version guard, the
   * side check and the "you cannot answer your own offer" rule — and five
   * copies of those would eventually disagree.
   */
  async decide(id: string, dto: DecideConsignmentDto) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;

    const c = await this.mine(id);
    const side = sideOf(c, me);

    if (dto.action === 'dispute' && !dto.reason?.trim()) {
      throw new BadRequestException('Say what the problem is');
    }
    if (dto.action === 'counter' && !(dto.amount && dto.amount > 0)) {
      throw new BadRequestException('A counter-offer needs an amount');
    }

    let next: ConsignmentStatus;
    try {
      next = assertTransition({
        action: dto.action as Action,
        from: c.status as ConsignmentStatus,
        side,
        lastProposalBy: this.lastProposalBy(c),
      });
    } catch (e) {
      if (e instanceof TransitionRefused) throw new ConflictException(e.message);
      throw e;
    }

    if (dto.expectedVersion != null && dto.expectedVersion !== c.version) {
      throw new ConflictException('refresh_required: this consignment changed while you were reading it');
    }

    /**
     * What the two sides settled on. Accepting takes whatever offer is on the
     * table — the counter if there is one, otherwise the original — so nobody
     * can accept one number and be charged another.
     */
    const agreed =
      dto.action === 'accept'
        ? num(c.counterAmount ?? c.proposedAmount)
        : null;

    if (dto.action === 'accept' && !(agreed && agreed > 0)) {
      throw new BadRequestException('There is no amount to accept');
    }

    await this.prisma.$transaction(async (tx) => {
      /**
       * Accepting or counter-offering commits a store to NEW business, so it
       * needs the connection accepted at the moment of commit. Rejecting,
       * disputing and cancelling reduce commitments and stay open whatever the
       * connection's state.
       */
      if (dto.action === 'accept' || dto.action === 'counter') {
        await assertMayStartDealing(tx, c.counterpartyId);
      }
      const won = await tx.consignment.updateMany({
        where: { id: c.id, version: c.version, status: c.status },
        data: {
          status: next,
          ...(dto.action === 'counter' ? { counterAmount: dto.amount, proposedById: userId } : {}),
          ...(dto.action === 'dispute' ? { disputeReason: dto.reason?.trim() } : {}),
          ...(dto.action === 'accept'
            ? { agreedAmount: agreed, decidedById: userId, decidedAt: new Date() }
            : {}),
          version: { increment: 1 },
        },
      });
      if (won.count === 0) {
        throw new ConflictException('refresh_required: somebody else answered first');
      }

      // A cancelled or rejected consignment releases its phones immediately.
      if (next === 'cancelled') await this.releaseUnits(tx, c.id);

      if (dto.action === 'accept') {
        await tx.consignmentLine.updateMany({
          where: { consignmentId: c.id, status: 'proposed' },
          data: { agreedAmount: agreed },
        });
      }

      await this.audit.record({
        entityType: 'Consignment',
        entityId: c.id,
        action: 'status_change',
        before: { status: c.status },
        after: { status: next, amount: agreed, reason: dto.reason?.trim() ?? null },
        branchId: c.sourceBranchId,
      });
    });

    return this.get(id);
  }

  /**
   * Hand the phones over, and confirm they arrived.
   *
   * Two separate acts by two separate companies. The destination confirms the
   * identifier it physically has, and a mismatch is refused with both values —
   * silently adopting the scanned one would rewrite what was agreed.
   */
  async custody(id: string, dto: CustodyDto) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;

    const c = await this.mine(id);
    const side: Side = sideOf(c, me);
    const action: Action = dto.action === 'send' ? 'send_custody' : 'confirm_custody';

    let next: ConsignmentStatus;
    try {
      next = assertTransition({ action, from: c.status as ConsignmentStatus, side });
    } catch (e) {
      if (e instanceof TransitionRefused) throw new ConflictException(e.message);
      throw e;
    }

    if (action === 'send_custody') assertSource(c, me);
    if (action === 'confirm_custody') assertDestination(c, me);

    if (action === 'confirm_custody') {
      if (!c.agreedAmount) {
        // `ck_cons_custody_agreed` refuses this at the database too; catching it
        // here turns a 500 into a sentence.
        throw new ConflictException('There is no agreed amount to confirm against');
      }
      const lines = await this.prisma.consignmentLine.findMany({
        where: { consignmentId: c.id, status: 'proposed' },
      });
      /**
       * Every identifier the receiver scanned must match one that was sent. A
       * partial confirmation is refused outright: confirming three of four
       * phones and leaving the fourth in limbo is worse than refusing, because
       * nobody would know which shop is responsible for it.
       */
      if (dto.identifiers && dto.identifiers.length > 0) {
        if (dto.identifiers.length !== lines.length) {
          throw new BadRequestException(
            `Scan all ${lines.length} phones, or report a problem instead`,
          );
        }
        const sent = [...lines].map((l) => l.identifier);
        for (const scanned of dto.identifiers) {
          const match = sent.find(
            (s) => s.replace(/[\s-]/g, '').toUpperCase() === scanned.replace(/[\s-]/g, '').toUpperCase(),
          );
          if (!match) {
            try {
              assertIdentifierMatches({ expected: sent[0] ?? '(none)', scanned });
            } catch (e) {
              if (e instanceof TransitionRefused) throw new ConflictException(e.message);
              throw e;
            }
          }
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      /**
       * Handing phones over is a NEW stock handover. Confirming receipt of
       * phones that were already sent is finishing an existing obligation, and
       * stays open after a connection ends — nobody should be left holding a
       * shipment they are not allowed to acknowledge.
       */
      if (action === 'send_custody') await assertMayStartDealing(tx, c.counterpartyId);
      const won = await tx.consignment.updateMany({
        where: { id: c.id, version: c.version, status: c.status },
        data: {
          status: next,
          ...(action === 'send_custody'
            ? { custodySentAt: new Date(), custodySentById: userId }
            : { custodyConfirmedAt: new Date(), custodyConfirmedById: userId }),
          version: { increment: 1 },
        },
      });
      if (won.count === 0) {
        throw new ConflictException('refresh_required: this consignment changed while you were reading it');
      }
      if (action === 'confirm_custody') {
        await tx.consignmentLine.updateMany({
          where: { consignmentId: c.id, status: 'proposed' },
          data: { status: 'in_custody' },
        });
      }
      await this.audit.record({
        entityType: 'Consignment',
        entityId: c.id,
        action: 'status_change',
        before: { status: c.status },
        after: { status: next },
        branchId: c.sourceBranchId,
      });
    });

    return this.get(id);
  }


  // --- H-CP4: disposition, money and returns --------------------------------

  /**
   * The holding store reports that a consigned phone sold.
   *
   * This is the moment the source's profit is recognised, and the only one. The
   * payment that follows moves cash and liability and touches profit again
   * never.
   *
   * Store 1 learns that it sold and nothing else: not the customer, not the
   * resale price, not Store 2's margin. Those figures live in Store 2's own
   * `Sale`, which this method deliberately does not read or create — creating
   * one here would put a foreign key from Store 2's sale into Store 1's units.
   */
  async reportSold(id: string, dto: ReportSoldDto) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;

    const c = await this.mine(id);
    const side = sideOf(c, me);

    /**
     * A manual counterparty has no application account, so the SOURCE Owner
     * confirms the sale on their behalf. For an application counterparty only
     * the holder may report it — they are the one who knows.
     */
    if (c.destinationCompanyId) assertDestination(c, me);
    else assertSource(c, me);

    let next: ConsignmentStatus;
    try {
      next = assertTransition({ action: 'report_sold', from: c.status as ConsignmentStatus, side });
    } catch (e) {
      if (e instanceof TransitionRefused) throw new ConflictException(e.message);
      throw e;
    }

    const lines = await this.prisma.consignmentLine.findMany({
      where: { consignmentId: c.id, status: 'in_custody' },
    });
    const soldLines = dto.lineIds?.length
      ? lines.filter((l) => dto.lineIds!.includes(binToUuid(l.id)))
      : lines;
    if (soldLines.length === 0) throw new BadRequestException('There is nothing to report as sold');

    const raised = soldLines.reduce((s, l) => s + Number(l.agreedAmount ?? 0), 0);

    await this.prisma.$transaction(async (tx) => {
      const won = await tx.consignment.updateMany({
        where: { id: c.id, version: c.version, status: c.status },
        data: { status: next, version: { increment: 1 } },
      });
      if (won.count === 0) {
        throw new ConflictException('refresh_required: this consignment changed while you were reading it');
      }

      for (const line of soldLines) {
        await tx.consignmentLine.update({
          where: { id: line.id },
          data: { status: 'sold', disposition: 'sold', disposedAt: new Date() },
        });
        /**
         * The source's unit becomes `sold`. It never becomes a unit in the
         * destination company — Store 2 sold something it did not own, which is
         * exactly what a consignment is.
         */
        await tx.unit.updateMany({
          where: { id: line.unitId, status: 'consigned_out' },
          data: { status: 'sold', dateSold: new Date() },
        });
      }

      /**
       * One receivable entry per consignment, not per line, because the debt is
       * between two businesses rather than per phone. The line-level record of
       * what sold lives on the lines themselves.
       */
      await tx.consignmentLedgerEntry.create({
        data: {
          id: newUuidV7Bin(),
          consignmentId: c.id,
          sourceCompanyId: c.sourceCompanyId,
          destinationCompanyId: c.destinationCompanyId,
          kind: 'receivable_raised',
          amount: raised,
          actingCompanyId: me,
          actingUserId: userId,
          entryDate: new Date(`${dayKey(new Date())}T00:00:00.000Z`),
        },
      });
    });

    await this.audit.record({
      entityType: 'Consignment',
      entityId: c.id,
      action: 'status_change',
      before: { status: c.status },
      after: { status: next, sold: soldLines.length, receivable: raised },
      branchId: c.sourceBranchId,
    });
    return this.get(id);
  }

  /**
   * Report a payment, or confirm one arrived.
   *
   * Two-party, like every other money movement here: the payer reports, the
   * creditor confirms. A report changes no balance until it is confirmed, so a
   * debtor cannot clear their own debt by asserting they paid.
   */
  async payment(id: string, dto: ConsignmentPaymentDto) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;

    const c = await this.mine(id);
    sideOf(c, me);

    const rows = await this.ledgerRows(c.id);
    const owed = outstanding(rows);

    if (dto.action === 'confirm') {
      /**
       * Only the creditor may say money arrived. The source is always the
       * creditor on a consignment: it sent the goods and is owed for them.
       */
      assertSource(c, me);
      const reported = await this.prisma.consignmentLedgerEntry.findFirst({
        where: { id: uuidToBin(dto.entryId ?? ''), consignmentId: c.id, kind: 'payment_reported' },
      });
      if (!reported) throw new NotFoundException('No such reported payment');

      const already = await this.prisma.consignmentLedgerEntry.findFirst({
        where: { refersToId: reported.id, kind: 'payment_confirmed' },
      });
      if (already) throw new ConflictException('That payment has already been confirmed');

      try {
        assertPaymentAllowed({
          amount: Number(reported.amount),
          method: (reported.method ?? 'cash') as 'cash' | 'account',
          receivingAccountId: reported.receivingAccountId ? binToUuid(reported.receivingAccountId) : null,
          outstanding: owed,
        });
      } catch (e) {
        if (e instanceof MoneyRefused) throw new ConflictException(e.message);
        throw e;
      }

      await this.prisma.consignmentLedgerEntry.create({
        data: {
          id: newUuidV7Bin(),
          consignmentId: c.id,
          sourceCompanyId: c.sourceCompanyId,
          destinationCompanyId: c.destinationCompanyId,
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
      await this.settleIfClear(c.id);
      return this.get(id);
    }

    // --- report ---
    /**
     * The fingerprint is what makes this safe to queue offline (Milestone J).
     * Replaying on the key alone would answer an edited draft with the original
     * amount while the phone showed it as synced.
     */
    const fingerprint = fingerprintPayment({
      consignmentId: id,
      amount: dto.amount ?? 0,
      method: dto.method ?? 'cash',
      receivingAccountId: dto.receivingAccountId,
      reference: dto.reference,
    });

    if (dto.clientUuid) {
      const replay = await this.prisma.consignmentLedgerEntry.findFirst({
        where: { actingCompanyId: me, clientUuid: uuidToBin(dto.clientUuid) },
      });
      if (replay) {
        // Null on rows written before J: those replay as they always did.
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
        outstanding: owed,
      });
    } catch (e) {
      if (e instanceof MoneyRefused) throw new BadRequestException(e.message);
      throw e;
    }

    // Frozen at the moment of movement: renaming an account later must not
    // retitle a payment that already happened.
    const account = dto.receivingAccountId
      ? await this.prisma.receivingAccount.findFirst({
          where: { id: uuidToBin(dto.receivingAccountId), companyId: me },
          select: { label: true },
        })
      : null;

    await this.prisma.consignmentLedgerEntry.create({
      data: {
        id: newUuidV7Bin(),
        consignmentId: c.id,
        sourceCompanyId: c.sourceCompanyId,
        destinationCompanyId: c.destinationCompanyId,
        kind: 'payment_reported',
        amount: dto.amount as number,
        method: dto.method,
        receivingAccountId: dto.receivingAccountId ? uuidToBin(dto.receivingAccountId) : null,
        accountLabelSnapshot: account?.label ?? null,
        reference: dto.reference?.trim() || null,
        /**
         * A reference is not proof. No provider is contacted and nothing is
         * verified — this is a note the two shops can compare, and the UI must
         * never present it as confirmation.
         */
        evidenceRef: dto.evidenceRef?.trim() || null,
        actingCompanyId: me,
        actingUserId: userId,
        entryDate: new Date(`${dayKey(new Date())}T00:00:00.000Z`),
        clientUuid: dto.clientUuid ? uuidToBin(dto.clientUuid) : null,
        clientRequestHash: dto.clientUuid ? fingerprint : null,
      },
    });

    await this.audit.record({
      entityType: 'Consignment',
      entityId: c.id,
      action: 'update',
      after: { paymentReported: dto.amount, method: dto.method },
      branchId: c.sourceBranchId,
    });
    return this.get(id);
  }

  /**
   * Write off part or all of what is owed.
   *
   * Creditor's Owner only, gated on `consignment.forgive` at the route and on
   * `assertSource` here — the permission says who in a company may do it, and
   * the side check says which company.
   *
   * Forgiveness reduces the receivable and is **not cash**. It never touches
   * the till, and it appears as its own component rather than hiding among
   * expenses.
   */
  async forgive(id: string, dto: ForgiveDto) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;

    const c = await this.mine(id);
    assertSource(c, me);

    const rows = await this.ledgerRows(c.id);
    const owed = outstanding(rows);

    try {
      assertForgivenessAllowed({ amount: dto.amount, reason: dto.reason, outstanding: owed });
    } catch (e) {
      if (e instanceof MoneyRefused) throw new BadRequestException(e.message);
      throw e;
    }

    await this.prisma.consignmentLedgerEntry.create({
      data: {
        id: newUuidV7Bin(),
        consignmentId: c.id,
        sourceCompanyId: c.sourceCompanyId,
        destinationCompanyId: c.destinationCompanyId,
        kind: 'forgiven',
        amount: dto.amount,
        reason: dto.reason.trim(),
        actingCompanyId: me,
        actingUserId: userId,
        entryDate: new Date(`${dayKey(new Date())}T00:00:00.000Z`),
      },
    });

    await this.audit.record({
      entityType: 'Consignment',
      entityId: c.id,
      action: 'override',
      after: { forgiven: dto.amount, reason: dto.reason.trim() },
      branchId: c.sourceBranchId,
    });
    await this.settleIfClear(c.id, 'forgiven_settled');
    return this.get(id);
  }

  /**
   * Send an unsold phone back, and accept it.
   *
   * The sequence is deliberate and cannot be short-circuited: the holder
   * initiates, the holder ships, and **the owner confirms physical receipt and
   * condition**. The unit returns to stock only at that last step — a phone
   * marked available while still in transit is one the shop will try to sell
   * twice.
   */
  async returnFlow(id: string, dto: ReturnDto) {
    const me = this.tenant.companyId();
    const userId = this.tenant.userId() ?? null;

    const c = await this.mine(id);
    const side = sideOf(c, me);
    const action: Action =
      dto.action === 'initiate' ? 'initiate_return' : dto.action === 'ship' ? 'ship_return' : 'confirm_return';

    let next: ConsignmentStatus;
    try {
      next = assertTransition({ action, from: c.status as ConsignmentStatus, side });
    } catch (e) {
      if (e instanceof TransitionRefused) throw new ConflictException(e.message);
      throw e;
    }

    if (action === 'confirm_return' && !dto.condition) {
      throw new BadRequestException('Say what condition it came back in');
    }

    await this.prisma.$transaction(async (tx) => {
      const won = await tx.consignment.updateMany({
        where: { id: c.id, version: c.version, status: c.status },
        data: { status: next, version: { increment: 1 } },
      });
      if (won.count === 0) {
        throw new ConflictException('refresh_required: this consignment changed while you were reading it');
      }

      if (action === 'confirm_return') {
        const lines = await tx.consignmentLine.findMany({
          where: { consignmentId: c.id, status: 'in_custody' },
        });
        for (const line of lines) {
          await tx.consignmentLine.update({
            where: { id: line.id },
            data: {
              status: 'returned',
              disposition: dto.condition === 'damaged' ? 'damaged' : 'returned',
              returnCondition: dto.condition,
              returnNote: dto.note?.trim() || null,
              disposedAt: new Date(),
            },
          });
          /**
           * A damaged phone goes to `faulty`, never straight back to sellable.
           * Automatically restocking something that came back broken is how a
           * shop sells a fault it already knew about.
           */
          await tx.unit.updateMany({
            where: { id: line.unitId, status: 'consigned_out' },
            data: { status: dto.condition === 'damaged' ? 'faulty' : 'in_stock' },
          });
        }
      }

      await this.audit.record({
        entityType: 'Consignment',
        entityId: c.id,
        action: 'status_change',
        before: { status: c.status },
        after: { status: next, condition: dto.condition ?? null },
        branchId: c.sourceBranchId,
      });
    });

    return this.get(id);
  }

  /** Every ledger row for a consignment, as the pure module wants them. */
  private async ledgerRows(consignmentId: Buffer) {
    const rows = await this.prisma.consignmentLedgerEntry.findMany({
      where: { consignmentId },
      select: { kind: true, amount: true },
    });
    return rows.map((r) => ({ kind: r.kind as LedgerKind, amount: Number(r.amount) }));
  }

  /**
   * Close the consignment once nothing is owed.
   *
   * Checked rather than assumed: a payment that exactly clears the balance and
   * one that leaves a rounding remainder must not both read as settled.
   */
  private async settleIfClear(consignmentId: Buffer, as: 'settled' | 'forgiven_settled' = 'settled') {
    const owed = outstanding(await this.ledgerRows(consignmentId));
    if (owed > 0) {
      await this.prisma.consignment.updateMany({
        where: { id: consignmentId, status: 'sold_awaiting_settlement' },
        data: { status: 'partially_paid' },
      });
      return;
    }
    await this.prisma.consignment.updateMany({
      where: { id: consignmentId, status: { in: ['sold_awaiting_settlement', 'partially_paid'] } },
      data: { status: as, settledAt: new Date() },
    });
  }

  // --- helpers --------------------------------------------------------------

  /** A consignment I am party to, or a 404. Never a 403 — see `sideOf`. */
  private async mine(id: string) {
    const me = this.tenant.companyId();
    const c = await this.prisma.consignment.findFirst({
      where: { id: uuidToBin(id), ...visibleToCompany(me) },
    });
    if (!c) throw new NotFoundException('No such consignment');
    return c;
  }

  /**
   * Who made the offer currently on the table.
   *
   * A counter-offer belongs to whoever is NOT the original proposer, so the
   * side is derived from the status rather than stored twice and allowed to
   * disagree with it.
   */
  private lastProposalBy(c: { status: string; sourceCompanyId: Buffer; destinationCompanyId: Buffer | null }): Side | null {
    if (c.status === 'requested') return 'source';
    if (c.status === 'counter_proposed') return 'destination';
    return null;
  }

  /** Put every still-reserved phone back into stock. */
  private async releaseUnits(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    consignmentId: Buffer,
  ) {
    const lines = await tx.consignmentLine.findMany({
      where: { consignmentId, status: { in: ['proposed', 'in_custody'] } },
    });
    for (const line of lines) {
      /**
       * Guarded on `consigned_out`, so a unit that has since been sold or moved
       * by another path is never silently dragged back into stock.
       */
      await tx.unit.updateMany({
        where: { id: line.unitId, status: 'consigned_out' },
        data: { status: 'in_stock' },
      });
      await tx.consignmentLine.update({
        where: { id: line.id },
        data: { status: 'cancelled' },
      });
    }
  }

  private summarise(
    c: {
      id: Buffer;
      status: string;
      proposedAmount: unknown;
      counterAmount: unknown;
      agreedAmount: unknown;
      createdAt: Date;
      version: number;
      lines: { id: Buffer }[];
      counterparty: { name: string; kind: string };
      sourceCompany: { name: string };
    },
    side: Side,
  ) {
    return {
      id: binToUuid(c.id),
      status: c.status,
      group: GROUP_OF[c.status as ConsignmentStatus],
      /** Plain wording, so a screen never has to translate an enum itself. */
      statusText: readable(c.status as ConsignmentStatus),
      side,
      /**
       * Each side sees the OTHER party's name. Showing the source its own name
       * as "counterparty" is the kind of small wrongness that makes people
       * distrust the whole screen.
       */
      otherParty: side === 'source' ? c.counterparty.name : c.sourceCompany.name,
      phones: c.lines.length,
      proposedAmount: c.proposedAmount == null ? null : num(c.proposedAmount as number),
      counterAmount: c.counterAmount == null ? null : num(c.counterAmount as number),
      agreedAmount: c.agreedAmount == null ? null : num(c.agreedAmount as number),
      amountIsMutable: amountIsMutable(c.status as ConsignmentStatus),
      createdAt: c.createdAt,
      version: c.version,
    };
  }
}
