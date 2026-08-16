import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { dayKey } from '../common/utils/date.util';
import { assertEntryAllowed, balanceOf, planResolution, RuleViolation } from './debt-rules';
import { ResolveDiscrepancyDto } from './dto/resolve-discrepancy.dto';
import { CreateDebtEntryDto } from './dto/create-debt-entry.dto';

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * What happens after a till does not balance (E-CP2).
 *
 * A discrepancy opens `pending_investigation` and is **never** auto-assigned to
 * anybody. The system observes that the drawer is short; it does not accuse the
 * person who happened to be counting. Only the Owner may decide who is
 * responsible, and every decision carries a mandatory reason and an immutable
 * ledger row.
 */
@Injectable()
export class DiscrepanciesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Discrepancies still waiting on a decision, newest first. */
  async listPending() {
    const branchId = this.tenant.requireBranchId();
    const rows = await this.db.closingDiscrepancy.findMany({
      where: { branchId, status: 'pending_investigation' },
      include: {
        closing: { select: { closingDate: true } },
        channelCount: { select: { channel: true, labelSnapshot: true, expected: true, counted: true } },
      },
      orderBy: { openedAt: 'desc' },
      take: 100,
    });
    return { rows: rows.map((r) => this.shape(r)) };
  }

  async get(id: string) {
    const branchId = this.tenant.requireBranchId();
    const row = await this.db.closingDiscrepancy.findFirst({
      where: { id: uuidToBin(id), branchId },
      include: {
        closing: { select: { closingDate: true } },
        channelCount: { select: { channel: true, labelSnapshot: true, expected: true, counted: true } },
        debtEntries: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('No such discrepancy');
    return {
      ...this.shape(row),
      ledger: row.debtEntries.map((e) => this.shapeEntry(e)),
    };
  }

  /**
   * The Owner's decision. Gated on `debt.manage`, which no Manager holds —
   * deciding that a named person owes the business money is not an operational
   * act, and folding it into `closing.perform` would have made it one.
   */
  async resolve(id: string, dto: ResolveDiscrepancyDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.userId();
    if (!userId) throw new BadRequestException('No authenticated user');

    const found = await this.db.closingDiscrepancy.findFirst({
      where: { id: uuidToBin(id), branchId },
    });
    if (!found) throw new NotFoundException('No such discrepancy');
    if (found.status === 'resolved') {
      throw new ConflictException('That discrepancy has already been resolved');
    }

    let plan: { kind: 'charge' | 'repayment' | 'deduction' | 'forgiveness'; amount: number }[];
    try {
      plan = planResolution({
        resolution: dto.resolution,
        reason: dto.reason,
        responsibleUserId: dto.responsibleUserId ?? null,
        amount: num(found.amount),
      });
    } catch (e) {
      if (e instanceof RuleViolation) throw new BadRequestException(e.message);
      throw e;
    }

    const responsible = dto.responsibleUserId ? uuidToBin(dto.responsibleUserId) : null;
    if (responsible) {
      // The person must actually work here. Naming somebody outside the company
      // would create a ledger nobody can ever settle.
      const exists = await this.db.user.findFirst({ where: { id: responsible }, select: { id: true } });
      if (!exists) throw new BadRequestException('That person is not part of this shop');
    }

    const now = new Date();
    await this.db.$transaction(async (tx) => {
      /**
       * Guarded on the version AND on still being pending, so two owners
       * deciding one shortage produce one resolution and one 409 — never two
       * charges against the same person for the same day.
       */
      const won = await tx.closingDiscrepancy.updateMany({
        where: { id: found.id, version: found.version, status: 'pending_investigation' },
        data: {
          status: 'resolved',
          resolution: dto.resolution,
          responsibleUserId: responsible,
          resolutionReason: dto.reason.trim(),
          resolvedById: userId,
          resolvedAt: now,
          version: { increment: 1 },
        },
      });
      if (won.count === 0) {
        throw new ConflictException('refresh_required: this discrepancy was decided while you were deciding it');
      }

      for (const row of plan) {
        await tx.employeeDebtEntry.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            branchId,
            userId: responsible as Buffer,
            discrepancyId: found.id,
            kind: row.kind,
            amount: row.amount,
            reason: dto.reason.trim(),
            entryDate: new Date(`${dayKey(now)}T00:00:00.000Z`),
            createdById: userId,
          },
        });
      }

      await this.audit.recordTx(tx, {
        entityType: 'ClosingDiscrepancy',
        entityId: found.id,
        action: 'update',
        before: { status: 'pending_investigation' },
        after: {
          status: 'resolved',
          resolution: dto.resolution,
          responsible: dto.responsibleUserId ?? null,
          amount: num(found.amount),
          ledgerRows: plan.length,
        },
        branchId,
      });
    });

    if (responsible && plan.some((p) => p.kind === 'charge')) {
      await this.notifications.emit({
        type: 'debt.charged',
        title: 'A shortage was assigned',
        body: `${round2(Math.abs(num(found.amount)))} recorded against a team member`,
        branchId,
      });
    }
    return this.get(id);
  }

  /**
   * One person's ledger and what they owe.
   *
   * The balance is computed from the rows every time. A stored balance can
   * disagree with its own history; a derived one cannot.
   */
  async ledgerFor(userId: string) {
    const target = uuidToBin(userId);
    const person = await this.db.user.findFirst({ where: { id: target }, select: { id: true, name: true } });
    if (!person) throw new NotFoundException('No such person');

    const entries = await this.db.employeeDebtEntry.findMany({
      where: { userId: target },
      orderBy: { createdAt: 'asc' },
    });
    return {
      userId: binToUuid(person.id),
      name: person.name,
      outstanding: balanceOf(entries.map((e) => ({ kind: e.kind, amount: num(e.amount) }))),
      entries: entries.map((e) => this.shapeEntry(e)),
    };
  }

  /**
   * What the signed-in person owes.
   *
   * Deliberately ungated: somebody being asked to repay money should never have
   * to ask permission to see the record of it. It reads only their own rows.
   */
  async myLedger() {
    const userId = this.tenant.userId();
    if (!userId) throw new BadRequestException('No authenticated user');
    return this.ledgerFor(binToUuid(userId));
  }

  /** A repayment, a payroll deduction, or a write-off. Owner only. */
  async addEntry(dto: CreateDebtEntryDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const actorId = this.tenant.userId();
    if (!actorId) throw new BadRequestException('No authenticated user');

    const current = await this.ledgerFor(dto.userId);
    try {
      assertEntryAllowed({
        kind: dto.kind,
        amount: dto.amount,
        reason: dto.reason,
        method: dto.method ?? null,
        outstanding: current.outstanding,
      });
    } catch (e) {
      if (e instanceof RuleViolation) throw new BadRequestException(e.message);
      throw e;
    }

    const clientUuid = dto.clientUuid ? uuidToBin(dto.clientUuid) : null;
    if (clientUuid) {
      // An offline retry must not charge or credit somebody twice.
      const replay = await this.db.employeeDebtEntry.findFirst({ where: { clientUuid } });
      if (replay) return this.ledgerFor(dto.userId);
    }

    const entryId = newUuidV7Bin();
    await this.db.employeeDebtEntry.create({
      data: {
        id: entryId,
        companyId,
        branchId,
        userId: uuidToBin(dto.userId),
        kind: dto.kind,
        amount: dto.amount,
        reason: dto.reason.trim(),
        method: dto.method ?? null,
        reference: dto.reference ?? null,
        entryDate: new Date(`${dto.entryDate ?? dayKey(new Date())}T00:00:00.000Z`),
        createdById: actorId,
        clientUuid,
      },
    });

    await this.audit.record({
      entityType: 'EmployeeDebtEntry',
      entityId: entryId,
      action: 'create',
      after: { kind: dto.kind, amount: dto.amount, subject: dto.userId, method: dto.method ?? null },
      branchId,
    });
    return this.ledgerFor(dto.userId);
  }

  // --- shaping --------------------------------------------------------------

  private shape(r: {
    id: Buffer;
    amount: Prisma.Decimal;
    status: string;
    resolution: string | null;
    responsibleUserId: Buffer | null;
    resolutionReason: string | null;
    openedAt: Date;
    resolvedAt: Date | null;
    version: number;
    closing: { closingDate: Date };
    channelCount: { channel: string; labelSnapshot: string; expected: Prisma.Decimal; counted: Prisma.Decimal | null } | null;
  }) {
    return {
      id: binToUuid(r.id),
      date: dayKey(r.closing.closingDate),
      amount: round2(num(r.amount)),
      /** Which way it went, in words as well as a sign (never colour alone). */
      kind: num(r.amount) < 0 ? ('shortage' as const) : ('surplus' as const),
      channel: r.channelCount
        ? {
            channel: r.channelCount.channel,
            label: r.channelCount.labelSnapshot,
            expected: round2(num(r.channelCount.expected)),
            counted: r.channelCount.counted == null ? null : round2(num(r.channelCount.counted)),
          }
        : null,
      status: r.status,
      resolution: r.resolution,
      responsibleUserId: r.responsibleUserId ? binToUuid(r.responsibleUserId) : null,
      reason: r.resolutionReason,
      openedAt: r.openedAt,
      resolvedAt: r.resolvedAt,
      version: r.version,
    };
  }

  private shapeEntry(e: {
    id: Buffer;
    kind: string;
    amount: Prisma.Decimal;
    reason: string;
    method: string | null;
    reference: string | null;
    entryDate: Date;
    createdAt: Date;
  }) {
    return {
      id: binToUuid(e.id),
      kind: e.kind,
      amount: round2(num(e.amount)),
      reason: e.reason,
      method: e.method,
      reference: e.reference,
      date: dayKey(e.entryDate),
      createdAt: e.createdAt,
    };
  }
}
