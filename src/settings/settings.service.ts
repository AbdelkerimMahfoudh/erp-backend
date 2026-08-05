import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CompanySettings, Prisma, ReceivingAccount, ReceivingProvider } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { AccessService } from '../rbac/access.service';
import { AppClsStore } from '../common/context/request-context';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import {
  CreateReceivingAccountDto,
  ReorderReceivingAccountsDto,
  UpdateReceivingAccountDto,
} from './dto/receiving-account.dto';

/** What an employee at the till is allowed to see. */
export interface StaffSettingsView {
  returnWindowHours: number;
  security: { autoLockMaxSeconds: number };
  receivingAccounts: { id: string; provider: ReceivingProvider; providerName: string | null; label: string }[];
  canManage: false;
}

/** Everything, plus the concurrency token needed to save. */
export interface OwnerSettingsView {
  returnWindowHours: number;
  whatsapp: {
    language: CompanySettings['whatsappLanguage'];
    includeAmounts: boolean;
    dailyEnabled: boolean;
    monthlyEnabled: boolean;
  };
  security: { autoLockMaxSeconds: number };
  receivingAccounts: {
    id: string;
    provider: ReceivingProvider;
    providerName: string | null;
    label: string;
    isActive: boolean;
    sortOrder: number;
    version: number;
  }[];
  version: number;
  canManage: true;
}

export type SettingsView = OwnerSettingsView | StaffSettingsView;

/**
 * Owner-configured business policy.
 *
 * Three rules shape everything here:
 *
 * 1. **The response is shaped by permission, not by the client.** An employee
 *    receives the settings they need to do the job and nothing else — no
 *    WhatsApp preferences, no inactive accounts, no concurrency token. Hiding a
 *    field in the UI is a courtesy; not sending it is the actual boundary.
 * 2. **Every write is version-checked.** Two Owner devices with the screen open
 *    is an ordinary Tuesday, and the slower save must not silently erase the
 *    faster one.
 * 3. **Accounts are deactivated, never deleted.** Money movement will point at
 *    them, and a dangling reference in a financial record is not recoverable by
 *    reading the audit log.
 */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  // ---------------------------------------------------------------- reading

  async read(): Promise<SettingsView> {
    const [settings, canManage] = await Promise.all([this.ensureRow(), this.canManage()]);

    if (!canManage) {
      const accounts = await this.db.receivingAccount.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      });
      return {
        returnWindowHours: settings.returnWindowHours,
        security: { autoLockMaxSeconds: settings.autoLockMaxSeconds },
        // Only what a sale needs: which account to name to the customer.
        receivingAccounts: accounts.map((a) => ({
          id: binToUuid(a.id),
          provider: a.provider,
          providerName: a.providerName,
          label: a.label,
        })),
        canManage: false,
      };
    }

    return this.ownerView(settings);
  }

  // ---------------------------------------------------------------- writing

  async update(dto: UpdateSettingsDto): Promise<OwnerSettingsView> {
    const before = await this.ensureRow();

    const data: Prisma.CompanySettingsUpdateManyMutationInput = {};
    if (dto.returnWindowHours !== undefined) data.returnWindowHours = dto.returnWindowHours;
    if (dto.whatsapp?.language !== undefined) data.whatsappLanguage = dto.whatsapp.language;
    if (dto.whatsapp?.includeAmounts !== undefined) data.whatsappIncludeAmounts = dto.whatsapp.includeAmounts;
    if (dto.whatsapp?.dailyEnabled !== undefined) data.whatsappDailyEnabled = dto.whatsapp.dailyEnabled;
    if (dto.whatsapp?.monthlyEnabled !== undefined) data.whatsappMonthlyEnabled = dto.whatsapp.monthlyEnabled;
    if (dto.security?.autoLockMaxSeconds !== undefined) data.autoLockMaxSeconds = dto.security.autoLockMaxSeconds;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No settings were provided to change');
    }

    // The version lives in the WHERE clause, so the check and the write are one
    // statement. Reading the version and then updating would leave a gap where
    // the other device commits.
    const { count } = await this.db.companySettings.updateMany({
      where: { companyId: this.tenant.companyId(), version: dto.version },
      data: { ...data, version: { increment: 1 }, updatedById: this.tenant.userId() ?? null },
    });

    if (count === 0) {
      throw new ConflictException(
        'These settings were changed on another device. Reload to see the current values before saving again.',
      );
    }

    const after = await this.ensureRow();
    await this.audit.record({
      entityType: 'CompanySettings',
      entityId: after.companyId,
      action: 'update',
      before: this.auditable(before, Object.keys(data)),
      after: this.auditable(after, Object.keys(data)),
    });

    return this.ownerView(after);
  }

  // ------------------------------------------------------- receiving accounts

  async createAccount(dto: CreateReceivingAccountDto): Promise<ReceivingAccount> {
    const providerName = this.resolveProviderName(dto.provider, dto.providerName);
    await this.assertLabelFree(dto.label);

    // New accounts go last; the Owner reorders deliberately.
    const last = await this.db.receivingAccount.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    const account = await this.db.receivingAccount.create({
      data: {
        id: newUuidV7Bin(),
        companyId: this.tenant.companyId(),
        provider: dto.provider,
        providerName,
        label: dto.label,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        createdById: this.tenant.userId() ?? null,
      },
    });

    await this.audit.record({
      entityType: 'ReceivingAccount',
      entityId: account.id,
      action: 'create',
      after: { provider: account.provider, providerName: account.providerName, label: account.label, isActive: true },
    });
    return account;
  }

  async updateAccount(idStr: string, dto: UpdateReceivingAccountDto): Promise<ReceivingAccount> {
    const id = uuidToBin(idStr);
    const before = await this.db.receivingAccount.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Receiving account not found');

    const provider = dto.provider ?? before.provider;
    const data: Prisma.ReceivingAccountUpdateManyMutationInput = {};

    if (dto.provider !== undefined) data.provider = dto.provider;
    if (dto.provider !== undefined || dto.providerName !== undefined) {
      data.providerName = this.resolveProviderName(
        provider,
        dto.providerName ?? (provider === before.provider ? before.providerName ?? undefined : undefined),
      );
    }
    if (dto.label !== undefined && dto.label !== before.label) {
      await this.assertLabelFree(dto.label);
      data.label = dto.label;
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No account fields were provided to change');
    }

    const { count } = await this.db.receivingAccount.updateMany({
      where: { id, version: dto.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (count === 0) {
      throw new ConflictException(
        'This account was changed on another device. Reload to see the current values before saving again.',
      );
    }

    const after = (await this.db.receivingAccount.findUnique({ where: { id } }))!;
    await this.audit.record({
      entityType: 'ReceivingAccount',
      entityId: id,
      action: dto.isActive === false ? 'status_change' : 'update',
      before: this.auditableAccount(before, Object.keys(data)),
      after: this.auditableAccount(after, Object.keys(data)),
    });
    return after;
  }

  /**
   * Reorder is all-or-nothing: the request must name every account, so a stale
   * client that never saw a newly added one cannot bury it at position zero.
   */
  async reorderAccounts(dto: ReorderReceivingAccountsDto): Promise<ReceivingAccount[]> {
    const existing = await this.db.receivingAccount.findMany({ select: { id: true } });
    const known = new Set(existing.map((a) => binToUuid(a.id)));
    const requested = new Set(dto.ids);

    if (requested.size !== dto.ids.length) {
      throw new BadRequestException('The same account was listed twice');
    }
    if (requested.size !== known.size || [...requested].some((id) => !known.has(id))) {
      throw new ConflictException(
        'The account list has changed since it was loaded. Reload before reordering.',
      );
    }

    await this.db.$transaction(
      dto.ids.map((idStr, index) =>
        this.db.receivingAccount.updateMany({
          where: { id: uuidToBin(idStr) },
          data: { sortOrder: index, version: { increment: 1 } },
        }),
      ),
    );

    await this.audit.record({
      entityType: 'ReceivingAccount',
      action: 'update',
      before: { order: existing.map((a) => binToUuid(a.id)) },
      after: { order: dto.ids },
      reason: 'Reordered receiving accounts',
    });

    return this.db.receivingAccount.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] });
  }

  // ---------------------------------------------------------------- internals

  /**
   * Settings must always exist. 0019 backfilled every company and the seed
   * creates one, but a company born some other way should get defaults rather
   * than a 404 at a shop that has done nothing wrong.
   */
  private ensureRow(): Promise<CompanySettings> {
    // The tenant extension injects `companyId` anyway; passing it explicitly is
    // the defense-in-depth convention used across the services here.
    return this.db.companySettings.upsert({
      where: { companyId: this.tenant.companyId() },
      update: {},
      create: { companyId: this.tenant.companyId() },
    });
  }

  private async canManage(): Promise<boolean> {
    const cached = this.cls.get('permissions');
    if (cached) return cached.has('settings.manage');

    const userId = this.cls.get('userId');
    if (!userId) return false;
    const permissions = await this.access.getEffectivePermissions(uuidToBin(userId), this.tenant.branchId());
    this.cls.set('permissions', permissions);
    return permissions.has('settings.manage');
  }

  private async ownerView(settings: CompanySettings): Promise<OwnerSettingsView> {
    const accounts = await this.db.receivingAccount.findMany({
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
    return {
      returnWindowHours: settings.returnWindowHours,
      whatsapp: {
        language: settings.whatsappLanguage,
        includeAmounts: settings.whatsappIncludeAmounts,
        dailyEnabled: settings.whatsappDailyEnabled,
        monthlyEnabled: settings.whatsappMonthlyEnabled,
      },
      security: { autoLockMaxSeconds: settings.autoLockMaxSeconds },
      receivingAccounts: accounts.map((a) => ({
        id: binToUuid(a.id),
        provider: a.provider,
        providerName: a.providerName,
        label: a.label,
        isActive: a.isActive,
        sortOrder: a.sortOrder,
        version: a.version,
      })),
      version: settings.version,
      canManage: true,
    };
  }

  /** A custom provider must be named; a known one must not carry a second name. */
  private resolveProviderName(provider: ReceivingProvider, providerName?: string): string | null {
    if (provider === 'other') {
      if (!providerName || providerName.trim().length === 0) {
        throw new BadRequestException('A provider name is required when the provider is "other"');
      }
      return providerName.trim();
    }
    if (providerName && providerName.trim().length > 0) {
      throw new BadRequestException(`providerName only applies to the "other" provider, not "${provider}"`);
    }
    return null;
  }

  /**
   * A duplicate label is caught here for a clear message and by the unique
   * index for correctness — two devices can both pass this check.
   */
  private async assertLabelFree(label: string): Promise<void> {
    const clash = await this.db.receivingAccount.findFirst({ where: { label } });
    if (clash) {
      throw new ConflictException(`Another account is already called "${label}"`);
    }
  }

  /** Only the fields the request actually touched, so the audit diff is readable. */
  private auditable(row: CompanySettings, changed: string[]): Prisma.InputJsonValue {
    const all: Record<string, unknown> = {
      returnWindowHours: row.returnWindowHours,
      whatsappLanguage: row.whatsappLanguage,
      whatsappIncludeAmounts: row.whatsappIncludeAmounts,
      whatsappDailyEnabled: row.whatsappDailyEnabled,
      whatsappMonthlyEnabled: row.whatsappMonthlyEnabled,
      autoLockMaxSeconds: row.autoLockMaxSeconds,
      version: row.version,
    };
    return this.pick(all, [...changed, 'version']);
  }

  private auditableAccount(row: ReceivingAccount, changed: string[]): Prisma.InputJsonValue {
    const all: Record<string, unknown> = {
      provider: row.provider,
      providerName: row.providerName,
      label: row.label,
      isActive: row.isActive,
      version: row.version,
    };
    return this.pick(all, [...changed, 'version']);
  }

  private pick(all: Record<string, unknown>, keys: string[]): Prisma.InputJsonValue {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in all) out[key] = all[key];
    }
    return out as Prisma.InputJsonValue;
  }
}
