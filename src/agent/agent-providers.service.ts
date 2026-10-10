import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { AccessService } from '../rbac/access.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { permissionDenied } from '../rbac/refusals';
import { AGENT_PERMISSIONS, hasAnyAgentPermission } from './agent-access';
import { configRefusal, missingConfigFields, readyForTransactions, reasonGiven, withSameRate } from './agent-rules';
import { CreateAgentProviderConfigDto, CreateAgentProviderDto, UpdateAgentProviderDto } from './dto/provider.dto';

/** A configuration version as the phone and the transaction snapshot read it. */
export const configSelect = {
  id: true,
  providerId: true,
  rateInBp: true,
  rateOutBp: true,
  sameRateBothDirections: true,
  commissionDestination: true,
  principalFeeMode: true,
  referenceRule: true,
  effectiveFrom: true,
  recordedByName: true,
  reason: true,
} satisfies Prisma.AgentProviderConfigSelect;

export type ConfigRow = Prisma.AgentProviderConfigGetPayload<{ select: typeof configSelect }>;

const providerSelect = { id: true, kind: true, label: true, isActive: true, sortOrder: true } satisfies Prisma.AgentProviderSelect;
type ProviderRow = Prisma.AgentProviderGetPayload<{ select: typeof providerSelect }>;

type ConfigReader = Pick<TenantPrisma, 'agentProviderConfig'>;

/**
 * The version in force: the latest `effective_from` at or before `now`, the
 * latest written when two share an instant. Versions are append-only, so the
 * one an exchange used stays readable forever.
 */
export async function configInForce(client: ConfigReader, providerId: Buffer, now: Date): Promise<ConfigRow | null> {
  return client.agentProviderConfig.findFirst({
    where: { providerId, effectiveFrom: { lte: now } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    select: configSelect,
  });
}

export function configView(row: ConfigRow) {
  return {
    id: binToUuid(row.id),
    rateInBp: row.rateInBp,
    rateOutBp: row.rateOutBp,
    sameRateBothDirections: row.sameRateBothDirections,
    commissionDestination: row.commissionDestination,
    principalFeeMode: row.principalFeeMode,
    referenceRule: row.referenceRule,
    effectiveFrom: row.effectiveFrom.toISOString(),
    recordedByName: row.recordedByName,
    reason: row.reason,
  };
}

/** The provider with its version in force, and whether it may post: the blanks are named, never silently zero. */
export function providerView(row: ProviderRow, config: ConfigRow | null) {
  return {
    id: binToUuid(row.id),
    kind: row.kind,
    label: row.label,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    config: config ? configView(config) : null,
    readyForTransactions: readyForTransactions(config),
    missing: missingConfigFields(config),
  };
}

/**
 * The company's providers and their versioned configuration (docs/73 §1.2,
 * §4.1): the Owner's alone to manage (`agent.provider.manage`); listed to
 * anyone holding an agent key, so the counter knows which providers exist and
 * which are *Not set up yet*.
 */
@Injectable()
export class AgentProvidersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly access: AccessService,
  ) {}

  /** Every provider of the company, in the shop's order, each with its version in force. */
  async list() {
    await this.requireAnyAgentPermission();
    const rows = await this.db.agentProvider.findMany({ select: providerSelect, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] });
    const now = new Date();
    const providers = await Promise.all(rows.map(async (row) => providerView(row, await configInForce(this.db, row.id, now))));
    return { providers };
  }

  async create(dto: CreateAgentProviderDto) {
    const label = dto.label.trim();
    if (!label) throw new BadRequestException('A provider needs a label');
    const id = newUuidV7Bin();
    try {
      await this.db.agentProvider.create({ data: { id, companyId: this.tenant.companyId(), kind: dto.kind, label, sortOrder: dto.sortOrder ?? 0 } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw labelInUse(label);
      throw e;
    }
    await this.audit.record({ entityType: 'AgentProvider', entityId: id, action: 'create', after: { kind: dto.kind, label, sortOrder: dto.sortOrder ?? 0 } });
    return this.view(id);
  }

  async update(id: string, dto: UpdateAgentProviderDto) {
    const providerId = uuidToBin(id);
    const before = await this.db.agentProvider.findFirst({ where: { id: providerId }, select: providerSelect });
    if (!before) throw providerNotFound();
    const label = dto.label === undefined ? undefined : dto.label.trim();
    if (label === '') throw new BadRequestException('A provider needs a label');
    const data = {
      ...(label !== undefined ? { label } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    };
    if (Object.keys(data).length > 0) {
      try {
        await this.db.agentProvider.update({ where: { id: providerId }, data });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw labelInUse(label ?? before.label);
        throw e;
      }
      await this.audit.record({
        entityType: 'AgentProvider',
        entityId: providerId,
        action: dto.isActive !== undefined && dto.isActive !== before.isActive ? 'status_change' : 'update',
        before: { label: before.label, isActive: before.isActive, sortOrder: before.sortOrder },
        after: { label: label ?? before.label, isActive: dto.isActive ?? before.isActive, sortOrder: dto.sortOrder ?? before.sortOrder },
      });
    }
    return this.view(providerId);
  }

  /**
   * A new version, in force from this instant. Append-only: the version an
   * exchange used is never edited. A fee deducted from the principal can only
   * land on the float (`config_invalid`); a blank stays a blank and keeps the
   * provider from posting until the Owner fills it.
   */
  async addConfig(id: string, dto: CreateAgentProviderConfigDto) {
    const providerId = uuidToBin(id);
    const userId = this.tenant.requireUserId();
    const reason = reasonGiven(dto.reason);
    const provider = await this.db.agentProvider.findFirst({ where: { id: providerId }, select: providerSelect });
    if (!provider) throw providerNotFound();
    const fields = withSameRate({
      rateInBp: dto.rateInBp ?? null,
      rateOutBp: dto.rateOutBp ?? null,
      sameRateBothDirections: dto.sameRateBothDirections,
      commissionDestination: dto.commissionDestination ?? null,
      principalFeeMode: dto.principalFeeMode ?? null,
      referenceRule: dto.referenceRule ?? null,
    });
    if (configRefusal(fields)) {
      throw new BadRequestException({
        code: 'config_invalid',
        message: 'A provider that deducts its fee from the principal can only credit it to its float: choose provider_float, or settle the fee separately.',
      });
    }
    const companyId = this.tenant.companyId();
    const actor = await this.db.user.findFirst({ where: { id: userId }, select: { name: true } });
    const configId = newUuidV7Bin();
    await this.db.$transaction(async (tx) => {
      // The provider row, locked: an exchange being posted reads the version in force under this same lock.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_providers WHERE id = ${providerId} AND company_id = ${companyId} FOR UPDATE`);
      await tx.agentProviderConfig.create({
        data: {
          id: configId,
          companyId,
          providerId,
          ...fields,
          effectiveFrom: new Date(),
          recordedById: userId,
          recordedByName: actor?.name ?? '',
          reason,
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'AgentProviderConfig',
        entityId: configId,
        action: 'create',
        reason: reason.slice(0, 255),
        after: { providerId: id, label: provider.label, ...fields, missing: missingConfigFields(fields) },
      });
    });
    const config = await this.db.agentProviderConfig.findFirstOrThrow({ where: { id: configId }, select: configSelect });
    return { config: configView(config), provider: providerView(provider, await configInForce(this.db, providerId, new Date())) };
  }

  /** Every version of a provider, newest first: the history behind every exchange's rate. */
  async listConfigs(id: string) {
    const providerId = uuidToBin(id);
    const provider = await this.db.agentProvider.findFirst({ where: { id: providerId }, select: { id: true } });
    if (!provider) throw providerNotFound();
    const rows = await this.db.agentProviderConfig.findMany({ where: { providerId }, select: configSelect, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
    return { configs: rows.map(configView) };
  }

  private async view(providerId: Buffer) {
    const row = await this.db.agentProvider.findFirstOrThrow({ where: { id: providerId }, select: providerSelect });
    return providerView(row, await configInForce(this.db, providerId, new Date()));
  }

  /**
   * Any of the nine keys opens the list: the route carries no single key, so
   * the permissions are the request's when a guard resolved them, else resolved
   * here for the branch in context — as the catalogue does for its own reads.
   * The refusal is the guard's `permission_denied`, naming the nine: any one would do.
   */
  private async requireAnyAgentPermission(): Promise<void> {
    let held = this.cls.get('permissions');
    if (!held) held = await this.access.getEffectivePermissions(this.tenant.requireUserId(), this.tenant.branchId());
    if (!hasAnyAgentPermission(held)) throw permissionDenied(AGENT_PERMISSIONS, 'Missing permission(s): one of the agent counter’s keys');
  }
}

const labelInUse = (label: string) => new ConflictException({ code: 'provider_label_in_use', message: `A provider is already called "${label}"` });
const providerNotFound = () => new NotFoundException({ code: 'provider_not_found', message: 'That provider does not exist' });
