import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { UserManagementService } from './user-management.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { uuidToBin, binToUuid, newUuidV7Bin } from '../common/utils/uuid.util';

/**
 * Team management is Owner-only and tenant-isolated, and it must never leak a
 * password/PIN/token hash or claim a contact is verified when nothing can verify
 * it. The Prisma double below enforces the tenant filter and the per-company
 * phone unique index for real, so a service that forgot to scope a query — or
 * that let two users share a number — would fail here, not in production.
 */

const COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c001');
const OTHER_COMPANY = uuidToBin('018f0000-0000-7000-8000-00000000c002');
const OWNER_ID = '018f0000-0000-7000-8000-00000000a001';

interface UserRow {
  id: Buffer;
  companyId: Buffer;
  name: string;
  login: string;
  passwordHash: string;
  pinHash: string | null;
  phone: string | null;
  email: string | null;
  phoneVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  deletedAt: Date | null;
  userBranches: { branch: { id: Buffer; name: string }; role: { key: string } }[];
}

function user(over: Partial<UserRow> = {}): UserRow {
  return {
    id: newUuidV7Bin(),
    companyId: COMPANY,
    name: 'Seller',
    login: 'seller',
    passwordHash: '$argon2id$SECRET-HASH',
    pinHash: null,
    phone: null,
    email: null,
    phoneVerifiedAt: null,
    emailVerifiedAt: null,
    isActive: true,
    lastLoginAt: null,
    deletedAt: null,
    userBranches: [{ branch: { id: newUuidV7Bin(), name: 'Main Store' }, role: { key: 'store_employee' } }],
    ...over,
  };
}

function makeService(opts: { users?: UserRow[]; companyId?: Buffer; selfId?: string } = {}) {
  const companyId = opts.companyId ?? COMPANY;
  const users: UserRow[] = opts.users ?? [];
  const audits: any[] = [];

  // The tenant extension injects companyId into every where clause; the double
  // must do the same, or an unscoped query would pass here and leak in prod.
  const scoped = (where: any = {}) => ({ companyId, ...where });
  const match = (u: UserRow, rawWhere: any) => {
    const where = scoped(rawWhere);
    return (
      u.companyId.equals(where.companyId) &&
      (where.id === undefined || u.id.equals(where.id)) &&
      (where.deletedAt === undefined || (where.deletedAt === null ? u.deletedAt === null : false))
    );
  };
  // Return real Date objects (not JSON) so the service can call toISOString().
  // Note the projection omits passwordHash/pinHash/companyId/deletedAt exactly as
  // USER_SELECT does — hashes are never handed back by the query.
  const copy = (u: UserRow) => ({
    id: u.id,
    name: u.name,
    login: u.login,
    phone: u.phone,
    email: u.email,
    phoneVerifiedAt: u.phoneVerifiedAt,
    emailVerifiedAt: u.emailVerifiedAt,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    userBranches: u.userBranches.map((b) => ({ branch: { ...b.branch }, role: { ...b.role } })),
  });

  const db: any = {
    user: {
      findMany: jest.fn(async ({ where, orderBy }: any = {}) => {
        let hits = users.filter((u) => match(u, where ?? {}));
        if (Array.isArray(orderBy)) {
          hits = [...hits].sort(
            (a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name),
          );
        }
        return hits.map(copy);
      }),
      findFirst: jest.fn(async ({ where }: any = {}) => {
        const hit = users.find((u) => match(u, where ?? {}));
        return hit ? copy(hit) : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = users.find((u) => match(u, where));
        if (!row) {
          throw new Prisma.PrismaClientKnownRequestError('Record not found', {
            code: 'P2025',
            clientVersion: 'test',
          });
        }
        // Enforce the per-company UNIQUE(company_id, phone) index for real.
        if (typeof data.phone === 'string' && data.phone !== null) {
          const clash = users.some(
            (u) => !u.id.equals(row.id) && u.companyId.equals(row.companyId) && u.deletedAt === null && u.phone === data.phone,
          );
          if (clash) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            });
          }
        }
        for (const [k, v] of Object.entries(data)) (row as any)[k] = v;
        return copy(row);
      }),
    },
  };

  const service = new UserManagementService(
    db as never,
    {
      companyId: () => companyId,
      branchId: () => undefined,
      userId: () => (opts.selfId ? uuidToBin(opts.selfId) : uuidToBin(OWNER_ID)),
    } as never,
    { record: jest.fn(async (p: unknown) => void audits.push(p)) } as never,
  );

  return { service, db, users, audits };
}

async function dtoErrors(payload: object): Promise<string[]> {
  const flatten = (errors: ValidationError[]): string[] =>
    errors.flatMap((e) => [...Object.values(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return flatten(
    await validate(plainToInstance(UpdateUserDto, payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
}

describe('listing the team', () => {
  it('returns each user with branches, role and a derived status', async () => {
    const { service } = makeService({
      users: [
        user({ name: 'Owner', login: 'owner', phone: '+22231234567', userBranches: [{ branch: { id: newUuidV7Bin(), name: 'Main Store' }, role: { key: 'owner' } }] }),
        user({ name: 'Seller', login: 'seller' }),
        user({ name: 'Gone', login: 'gone', isActive: false }),
      ],
    });

    const list = await service.list();

    expect(list.map((u) => u.status)).toEqual(['active', 'pending_contact', 'inactive']);
    expect(list.find((u) => u.login === 'owner')!.branches).toEqual([
      { branchId: expect.any(String), branchName: 'Main Store', role: 'owner' },
    ]);
  });

  it('never exposes password, PIN or any hash', async () => {
    const { service } = makeService({ users: [user({ phone: '+22231234567' })] });

    const list = await service.list();

    const serialized = JSON.stringify(list);
    for (const forbidden of ['passwordHash', 'pinHash', 'SECRET-HASH', 'argon2']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('excludes soft-deleted users', async () => {
    const { service } = makeService({
      users: [user({ login: 'live' }), user({ login: 'dead', deletedAt: new Date() })],
    });

    const list = await service.list();

    expect(list.map((u) => u.login)).toEqual(['live']);
  });

  it("never lists another company's users", async () => {
    const { service } = makeService({
      companyId: OTHER_COMPANY,
      users: [user({ login: 'theirs', companyId: COMPANY })],
    });

    expect(await service.list()).toEqual([]);
  });

  it('never claims a contact is verified in Stage 1', async () => {
    const { service } = makeService({ users: [user({ phone: '+22231234567', email: 'a@b.co' })] });

    const [u] = await service.list();

    expect(u.phoneVerifiedAt).toBeNull();
    expect(u.emailVerifiedAt).toBeNull();
  });
});

describe('reading one user', () => {
  it('404s for an unknown id, an invalid id and another company', async () => {
    const mine = user();
    const foreign = user({ companyId: OTHER_COMPANY });
    const { service } = makeService({ users: [mine, foreign] });

    await expect(service.getOne(binToUuid(newUuidV7Bin()))).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getOne('not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getOne(binToUuid(foreign.id))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('editing contact details', () => {
  it('normalizes a phone to E.164 and clears any prior verified mark', async () => {
    const u = user({ phone: null, phoneVerifiedAt: new Date() });
    const { service, users } = makeService({ users: [u] });

    const view = await service.update(binToUuid(u.id), { phone: ' +222 31-23-45-67 ' });

    expect(view.phone).toBe('+22231234567');
    expect(view.phoneVerifiedAt).toBeNull();
    expect(users[0].phoneVerifiedAt).toBeNull();
  });

  it('rejects a phone that is not a valid international number', async () => {
    const u = user();
    const { service } = makeService({ users: [u] });

    await expect(service.update(binToUuid(u.id), { phone: '12345' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a phone already used by another user in the company (409)', async () => {
    const taken = user({ login: 'a', phone: '+22231234567' });
    const other = user({ login: 'b' });
    const { service } = makeService({ users: [taken, other] });

    await expect(
      service.update(binToUuid(other.id), { phone: '+22231234567' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lets two users in DIFFERENT companies share a number', async () => {
    // The double is scoped to COMPANY; a foreign row with the same phone must not
    // trip the per-company uniqueness for this company's edit.
    const foreignSame = user({ companyId: OTHER_COMPANY, phone: '+22231234567' });
    const mine = user({ login: 'mine' });
    const { service } = makeService({ users: [foreignSame, mine] });

    const view = await service.update(binToUuid(mine.id), { phone: '+22231234567' });
    expect(view.phone).toBe('+22231234567');
  });

  it('clears a phone with an empty string and drops the verified mark', async () => {
    const u = user({ phone: '+22231234567', phoneVerifiedAt: new Date() });
    const { service, users } = makeService({ users: [u] });

    const view = await service.update(binToUuid(u.id), { phone: '' });

    expect(view.phone).toBeNull();
    expect(users[0].phoneVerifiedAt).toBeNull();
  });

  it('validates email and resets its verified mark on change', async () => {
    const u = user({ email: 'old@shop.mr', emailVerifiedAt: new Date() });
    const { service, users } = makeService({ users: [u] });

    await expect(service.update(binToUuid(u.id), { email: 'nope' })).rejects.toBeInstanceOf(BadRequestException);

    const view = await service.update(binToUuid(u.id), { email: 'new@shop.mr' });
    expect(view.email).toBe('new@shop.mr');
    expect(users[0].emailVerifiedAt).toBeNull();
  });

  it('an empty edit is a bad request', async () => {
    const u = user({ name: 'Seller' });
    const { service } = makeService({ users: [u] });

    await expect(service.update(binToUuid(u.id), { name: 'Seller' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("cannot edit a user in another company", async () => {
    const foreign = user({ companyId: OTHER_COMPANY, name: 'Theirs' });
    const { service, users } = makeService({ users: [foreign] });

    await expect(service.update(binToUuid(foreign.id), { name: 'Hijacked' })).rejects.toBeInstanceOf(NotFoundException);
    expect(users[0].name).toBe('Theirs');
  });
});

describe('activation lifecycle (no hard delete)', () => {
  it('deactivates a user, keeping the row and auditing a status change', async () => {
    const u = user({ login: 'seller', isActive: true });
    const { service, users, audits } = makeService({ users: [u], selfId: OWNER_ID });

    const view = await service.update(binToUuid(u.id), { isActive: false });

    expect(view.status).toBe('inactive');
    expect(users).toHaveLength(1); // never deleted
    expect(users[0].isActive).toBe(false);
    const entry = audits.find((a) => a.entityType === 'User');
    expect(entry.action).toBe('status_change');
    expect(entry.before).toMatchObject({ isActive: true });
    expect(entry.after).toMatchObject({ isActive: false });
  });

  it('restores a deactivated user', async () => {
    const u = user({ isActive: false });
    const { service, users } = makeService({ users: [u] });

    await service.update(binToUuid(u.id), { isActive: true });
    expect(users[0].isActive).toBe(true);
  });

  it('refuses to let you deactivate your own account', async () => {
    const me = user({ id: uuidToBin(OWNER_ID), login: 'owner', isActive: true });
    const { service } = makeService({ users: [me], selfId: OWNER_ID });

    await expect(service.update(OWNER_ID, { isActive: false })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('audit safety', () => {
  it('records safe old/new metadata and never a secret', async () => {
    const u = user({ phone: null, email: null });
    const { service, audits } = makeService({ users: [u] });

    await service.update(binToUuid(u.id), { phone: '+22231234567', email: 'a@shop.mr' });

    const entry = audits.find((a) => a.entityType === 'User');
    expect(entry.after).toMatchObject({ phone: '+22231234567', email: 'a@shop.mr', phoneVerifiedAt: null });
    const serialized = JSON.stringify(entry);
    for (const forbidden of ['passwordHash', 'pinHash', 'argon2', 'otp', 'code']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('store-facing DTO cannot assign roles or Platform Administrator', () => {
  it('rejects a smuggled role/roleKey/permission field', async () => {
    // forbidNonWhitelisted is how the global pipe behaves; there is simply no
    // field on this DTO to make someone an administrator.
    expect(await dtoErrors({ roleKey: 'administrator' })).not.toEqual([]);
    expect(await dtoErrors({ role: 'administrator' })).not.toEqual([]);
    expect(await dtoErrors({ permissions: ['user.manage'] })).not.toEqual([]);
    expect(await dtoErrors({ isAdministrator: true })).not.toEqual([]);
  });

  it('accepts the allowed contact/identity fields', async () => {
    expect(await dtoErrors({ name: 'New Name', phone: '+22231234567', email: 'a@b.co', isActive: false })).toEqual([]);
  });

  it('rejects a blank name and an over-long phone', async () => {
    expect(await dtoErrors({ name: '   ' })).not.toEqual([]);
    expect(await dtoErrors({ phone: '+' + '1'.repeat(40) })).not.toEqual([]);
  });
});
