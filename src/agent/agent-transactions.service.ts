import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { isDateString } from '../common/business-day';
import { BusinessDayService, dateKey, dateValue } from '../common/business-day/business-day.service';
import { ClosingService } from '../closing/closing.service';
import { requireAgentActivity } from './agent-access';
import { configInForce, configView } from './agent-providers.service';
import {
  commissionOf,
  customerNumberFor,
  exchangeFingerprint,
  exchangeLegs,
  maskedCustomerNumber,
  mistakeFingerprint,
  missingConfigFields,
  rateFor,
  rebalancingFingerprint,
  rebalancingLegs,
  reversalLegs,
  type Leg,
} from './agent-rules';
import { CreateAgentTransactionDto, ListAgentTransactionsDto, ReverseAgentTransactionDto } from './dto/transaction.dto';
import { DismissAgentMistakeDto, ListAgentMistakesDto, ReportAgentMistakeDto } from './dto/mistake.dto';
import { CreateAgentRebalancingDto, ListAgentRebalancingsDto } from './dto/rebalancing.dto';

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));

const legSelect = { accountKind: true, providerId: true, direction: true, amount: true, kind: true } satisfies Prisma.AgentMovementSelect;
const mistakeSelect = { id: true, transactionId: true, kind: true, status: true, note: true, reportedByName: true, reportedAt: true, decidedByName: true, decidedAt: true, decisionNote: true } satisfies Prisma.AgentMistakeReportSelect;

/** The list and the detail read the same row — the detail alone adds the number itself (docs/73 §4.6). */
const listSelect = {
  id: true,
  branchId: true,
  providerId: true,
  provider: { select: { label: true } },
  direction: true,
  amount: true,
  customerNumberLast4: true,
  providerReference: true,
  commissionAmount: true,
  commissionRateBp: true,
  configVersionId: true,
  configSnapshot: true,
  businessDate: true,
  recordedAt: true,
  deviceRecordedAt: true,
  recordedById: true,
  recordedByName: true,
  status: true,
  reversedAt: true,
  reversedByName: true,
  reversalReason: true,
  movements: { select: legSelect, orderBy: { createdAt: 'asc' } },
  mistakeReports: { select: mistakeSelect, orderBy: { reportedAt: 'asc' } },
} satisfies Prisma.AgentTransactionSelect;
/** Only `agent.customer.reveal` on the detail route reads this column; nothing else ever selects it. */
const detailSelect = { ...listSelect, customerNumber: true } satisfies Prisma.AgentTransactionSelect;

type TransactionRow = Prisma.AgentTransactionGetPayload<{ select: typeof listSelect }> & { customerNumber?: string };
type MistakeRow = Prisma.AgentMistakeReportGetPayload<{ select: typeof mistakeSelect }>;

const legView = (l: Prisma.AgentMovementGetPayload<{ select: typeof legSelect }>) => ({
  account: l.accountKind,
  providerId: l.providerId ? binToUuid(l.providerId) : null,
  direction: l.direction,
  amount: num(l.amount),
  kind: l.kind,
});

const mistakeView = (m: MistakeRow) => ({
  id: binToUuid(m.id),
  transactionId: binToUuid(m.transactionId),
  kind: m.kind,
  status: m.status,
  note: m.note,
  reportedByName: m.reportedByName,
  reportedAt: m.reportedAt.toISOString(),
  decidedByName: m.decidedByName,
  decidedAt: m.decidedAt?.toISOString() ?? null,
  decisionNote: m.decisionNote,
});

/**
 * An exchange as the phone reads it: masked everywhere; the number itself only
 * when the detail route reads it for somebody holding `agent.customer.reveal`.
 */
export function toTransactionView(row: TransactionRow, reveal: boolean) {
  const snapshot = (row.configSnapshot ?? {}) as { commissionDestination?: string | null; principalFeeMode?: string | null };
  return {
    id: binToUuid(row.id),
    branchId: binToUuid(row.branchId),
    providerId: binToUuid(row.providerId),
    providerLabel: row.provider.label,
    direction: row.direction,
    amount: num(row.amount),
    customerNumberMasked: maskedCustomerNumber(row.customerNumberLast4),
    ...(reveal && row.customerNumber !== undefined ? { customerNumber: row.customerNumber } : {}),
    providerReference: row.providerReference,
    commission: {
      amount: num(row.commissionAmount),
      rateBp: row.commissionRateBp,
      destination: snapshot.commissionDestination ?? null,
      principalFeeMode: snapshot.principalFeeMode ?? null,
      configVersionId: binToUuid(row.configVersionId),
    },
    legs: row.movements.map(legView),
    businessDate: dateKey(row.businessDate),
    recordedAt: row.recordedAt.toISOString(),
    deviceRecordedAt: row.deviceRecordedAt?.toISOString() ?? null,
    recordedBy: { id: binToUuid(row.recordedById), name: row.recordedByName },
    status: row.status,
    reversal: row.status === 'reversed' ? { at: row.reversedAt?.toISOString() ?? null, byName: row.reversedByName, reason: row.reversalReason } : null,
    mistakes: row.mistakeReports.map((m) => ({ id: binToUuid(m.id), kind: m.kind, status: m.status, note: m.note, reportedByName: m.reportedByName, reportedAt: m.reportedAt.toISOString() })),
  };
}

/** The provider's reference per its rule (docs/73 §4.6): demanded, kept, or left aside. */
export function referenceFor(rule: 'required' | 'optional' | 'none', raw: string | null | undefined, label: string): string | null {
  const reference = raw?.trim() || null;
  if (rule === 'none') return null;
  if (rule === 'required' && !reference) {
    throw new BadRequestException({ code: 'reference_required', message: `${label} issues a reference for every exchange: enter it before confirming.` });
  }
  return reference;
}

/**
 * The counter's exchanges (A5–A8, docs/73 §4): recorded once under the phone's
 * key with the actor from the session, reversed exactly once by the Owner or a
 * Manager, questioned by an Employee's mistake report, and rebalanced apart.
 * Every money figure is a leg in `agent_movements`; nothing completed is edited
 * or deleted.
 */
@Injectable()
export class AgentTransactionsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly businessDay: BusinessDayService,
    private readonly closing: ClosingService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  // ── Recording ───────────────────────────────────────────────────────────

  /**
   * Record an exchange. In order: the body (the pipe, then the customer number),
   * the branch's activity, the open-first rule, the provider and its version in
   * force, then the write — the legs with the transaction, in one transaction,
   * under the day's lock. A key already used answers with what it recorded,
   * before any of that (D155: the same UUID is the same exchange, whatever the
   * day has become since), or refuses a different payload under it.
   */
  async record(dto: CreateAgentTransactionDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.requireUserId();
    const customer = customerNumberFor(dto.customerNumber);
    const clientUuid = uuidToBin(dto.clientUuid);
    const hash = exchangeFingerprint({
      providerId: dto.providerId,
      direction: dto.direction,
      amount: dto.amount,
      customerNumber: customer.value,
      providerReference: dto.providerReference,
      configVersionId: dto.configVersionId,
      deviceRecordedAt: dto.deviceRecordedAt,
    });
    const replay = await this.replayTransaction(clientUuid, hash);
    if (replay) return replay;
    await requireAgentActivity(this.db, branchId);
    await this.closing.assertCounterOpen(branchId, 'agent_exchange');

    const providerId = uuidToBin(dto.providerId);
    const id = newUuidV7Bin();
    try {
      await this.db.$transaction(async (tx) => {
        // The provider row, locked: a configuration version being added, or a position being set, waits for this exchange.
        const [provider] = await tx.$queryRaw<{ id: Buffer; label: string; is_active: unknown }[]>(Prisma.sql`
          SELECT id, label, is_active FROM agent_providers WHERE id = ${providerId} AND company_id = ${companyId} FOR UPDATE`);
        if (!provider) throw new NotFoundException({ code: 'provider_not_found', message: 'That provider does not exist' });
        if (Number(provider.is_active) !== 1) {
          throw new BadRequestException({ code: 'provider_inactive', message: `${provider.label} is switched off: nothing was exchanged with it.` });
        }
        const recordedAt = new Date();
        const config = await configInForce(tx, provider.id, recordedAt);
        const missing = missingConfigFields(config);
        if (!config || missing.length > 0) {
          throw new ConflictException({
            code: 'provider_not_configured',
            message: `${provider.label} is not set up yet: its rate and settlement must be configured before an exchange is recorded. Nothing was recorded.`,
            missing,
          });
        }
        if (dto.configVersionId && !uuidToBin(dto.configVersionId).equals(config.id)) {
          throw new ConflictException({
            code: 'stale_configuration',
            message: `${provider.label}'s configuration changed since this exchange was prepared. Review the rate in force before sending it again.`,
            expectedConfigVersionId: dto.configVersionId,
            currentConfigVersionId: binToUuid(config.id),
          });
        }
        const reference = referenceFor(config.referenceRule as 'required' | 'optional' | 'none', dto.providerReference, provider.label);
        const rateBp = rateFor(dto.direction, config) as number;
        const commission = commissionOf(dto.amount, rateBp);
        const legs = exchangeLegs({
          direction: dto.direction,
          amount: dto.amount,
          commission,
          providerId: dto.providerId,
          commissionDestination: config.commissionDestination as 'cash' | 'provider_float' | 'held_separately',
          principalFeeMode: config.principalFeeMode as 'separate' | 'deducted',
        });
        // The business day from the posting instant (D155), decided inside the transaction, then the day's lock.
        const businessDate = await this.businessDay.assign(branchId, recordedAt, tx as unknown as Prisma.TransactionClient);
        await this.closing.assertCounterOpenTx(tx, { branchId, businessDate, operation: 'agent_exchange' });
        const actor = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
        await tx.agentTransaction.create({
          data: {
            id,
            companyId,
            branchId,
            providerId,
            direction: dto.direction,
            amount: dto.amount,
            customerNumber: customer.value,
            customerNumberLast4: customer.last4,
            providerReference: reference,
            commissionAmount: commission,
            commissionRateBp: rateBp,
            configVersionId: config.id,
            configSnapshot: configView(config) as unknown as Prisma.InputJsonValue,
            businessDate: dateValue(businessDate),
            recordedAt,
            deviceRecordedAt: dto.deviceRecordedAt ? new Date(dto.deviceRecordedAt) : null,
            recordedById: userId,
            recordedByName: actor?.name ?? '',
            clientUuid,
            clientRequestHash: hash,
            status: 'completed',
          },
        });
        await this.writeLegs(tx, { branchId, legs, businessDate, recordedAt, transactionId: id });
        await this.audit.recordTx(tx, {
          entityType: 'AgentTransaction',
          entityId: id,
          action: 'create',
          after: {
            providerId: dto.providerId,
            label: provider.label,
            direction: dto.direction,
            amount: dto.amount,
            commission,
            rateBp,
            configVersionId: binToUuid(config.id),
            businessDate,
            legs: legs.map((l) => [l.account, l.direction, l.amount, l.kind]),
          },
          branchId,
        });
      });
    } catch (e) {
      // Two identical retries raced: the loser answers with the winner's record, or refuses a different payload.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.replayTransaction(clientUuid, hash);
        if (winner) return winner;
      }
      throw e;
    }
    return this.viewOf(id, false);
  }

  private async replayTransaction(clientUuid: Buffer, hash: string) {
    const prior = await this.db.agentTransaction.findFirst({ where: { clientUuid }, select: { id: true, clientRequestHash: true } });
    if (!prior) return null;
    if (prior.clientRequestHash !== hash) {
      throw new ConflictException({ code: 'idempotency_conflict', message: 'That request id already recorded a different exchange. Refresh and record it again with a new key.' });
    }
    return this.viewOf(prior.id, false);
  }

  /** The legs of an exchange, a reversal or a rebalancing: append-only, dated and timed with their source. */
  private async writeLegs(
    tx: Pick<TenantPrisma, 'agentMovement'>,
    args: { branchId: Buffer; legs: Leg[]; businessDate: string; recordedAt: Date; transactionId?: Buffer; rebalancingId?: Buffer },
  ): Promise<void> {
    const companyId = this.tenant.companyId();
    await tx.agentMovement.createMany({
      data: args.legs.map((leg) => ({
        id: newUuidV7Bin(),
        companyId,
        branchId: args.branchId,
        accountKind: leg.account,
        providerId: leg.providerId ? uuidToBin(leg.providerId) : null,
        direction: leg.direction,
        amount: leg.amount,
        kind: leg.kind,
        transactionId: args.transactionId ?? null,
        rebalancingId: args.rebalancingId ?? null,
        businessDate: dateValue(args.businessDate),
        recordedAt: args.recordedAt,
      })),
    });
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  /** The branch's exchanges, newest first, masked; every filter in SQL. */
  async list(query: ListAgentTransactionsDto) {
    const branchId = this.tenant.requireBranchId();
    for (const d of [query.from, query.to]) if (d !== undefined && !isDateString(d)) throw new BadRequestException('from and to must be YYYY-MM-DD');
    if (query.from && query.to && query.from > query.to) throw new BadRequestException('from must be on or before to');
    const limit = query.limit ?? 20;
    const rows = await this.db.agentTransaction.findMany({
      where: {
        branchId,
        ...(query.from || query.to ? { businessDate: { ...(query.from ? { gte: dateValue(query.from) } : {}), ...(query.to ? { lte: dateValue(query.to) } : {}) } } : {}),
        ...(query.providerId ? { providerId: uuidToBin(query.providerId) } : {}),
        ...(query.direction ? { direction: query.direction } : {}),
        ...(query.recordedById ? { recordedById: uuidToBin(query.recordedById) } : {}),
        ...(query.last4 ? { customerNumberLast4: query.last4 } : {}),
        ...(query.reference ? { providerReference: query.reference.trim() } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      select: listSelect,
      // A UUIDv7 key is time-ordered: keyset paging on it is "newest first" and a total order, as the sales list pages.
      ...(query.cursor ? { cursor: { id: uuidToBin(query.cursor) }, skip: 1 } : {}),
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return { rows: page.map((r) => toTransactionView(r, false)), nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null };
  }

  /** One exchange; the number itself only for `agent.customer.reveal`. */
  async detail(id: string) {
    const reveal = this.cls.get('permissions')?.has('agent.customer.reveal') ?? false;
    return this.viewOf(uuidToBin(id), reveal);
  }

  private async viewOf(id: Buffer, reveal: boolean) {
    const branchId = this.tenant.requireBranchId();
    const row = await this.db.agentTransaction.findFirst({ where: { id, branchId }, select: reveal ? detailSelect : listSelect });
    if (!row) throw new NotFoundException({ code: 'transaction_not_found', message: 'No such exchange at this branch' });
    return toTransactionView(row, reveal);
  }

  // ── Reversal ────────────────────────────────────────────────────────────

  /**
   * Reverse an exchange exactly once (A7): one counter-leg per leg, on the day
   * of the reversal; the status, who, when and why on the row; the original
   * legs untouched; its open mistake reports closed as reversed; one audit entry.
   */
  async reverse(id: string, dto: ReverseAgentTransactionDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.requireUserId();
    const transactionId = uuidToBin(id);
    const clientUuid = uuidToBin(dto.clientUuid);
    await requireAgentActivity(this.db, branchId);
    const found = await this.db.agentTransaction.findFirst({ where: { id: transactionId, branchId }, select: { id: true, status: true, reversalClientUuid: true } });
    if (!found) throw new NotFoundException({ code: 'transaction_not_found', message: 'No such exchange at this branch' });
    if (found.status === 'reversed') return this.reversedAnswer(found, clientUuid);

    await this.db.$transaction(async (tx) => {
      // The row, locked: two people reversing one exchange produce one reversal and one 409.
      const [locked] = await tx.$queryRaw<{ status: string; reversal_client_uuid: Buffer | null }[]>(Prisma.sql`
        SELECT status, reversal_client_uuid FROM agent_transactions WHERE id = ${transactionId} AND company_id = ${companyId} FOR UPDATE`);
      if (!locked) throw new NotFoundException({ code: 'transaction_not_found', message: 'No such exchange at this branch' });
      if (locked.status === 'reversed') throw alreadyReversed();
      const original = await tx.agentMovement.findMany({ where: { transactionId, kind: { in: ['principal', 'commission'] } }, select: legSelect, orderBy: { createdAt: 'asc' } });
      const now = new Date();
      const businessDate = await this.businessDay.assign(branchId, now, tx as unknown as Prisma.TransactionClient);
      const actor = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
      const legs = reversalLegs(original.map((l) => ({ account: l.accountKind, providerId: l.providerId ? binToUuid(l.providerId) : null, direction: l.direction, amount: num(l.amount) })));
      await this.writeLegs(tx, { branchId, legs, businessDate, recordedAt: now, transactionId });
      const won = await tx.agentTransaction.updateMany({
        where: { id: transactionId, status: 'completed' },
        data: { status: 'reversed', reversedById: userId, reversedByName: actor?.name ?? '', reversedAt: now, reversalReason: dto.reason.trim(), reversalClientUuid: clientUuid },
      });
      if (won.count === 0) throw new ConflictException({ code: 'already_reversed', message: 'That exchange was reversed a moment ago.' });
      await tx.agentMistakeReport.updateMany({
        where: { transactionId, status: 'open' },
        data: { status: 'reversed', decidedById: userId, decidedByName: actor?.name ?? '', decidedAt: now },
      });
      await this.audit.recordTx(tx, {
        entityType: 'AgentTransaction',
        entityId: transactionId,
        action: 'status_change',
        reason: dto.reason.trim().slice(0, 255),
        before: { status: 'completed' },
        after: { status: 'reversed', businessDate, legs: legs.map((l) => [l.account, l.direction, l.amount, l.kind]) },
        branchId,
      });
    });
    return this.viewOf(transactionId, false);
  }

  /** A reversal already made: the same key answers with it (a retry); another key is a second reversal, refused. */
  private async reversedAnswer(found: { id: Buffer; reversalClientUuid: Buffer | null }, clientUuid: Buffer) {
    if (found.reversalClientUuid?.equals(clientUuid)) return this.viewOf(found.id, false);
    throw alreadyReversed();
  }

  // ── Mistake reports ─────────────────────────────────────────────────────

  /** An Employee's claim about an exchange: recorded, never acted on by itself. */
  async reportMistake(id: string, dto: ReportAgentMistakeDto) {
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.requireUserId();
    const transactionId = uuidToBin(id);
    const clientUuid = uuidToBin(dto.clientUuid);
    const hash = mistakeFingerprint({ transactionId: id, kind: dto.kind, note: dto.note });
    const replay = await this.replayMistake(clientUuid, hash);
    if (replay) return replay;
    await requireAgentActivity(this.db, branchId);
    const found = await this.db.agentTransaction.findFirst({ where: { id: transactionId, branchId }, select: { id: true, status: true } });
    if (!found) throw new NotFoundException({ code: 'transaction_not_found', message: 'No such exchange at this branch' });
    if (found.status === 'reversed') throw new ConflictException({ code: 'already_reversed', message: 'That exchange was already reversed; there is nothing left to report.' });
    const actor = await this.db.user.findFirst({ where: { id: userId }, select: { name: true } });
    const mistakeId = newUuidV7Bin();
    try {
      await this.db.agentMistakeReport.create({
        data: {
          id: mistakeId,
          companyId: this.tenant.companyId(),
          branchId,
          transactionId,
          kind: dto.kind,
          note: dto.note?.trim() || null,
          status: 'open',
          reportedById: userId,
          reportedByName: actor?.name ?? '',
          reportedAt: new Date(),
          clientUuid,
          clientRequestHash: hash,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.replayMistake(clientUuid, hash);
        if (winner) return winner;
      }
      throw e;
    }
    await this.audit.record({ entityType: 'AgentMistakeReport', entityId: mistakeId, action: 'create', after: { transactionId: id, kind: dto.kind }, branchId });
    return this.mistakeOf(mistakeId);
  }

  private async replayMistake(clientUuid: Buffer, hash: string) {
    const prior = await this.db.agentMistakeReport.findFirst({ where: { clientUuid }, select: { id: true, clientRequestHash: true } });
    if (!prior) return null;
    if (prior.clientRequestHash !== hash) throw new ConflictException({ code: 'idempotency_conflict', message: 'That request id already made a different report.' });
    return this.mistakeOf(prior.id);
  }

  async listMistakes(query: ListAgentMistakesDto) {
    const branchId = this.tenant.requireBranchId();
    const rows = await this.db.agentMistakeReport.findMany({ where: { branchId, ...(query.status ? { status: query.status } : {}) }, select: mistakeSelect, orderBy: { reportedAt: 'desc' }, take: 200 });
    return { rows: rows.map(mistakeView) };
  }

  /** The Owner's or a Manager's decision that the exchange stands. */
  async dismissMistake(id: string, dto: DismissAgentMistakeDto) {
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.requireUserId();
    const mistakeId = uuidToBin(id);
    await requireAgentActivity(this.db, branchId);
    const found = await this.db.agentMistakeReport.findFirst({ where: { id: mistakeId, branchId }, select: { id: true, status: true } });
    if (!found) throw new NotFoundException({ code: 'mistake_not_found', message: 'No such report at this branch' });
    if (found.status !== 'open') throw new ConflictException({ code: 'mistake_decided', message: 'That report was already decided.' });
    const actor = await this.db.user.findFirst({ where: { id: userId }, select: { name: true } });
    const now = new Date();
    const won = await this.db.agentMistakeReport.updateMany({
      where: { id: mistakeId, status: 'open' },
      data: { status: 'dismissed', decidedById: userId, decidedByName: actor?.name ?? '', decidedAt: now, decisionNote: dto.note?.trim() || null },
    });
    if (won.count === 0) throw new ConflictException({ code: 'mistake_decided', message: 'That report was decided a moment ago.' });
    await this.audit.record({ entityType: 'AgentMistakeReport', entityId: mistakeId, action: 'status_change', before: { status: 'open' }, after: { status: 'dismissed', note: dto.note?.trim() || null }, branchId });
    return this.mistakeOf(mistakeId);
  }

  private async mistakeOf(id: Buffer) {
    const row = await this.db.agentMistakeReport.findFirstOrThrow({ where: { id }, select: mistakeSelect });
    return { mistake: mistakeView(row) };
  }

  // ── Rebalancing ─────────────────────────────────────────────────────────

  /** Money moved between the branch's own accounts, or with the outside (A8). Never a transaction. */
  async rebalance(dto: CreateAgentRebalancingDto) {
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.requireUserId();
    const clientUuid = uuidToBin(dto.clientUuid);
    const hash = rebalancingFingerprint(dto);
    const replay = await this.replayRebalancing(clientUuid, hash);
    if (replay) return replay;
    await requireAgentActivity(this.db, branchId);
    const verdict = rebalancingLegs(dto);
    if (!verdict.ok) throw new BadRequestException({ code: verdict.code, message: verdict.message });
    const providerIds = [...new Set(verdict.legs.map((l) => l.providerId).filter((p): p is string => p !== null))];
    if (providerIds.length > 0) {
      const known = await this.db.agentProvider.findMany({ where: { id: { in: providerIds.map(uuidToBin) } }, select: { id: true } });
      if (known.length !== providerIds.length) throw new NotFoundException({ code: 'provider_not_found', message: 'A provider named in the legs does not exist' });
    }
    const id = newUuidV7Bin();
    try {
      await this.db.$transaction(async (tx) => {
        const now = new Date();
        const businessDate = await this.businessDay.assign(branchId, now, tx as unknown as Prisma.TransactionClient);
        const actor = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
        await tx.agentRebalancing.create({
          data: {
            id,
            companyId: this.tenant.companyId(),
            branchId,
            reason: dto.reason.trim(),
            note: dto.note?.trim() || null,
            externalCounterparty: dto.externalCounterparty ?? null,
            externalAmount: dto.externalCounterparty ? verdict.net : null,
            businessDate: dateValue(businessDate),
            recordedAt: now,
            recordedById: userId,
            recordedByName: actor?.name ?? '',
            clientUuid,
            clientRequestHash: hash,
          },
        });
        await this.writeLegs(tx, { branchId, legs: verdict.legs, businessDate, recordedAt: now, rebalancingId: id });
        await this.audit.recordTx(tx, {
          entityType: 'AgentRebalancing',
          entityId: id,
          action: 'create',
          reason: dto.reason.trim().slice(0, 255),
          after: { businessDate, externalCounterparty: dto.externalCounterparty ?? null, externalAmount: dto.externalCounterparty ? verdict.net : null, legs: verdict.legs.map((l) => [l.account, l.providerId, l.direction, l.amount]) },
          branchId,
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.replayRebalancing(clientUuid, hash);
        if (winner) return winner;
      }
      throw e;
    }
    return this.rebalancingOf(id);
  }

  private async replayRebalancing(clientUuid: Buffer, hash: string) {
    const prior = await this.db.agentRebalancing.findFirst({ where: { clientUuid }, select: { id: true, clientRequestHash: true } });
    if (!prior) return null;
    if (prior.clientRequestHash !== hash) throw new ConflictException({ code: 'idempotency_conflict', message: 'That request id already recorded a different rebalancing.' });
    return this.rebalancingOf(prior.id);
  }

  async listRebalancings(query: ListAgentRebalancingsDto) {
    const branchId = this.tenant.requireBranchId();
    const today = await this.businessDay.today(branchId);
    const from = query.from ?? today;
    const to = query.to ?? from;
    if (!isDateString(from) || !isDateString(to) || from > to) throw new BadRequestException('from and to must be YYYY-MM-DD, with from on or before to');
    const rows = await this.db.agentRebalancing.findMany({
      where: { branchId, businessDate: { gte: dateValue(from), lte: dateValue(to) } },
      select: rebalancingSelect,
      orderBy: { id: 'desc' },
      take: 200,
    });
    return { from, to, rows: rows.map(rebalancingView) };
  }

  private async rebalancingOf(id: Buffer) {
    const row = await this.db.agentRebalancing.findFirstOrThrow({ where: { id }, select: rebalancingSelect });
    return { rebalancing: rebalancingView(row) };
  }
}

const rebalancingSelect = {
  id: true,
  reason: true,
  note: true,
  externalCounterparty: true,
  externalAmount: true,
  businessDate: true,
  recordedAt: true,
  recordedById: true,
  recordedByName: true,
  legs: { select: legSelect, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.AgentRebalancingSelect;

function rebalancingView(row: Prisma.AgentRebalancingGetPayload<{ select: typeof rebalancingSelect }>) {
  return {
    id: binToUuid(row.id),
    reason: row.reason,
    note: row.note,
    legs: row.legs.map(legView),
    externalCounterparty: row.externalCounterparty,
    externalAmount: row.externalAmount == null ? null : num(row.externalAmount),
    businessDate: dateKey(row.businessDate),
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: { id: binToUuid(row.recordedById), name: row.recordedByName },
  };
}

const alreadyReversed = () => new ConflictException({ code: 'already_reversed', message: 'That exchange was already reversed; a reversal happens once.' });
