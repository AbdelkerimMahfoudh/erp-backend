import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { BusinessDayService, dateKey, dateValue } from '../common/business-day/business-day.service';
import { ClosingService } from '../closing/closing.service';
import { requireAgentActivity } from './agent-access';
import { configInForce } from './agent-providers.service';
import { assertFloatAmount, floatPosition, positionFingerprint } from './agent-rules';
import { accountsWithMoney, floatKey, readFloat, readFloatInputs, type FloatAccountKind, type FloatProvider, type FloatView } from './float-positions';
import { SetAgentPositionDto } from './dto/position.dto';

const num = (d: Prisma.Decimal | number | null): number => (d == null ? 0 : Number(d));
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const providerSelect = { id: true, kind: true, label: true, isActive: true, sortOrder: true } satisfies Prisma.AgentProviderSelect;
const toFloatProvider = (p: Prisma.AgentProviderGetPayload<{ select: typeof providerSelect }>): FloatProvider => ({ id: binToUuid(p.id), label: p.label, kind: p.kind, isActive: p.isActive });

/** A position as it is read back: what was set, what the app tracked just before, and the difference. */
const positionSelect = {
  id: true,
  providerId: true,
  accountKind: true,
  amount: true,
  at: true,
  businessDate: true,
  source: true,
  trackedBefore: true,
  difference: true,
  note: true,
  recordedByName: true,
} satisfies Prisma.AgentPositionSelect;

/**
 * The money of an agent branch (docs/73 §4.4–4.5): the drawer exactly as Money's
 * card reads it — the closing's own figure, never recomputed here — and each
 * provider's float and held commission from their anchors and legs. The Owner
 * sets a float's position (`agent.position.set`) the way an account is
 * anchored: append-only, with what the app tracked just before and the
 * difference kept beside it.
 */
@Injectable()
export class AgentPositionsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly businessDay: BusinessDayService,
    private readonly closing: ClosingService,
  ) {}

  /**
   * Every position at this branch now, and their total when all are known.
   *
   * A read, so never refused for the branch's activity (D156): a branch moved
   * from `both` to `electronics` keeps seeing the floats it still holds — the
   * money did not vanish with the subscription. Setting one is a write and is
   * refused below.
   */
  async view() {
    const branchId = this.tenant.requireBranchId();
    const businessDate = await this.businessDay.today(branchId);
    const asOf = new Date();
    const [cash, providers, withMoney] = await Promise.all([
      this.closing.drawerMethod(),
      this.db.agentProvider.findMany({ select: providerSelect, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] }),
      accountsWithMoney(this.db, branchId),
    ]);
    const configs = await Promise.all(providers.map((p) => configInForce(this.db, p.id, asOf)));
    const listed = (kind: FloatAccountKind, keep: (p: FloatProvider, i: number) => boolean) =>
      Promise.all(providers.map(toFloatProvider).filter((p, i) => keep(p, i) || withMoney.has(floatKey(kind, p.id))).map((p) => readFloat(this.db, p, kind, { branchId, businessDate })));
    const [floats, commissionHeld] = await Promise.all([
      // Every active provider; an inactive one only with a position or a movement.
      listed('provider', (p) => p.isActive),
      // The providers whose commission is held for the agent, and any account that ever held some.
      listed('commission_held', (_p, i) => configs[i]?.commissionDestination === 'held_separately'),
    ]);
    const unknownKeys = [...(cash.known ? [] : ['cash']), ...[...floats, ...commissionHeld].filter((f) => !f.known).map((f) => floatKey(f.accountKind, f.providerId))];
    const total = unknownKeys.length === 0 ? round2([...floats, ...commissionHeld].reduce((n, f) => n + (f.position as number), cash.position as number)) : null;
    return {
      businessDate,
      asOf: asOf.toISOString(),
      branchId: binToUuid(branchId),
      cash: { known: cash.known, position: cash.position, unknownReason: cash.unknownReason, movement: cash.movement, anchor: cash.anchor },
      floats,
      commissionHeld,
      total,
      unknownKeys,
    };
  }

  /**
   * Set what a float holds now. The Owner's alone. Append-only: a later record
   * supersedes this one and this one stays; what the app tracked just before is
   * kept beside it, with the difference, so a gap between the records and the
   * provider is written down rather than absorbed.
   */
  async set(dto: SetAgentPositionDto) {
    const companyId = this.tenant.companyId();
    const branchId = this.tenant.requireBranchId();
    const userId = this.tenant.requireUserId();
    assertFloatAmount(dto.amount);
    const accountKind: FloatAccountKind = dto.accountKind ?? 'provider';
    const clientUuid = uuidToBin(dto.clientUuid);
    const hash = positionFingerprint({ providerId: dto.providerId, accountKind, amount: dto.amount, note: dto.note });
    const replay = await this.replay(clientUuid, hash);
    if (replay) return replay;
    await requireAgentActivity(this.db, branchId);

    const providerId = uuidToBin(dto.providerId);
    const id = newUuidV7Bin();
    try {
      await this.db.$transaction(async (tx) => {
        // The provider row first, locked: an exchange being posted against it commits before the position is read.
        const [provider] = await tx.$queryRaw<{ id: Buffer; label: string }[]>(Prisma.sql`
          SELECT id, label FROM agent_providers WHERE id = ${providerId} AND company_id = ${companyId} FOR UPDATE`);
        if (!provider) throw new NotFoundException({ code: 'provider_not_found', message: 'That provider does not exist' });
        const at = new Date();
        const businessDate = await this.businessDay.assign(branchId, at, tx as unknown as Prisma.TransactionClient);
        const before = floatPosition(...(await readFloatInputs(tx, { branchId, providerId, accountKind, businessDate }).then((i) => [i.anchor, i.sinceAnchor] as const)));
        const trackedBefore = before.position;
        const difference = trackedBefore === null ? null : round2(dto.amount - trackedBefore);
        const actor = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
        await tx.agentPosition.create({
          data: {
            id,
            companyId,
            branchId,
            accountKind,
            providerId,
            amount: dto.amount,
            at,
            businessDate: dateValue(businessDate),
            source: 'set',
            trackedBefore,
            difference,
            note: dto.note?.trim() || null,
            recordedById: userId,
            recordedByName: actor?.name ?? '',
            clientUuid,
            clientRequestHash: hash,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'AgentPosition',
          entityId: id,
          action: 'create',
          after: { providerId: dto.providerId, label: provider.label, accountKind, amount: dto.amount, trackedBefore, difference, businessDate, source: 'set' },
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
    return this.positionView(id);
  }

  /** The position an earlier request with this key recorded, or null if there was none. */
  private async replay(clientUuid: Buffer, hash: string) {
    const prior = await this.db.agentPosition.findFirst({ where: { clientUuid }, select: { id: true, clientRequestHash: true } });
    if (!prior) return null;
    if (prior.clientRequestHash !== hash) {
      throw new ConflictException({ code: 'idempotency_conflict', message: 'That request id was already used for a different amount.' });
    }
    return this.positionView(prior.id);
  }

  /** The record as written, and the float as it stands now. */
  private async positionView(id: Buffer): Promise<{ position: Record<string, unknown>; float: FloatView }> {
    const row = await this.db.agentPosition.findFirstOrThrow({ where: { id }, select: { ...positionSelect, provider: { select: providerSelect } } });
    const branchId = this.tenant.requireBranchId();
    const businessDate = await this.businessDay.today(branchId);
    return {
      position: {
        id: binToUuid(row.id),
        providerId: binToUuid(row.providerId),
        accountKind: row.accountKind,
        amount: num(row.amount),
        at: row.at.toISOString(),
        businessDate: dateKey(row.businessDate),
        source: row.source,
        trackedBefore: row.trackedBefore == null ? null : num(row.trackedBefore),
        difference: row.difference == null ? null : num(row.difference),
        note: row.note,
        byName: row.recordedByName,
      },
      float: await readFloat(this.db, toFloatProvider(row.provider), row.accountKind as FloatAccountKind, { branchId, businessDate }),
    };
  }
}
