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
import { CreateConsignmentDto, DecideConsignmentDto, CustodyDto } from './dto/consignment.dto';

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
     * A blocked relationship stops NEW business. It deliberately does not touch
     * anything already outstanding — blocking is not a way to escape a debt.
     */
    if (counterparty.connection?.status === 'blocked') {
      throw new ConflictException('That store is blocked');
    }
    if (counterparty.kind === 'connected_store' && counterparty.connection?.status !== 'accepted') {
      throw new ConflictException('You are not connected to that store yet');
    }

    const consignmentId = newUuidV7Bin();
    const created = await this.prisma.$transaction(async (tx) => {
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
