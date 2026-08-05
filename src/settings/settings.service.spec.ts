import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { CreateReceivingAccountDto, UpdateReceivingAccountDto } from './dto/receiving-account.dto';
import { AUTO_LOCK_CHOICES } from './settings.constants';
import { uuidToBin, binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * Owner settings are the first thing in this system that one person configures
 * and everyone else obeys, so the tests are about who may see what, who may
 * change it, and what happens when two people change it at once.
 *
 * The Prisma double below enforces the tenant filter, the unique label index and
 * the conditional version match for real. A stub that always succeeded would let
 * a broken concurrency check pass silently — which is exactly the bug the
 * version column exists to prevent.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const USER = '018f0000-0000-7000-8000-00000000u001'.replace(/u/g, 'a');

interface SettingsRow {
  companyId: Buffer;
  returnWindowHours: number;
  whatsappLanguage: 'en' | 'ar';
  whatsappIncludeAmounts: boolean;
  whatsappDailyEnabled: boolean;
  whatsappMonthlyEnabled: boolean;
  autoLockMaxSeconds: number;
  version: number;
  updatedById: Buffer | null;
}

/** Schema defaults from 0019 — what a migrated or freshly seeded company has. */
function defaults(companyId: Buffer): SettingsRow {
  return {
    companyId,
    returnWindowHours: 0,
    whatsappLanguage: 'en',
    whatsappIncludeAmounts: false,
    whatsappDailyEnabled: false,
    whatsappMonthlyEnabled: false,
    autoLockMaxSeconds: 300,
    version: 0,
    updatedById: null,
  };
}

function makeService(opts: { permissions?: string[]; companyId?: Buffer; settingsRows?: SettingsRow[]; accounts?: any[] } = {}) {
  const companyId = opts.companyId ?? COMPANY;
  const settingsRows: SettingsRow[] = opts.settingsRows ?? [];
  const accounts: any[] = opts.accounts ?? [];
  const audits: any[] = [];

  /**
   * The tenant Prisma extension injects `companyId` into every where clause.
   * The double must do the same, or a service that forgot to scope a query
   * would pass here and leak in production.
   */
  const scoped = (where: any = {}) => ({ companyId, ...where });

  const sameCompany = (row: { companyId: Buffer }, where: any) =>
    !where?.companyId || row.companyId.equals(where.companyId);

  const matchAccount = (a: any, rawWhere: any) => {
    const where = scoped(rawWhere);
    return (
      sameCompany(a, where) &&
      (where.id === undefined || a.id.equals(where.id)) &&
      (where.isActive === undefined || a.isActive === where.isActive) &&
      (where.label === undefined || a.label === where.label) &&
      (where.version === undefined || a.version === where.version)
    );
  };

  /** Rows are returned by value — Prisma never hands back a live reference. */
  const copy = <T,>(row: T): T => ({ ...row });

  const db: any = {
    companySettings: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const found = settingsRows.find((r) => r.companyId.equals(scoped(where).companyId));
        if (found) return copy(found);
        const row = defaults(create.companyId ?? where.companyId);
        settingsRows.push(row);
        return copy(row);
      }),
      updateMany: jest.fn(async ({ where: raw, data }: any) => {
        const where = scoped(raw);
        const row = settingsRows.find(
          (r) => sameCompany(r, where) && (where.version === undefined || r.version === where.version),
        );
        if (!row) return { count: 0 };
        for (const [k, v] of Object.entries(data)) {
          if (k === 'version') row.version += (v as { increment: number }).increment;
          else (row as never as Record<string, unknown>)[k] = v;
        }
        return { count: 1 };
      }),
    },
    receivingAccount: {
      findMany: jest.fn(async ({ where, orderBy }: any = {}) => {
        const hits = accounts.filter((a) => matchAccount(a, where ?? {})).map(copy);
        // `[{ sortOrder: 'asc' }, { label: 'asc' }]` — the till order.
        if (Array.isArray(orderBy)) {
          hits.sort((x, y) => x.sortOrder - y.sortOrder || String(x.label).localeCompare(String(y.label)));
        }
        return hits;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any = {}) => {
        const hits = accounts.filter((a) => matchAccount(a, where ?? {}));
        if (orderBy?.sortOrder === 'desc') {
          return copy([...hits].sort((x, y) => y.sortOrder - x.sortOrder)[0] ?? null);
        }
        return hits[0] ? copy(hits[0]) : null;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const hit = accounts.find((a) => matchAccount(a, where));
        return hit ? copy(hit) : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        // The unique index, enforced in the double.
        if (accounts.some((a) => a.companyId.equals(data.companyId) && a.label === data.label)) {
          const e: any = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        const row = { isActive: true, version: 0, providerName: null, ...data };
        accounts.push(row);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = accounts.find((a) => matchAccount(a, where));
        if (!row) return { count: 0 };
        for (const [k, v] of Object.entries(data)) {
          if (k === 'version') row.version += (v as { increment: number }).increment;
          else row[k] = v;
        }
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const service = new SettingsService(
    db as never,
    {
      companyId: () => companyId,
      branchId: () => undefined,
      userId: () => uuidToBin(USER),
    } as never,
    { record: jest.fn(async (p: unknown) => void audits.push(p)) } as never,
    { getEffectivePermissions: jest.fn(async () => new Set(opts.permissions ?? [])) } as never,
    {
      get: (key: string) => (key === 'permissions' ? new Set(opts.permissions ?? []) : USER),
      set: jest.fn(),
    } as never,
  );

  return { service, db, accounts, settingsRows, audits };
}

function account(over: Record<string, unknown> = {}) {
  return {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    provider: 'bankily',
    providerName: null,
    label: 'Bankily – Main Counter',
    isActive: true,
    sortOrder: 0,
    version: 0,
    ...over,
  };
}

/** Flattened messages, including nested objects — `whatsapp` and `security` are both nested. */
async function dtoErrors(cls: any, payload: object): Promise<string[]> {
  const flatten = (errors: ValidationError[]): string[] =>
    errors.flatMap((e) => [...Object.values(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return flatten(await validate(plainToInstance(cls, payload)));
}

describe('safe defaults', () => {
  it('a company with no row gets defaults rather than a 404', async () => {
    const { service, settingsRows } = makeService({ permissions: ['settings.manage'] });

    const view = await service.read();

    expect(settingsRows).toHaveLength(1);
    expect(view.returnWindowHours).toBe(0);
    expect(view.security.autoLockMaxSeconds).toBe(300);
  });

  it('defaults to NO returns — a refund window is opted into, never inherited', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });

    const view = await service.read();

    expect(view.returnWindowHours).toBe(0);
  });

  it('defaults to sending nothing over WhatsApp, and no amounts if it did', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });

    const view = (await service.read()) as any;

    expect(view.whatsapp).toEqual({
      language: 'en',
      includeAmounts: false,
      dailyEnabled: false,
      monthlyEnabled: false,
    });
  });
});

describe('who sees what', () => {
  it('an employee gets the return window, the lock maximum and active account names', async () => {
    const { service } = makeService({
      permissions: ['sale.create'],
      settingsRows: [{ ...defaults(COMPANY), returnWindowHours: 48 }],
      accounts: [account(), account({ label: 'Sedad – Back Office', provider: 'sedad', sortOrder: 1 })],
    });

    const view = await service.read();

    expect(view.canManage).toBe(false);
    expect(view.returnWindowHours).toBe(48);
    expect(view.security.autoLockMaxSeconds).toBe(300);
    expect(view.receivingAccounts.map((a) => a.label)).toEqual([
      'Bankily – Main Counter',
      'Sedad – Back Office',
    ]);
  });

  it("an employee never receives the Owner's WhatsApp preferences", async () => {
    const { service } = makeService({ permissions: ['sale.create', 'cost.view'] });

    const view = (await service.read()) as any;

    // Not merely hidden in the UI — absent from the payload.
    expect(view.whatsapp).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('whatsapp');
  });

  it('an employee never receives the concurrency token or account internals', async () => {
    const { service } = makeService({
      permissions: ['sale.create'],
      accounts: [account()],
    });

    const view = (await service.read()) as any;

    expect(view.version).toBeUndefined();
    expect(view.receivingAccounts[0].version).toBeUndefined();
    expect(view.receivingAccounts[0].sortOrder).toBeUndefined();
    expect(view.receivingAccounts[0].isActive).toBeUndefined();
  });

  it('an employee is not shown deactivated accounts', async () => {
    const { service } = makeService({
      permissions: ['sale.create'],
      accounts: [account(), account({ label: 'Old BIM counter', provider: 'bim_bank', isActive: false })],
    });

    const view = await service.read();

    expect(view.receivingAccounts).toHaveLength(1);
    expect(view.receivingAccounts[0].label).toBe('Bankily – Main Counter');
  });

  it('the Owner sees everything, including inactive accounts', async () => {
    const { service } = makeService({
      permissions: ['settings.manage'],
      accounts: [account(), account({ label: 'Old BIM counter', provider: 'bim_bank', isActive: false })],
    });

    const view = (await service.read()) as any;

    expect(view.canManage).toBe(true);
    expect(view.whatsapp).toBeDefined();
    expect(view.version).toBe(0);
    expect(view.receivingAccounts).toHaveLength(2);
  });
});

describe('company isolation', () => {
  it("one company's settings row is never returned to another", async () => {
    const { service } = makeService({
      permissions: ['settings.manage'],
      companyId: OTHER_COMPANY,
      settingsRows: [{ ...defaults(COMPANY), returnWindowHours: 48 }],
    });

    const view = await service.read();

    // The other company's 48h window must not leak — this company gets defaults.
    expect(view.returnWindowHours).toBe(0);
  });

  it("one company's accounts are never listed for another", async () => {
    const { service } = makeService({
      permissions: ['settings.manage'],
      companyId: OTHER_COMPANY,
      accounts: [account()],
    });

    const view = await service.read();

    expect(view.receivingAccounts).toEqual([]);
  });

  it('a stale version from another company cannot update these settings', async () => {
    const { service, settingsRows } = makeService({
      permissions: ['settings.manage'],
      companyId: OTHER_COMPANY,
      settingsRows: [{ ...defaults(COMPANY), version: 7 }],
    });

    await service.read(); // creates OTHER_COMPANY's own row at version 0
    await expect(service.update({ version: 7, returnWindowHours: 24 })).rejects.toBeInstanceOf(ConflictException);

    expect(settingsRows.find((r) => r.companyId.equals(COMPANY))!.returnWindowHours).toBe(0);
  });
});

describe('updating policy', () => {
  it('the Owner can set a 48-hour return window', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });
    await service.read();

    const view = await service.update({ version: 0, returnWindowHours: 48 });

    expect(view.returnWindowHours).toBe(48);
    expect(view.version).toBe(1);
  });

  it('turning returns off again is just 0 — no separate flag to disagree with', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });
    await service.read();

    await service.update({ version: 0, returnWindowHours: 24 });
    const off = await service.update({ version: 1, returnWindowHours: 0 });

    expect(off.returnWindowHours).toBe(0);
  });

  it('a save based on stale state is rejected instead of overwriting', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });
    await service.read();

    // Two devices load version 0. The first saves.
    await service.update({ version: 0, returnWindowHours: 24 });

    // The second still believes it is editing version 0.
    await expect(service.update({ version: 0, returnWindowHours: 48 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('the first writer keeps their value when the second is rejected', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });
    await service.read();
    await service.update({ version: 0, returnWindowHours: 24 });

    await expect(service.update({ version: 0, returnWindowHours: 48 })).rejects.toThrow();

    const view = (await service.read()) as any;
    expect(view.returnWindowHours).toBe(24);
  });

  it('an empty update is a bad request, not a silent version bump', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });
    await service.read();

    await expect(service.update({ version: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records an audit entry with the old and new values', async () => {
    const { service, audits } = makeService({ permissions: ['settings.manage'] });
    await service.read();

    await service.update({ version: 0, returnWindowHours: 48, security: { autoLockMaxSeconds: 60 } });

    const entry = audits.find((a) => a.entityType === 'CompanySettings');
    expect(entry.action).toBe('update');
    expect(entry.before).toMatchObject({ returnWindowHours: 0, autoLockMaxSeconds: 300, version: 0 });
    expect(entry.after).toMatchObject({ returnWindowHours: 48, autoLockMaxSeconds: 60, version: 1 });
  });

  it('the audit shows only what changed, so the diff stays readable', async () => {
    const { service, audits } = makeService({ permissions: ['settings.manage'] });
    await service.read();

    await service.update({ version: 0, returnWindowHours: 24 });

    const entry = audits.find((a) => a.entityType === 'CompanySettings');
    expect(Object.keys(entry.after).sort()).toEqual(['returnWindowHours', 'version']);
  });
});

describe('receiving accounts', () => {
  it('accepts several accounts from the same provider, told apart by label', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });

    await service.createAccount({ provider: 'bankily', label: 'Bankily – Main Counter' } as CreateReceivingAccountDto);
    await service.createAccount({ provider: 'bankily', label: 'Bankily – Second Shop' } as CreateReceivingAccountDto);

    const view = (await service.read()) as any;
    expect(view.receivingAccounts).toHaveLength(2);
    expect(view.receivingAccounts.every((a: any) => a.provider === 'bankily')).toBe(true);
  });

  it('refuses a duplicate label — two identical names are not a choice', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });
    await service.createAccount({ provider: 'bankily', label: 'Bankily – Main Counter' } as CreateReceivingAccountDto);

    await expect(
      service.createAccount({ provider: 'sedad', label: 'Bankily – Main Counter' } as CreateReceivingAccountDto),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('a custom provider must be named', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });

    await expect(
      service.createAccount({ provider: 'other', label: 'Corner shop wallet' } as CreateReceivingAccountDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a known provider must not carry a second name', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });

    await expect(
      service.createAccount({
        provider: 'bankily',
        providerName: 'Actually Sedad',
        label: 'Confusing',
      } as CreateReceivingAccountDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('new accounts go last rather than jumping the till order', async () => {
    const { service } = makeService({ permissions: ['settings.manage'], accounts: [account({ sortOrder: 4 })] });

    await service.createAccount({ provider: 'sedad', label: 'Sedad – New' } as CreateReceivingAccountDto);

    const view = (await service.read()) as any;
    expect(view.receivingAccounts.find((a: any) => a.label === 'Sedad – New').sortOrder).toBe(5);
  });

  it('deactivates instead of deleting, so history stays attributable', async () => {
    const existing = account();
    const { service, accounts } = makeService({ permissions: ['settings.manage'], accounts: [existing] });

    await service.updateAccount(binToUuid(existing.id), { version: 0, isActive: false } as UpdateReceivingAccountDto);

    expect(accounts).toHaveLength(1);
    expect(accounts[0].isActive).toBe(false);
  });

  it('a deactivation is audited as a status change with both values', async () => {
    const existing = account();
    const { service, audits } = makeService({ permissions: ['settings.manage'], accounts: [existing] });

    await service.updateAccount(binToUuid(existing.id), { version: 0, isActive: false } as UpdateReceivingAccountDto);

    const entry = audits.find((a) => a.entityType === 'ReceivingAccount');
    expect(entry.action).toBe('status_change');
    expect(entry.before).toMatchObject({ isActive: true });
    expect(entry.after).toMatchObject({ isActive: false });
  });

  it('a deactivated account can be restored', async () => {
    const existing = account({ isActive: false });
    const { service, accounts } = makeService({ permissions: ['settings.manage'], accounts: [existing] });

    await service.updateAccount(binToUuid(existing.id), { version: 0, isActive: true } as UpdateReceivingAccountDto);

    expect(accounts[0].isActive).toBe(true);
  });

  it('a stale account edit is rejected', async () => {
    const existing = account({ version: 3 });
    const { service } = makeService({ permissions: ['settings.manage'], accounts: [existing] });

    await expect(
      service.updateAccount(binToUuid(existing.id), { version: 1, label: 'Renamed' } as UpdateReceivingAccountDto),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('an account from another company is not found, not edited', async () => {
    const foreign = account({ companyId: OTHER_COMPANY });
    const { service, accounts } = makeService({ permissions: ['settings.manage'], accounts: [foreign] });

    await expect(
      service.updateAccount(binToUuid(foreign.id), { version: 0, label: 'Hijacked' } as UpdateReceivingAccountDto),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(accounts[0].label).toBe('Bankily – Main Counter');
  });

  it('reordering requires the full list, so a stale client cannot bury a new account', async () => {
    const a = account({ label: 'A' });
    const b = account({ label: 'B', sortOrder: 1 });
    const { service } = makeService({ permissions: ['settings.manage'], accounts: [a, b] });

    await expect(service.reorderAccounts({ ids: [binToUuid(a.id)] })).rejects.toBeInstanceOf(ConflictException);
  });

  it('reordering applies the requested order', async () => {
    const a = account({ label: 'A' });
    const b = account({ label: 'B', sortOrder: 1 });
    const { service } = makeService({ permissions: ['settings.manage'], accounts: [a, b] });

    const result = await service.reorderAccounts({ ids: [binToUuid(b.id), binToUuid(a.id)] });

    expect(result.map((r) => r.label)).toEqual(['B', 'A']);
  });

  it('stores no credential of any kind', async () => {
    const { service } = makeService({ permissions: ['settings.manage'] });

    const created = await service.createAccount({
      provider: 'bankily',
      label: 'Bankily – Main Counter',
    } as CreateReceivingAccountDto);

    // The app records where money is expected. It never authenticates as the shop.
    const forbidden = ['pin', 'password', 'secret', 'token', 'apiKey', 'balance', 'accountNumber', 'msisdn'];
    for (const field of forbidden) {
      expect(created).not.toHaveProperty(field);
    }
  });
});

describe('validation', () => {
  it('rejects a negative return window', async () => {
    expect(await dtoErrors(UpdateSettingsDto, { version: 0, returnWindowHours: -1 })).toEqual(
      expect.arrayContaining([expect.stringContaining('cannot be negative')]),
    );
  });

  it('rejects an absurd return window', async () => {
    expect(await dtoErrors(UpdateSettingsDto, { version: 0, returnWindowHours: 100000 })).toEqual(
      expect.arrayContaining([expect.stringContaining('cannot exceed')]),
    );
  });

  it('accepts 24, 48 and a custom value', async () => {
    for (const hours of [0, 24, 48, 72, 6]) {
      expect(await dtoErrors(UpdateSettingsDto, { version: 0, returnWindowHours: hours })).toEqual([]);
    }
  });

  it('accepts only the five approved auto-lock intervals', async () => {
    for (const seconds of AUTO_LOCK_CHOICES) {
      expect(await dtoErrors(UpdateSettingsDto, { version: 0, security: { autoLockMaxSeconds: seconds } })).toEqual([]);
    }
  });

  it('rejects an auto-lock interval that is not on the list', async () => {
    for (const seconds of [45, 3600, -1]) {
      expect(await dtoErrors(UpdateSettingsDto, { version: 0, security: { autoLockMaxSeconds: seconds } })).not.toEqual([]);
    }
  });

  it('cannot express "never" — there is no sentinel that means it', async () => {
    // The decision forbids "never", so it must be unrepresentable rather than
    // merely discouraged. Null, huge numbers and -1 all fail.
    for (const value of [null, -1, 0x7fffffff, 86400]) {
      expect(await dtoErrors(UpdateSettingsDto, { version: 0, security: { autoLockMaxSeconds: value } })).not.toEqual([]);
    }
    // 0 is valid, and it means lock IMMEDIATELY — the opposite of never.
    expect(await dtoErrors(UpdateSettingsDto, { version: 0, security: { autoLockMaxSeconds: 0 } })).toEqual([]);
  });

  it('requires a version on every write', async () => {
    expect(await dtoErrors(UpdateSettingsDto, { returnWindowHours: 24 })).not.toEqual([]);
  });

  it('accepts only English and Arabic for the summary', async () => {
    expect(await dtoErrors(UpdateSettingsDto, { version: 0, whatsapp: { language: 'fr' } })).not.toEqual([]);
    expect(await dtoErrors(UpdateSettingsDto, { version: 0, whatsapp: { language: 'ar' } })).toEqual([]);
  });

  it('requires a non-empty label on an account', async () => {
    expect(await dtoErrors(CreateReceivingAccountDto, { provider: 'bankily', label: '   ' })).not.toEqual([]);
  });

  it('rejects an unknown provider', async () => {
    expect(await dtoErrors(CreateReceivingAccountDto, { provider: 'paypal', label: 'X' })).not.toEqual([]);
  });
});
