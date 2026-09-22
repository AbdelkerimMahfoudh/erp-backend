import { createHash } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OwnerInvitationService, OWNER_INVITATION_TTL_HOURS } from './owner-invitation.service';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';

/**
 * An Owner's first password, without anybody ever typing one for them.
 *
 * What is pinned: the token is stored only as a hash and never reaches the
 * audit trail; it is spent once; a new one revokes the old; and every refusal
 * reads the same, so the public route cannot be used to find live ones.
 */

const COMPANY = '018f0000-0000-7000-8000-00000000c001';
const COMPANY_ID = uuidToBin(COMPANY);
const OWNER_ID = uuidToBin('018f0000-0000-7000-8000-00000000a001');
const ADMIN = { id: newUuidV7Bin(), email: 'ops@example.test', name: 'Ops' };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function makeWorld(opts: { ownerActive?: boolean } = {}) {
  const users: any[] = [
    {
      id: OWNER_ID,
      companyId: COMPANY_ID,
      name: 'Amina',
      email: 'amina@example.test',
      phone: null,
      isActive: opts.ownerActive ?? true,
      deletedAt: null,
      passwordHash: 'argon2:nobody-knows-this',
    },
  ];
  const invitations: any[] = [];
  const audits: any[] = [];
  const revoked: Buffer[] = [];

  const rowMatches = (row: any, where: any) =>
    (where.id === undefined || row.id.equals(where.id)) &&
    (where.companyId === undefined || row.companyId.equals(where.companyId)) &&
    (!('acceptedAt' in where) || row.acceptedAt === where.acceptedAt) &&
    (!('revokedAt' in where) || row.revokedAt === where.revokedAt);

  const prisma = {
    company: {
      findUnique: async ({ where }: any) =>
        where.id.equals(COMPANY_ID) ? { id: COMPANY_ID, name: 'Shop', publicStoreId: 'ABCDEF1234' } : null,
    },
    user: {
      findFirst: async ({ where }: any) =>
        users.find((u) => u.companyId.equals(where.companyId) && u.deletedAt === null) ?? null,
      update: async ({ where, data }: any) => {
        const u = users.find((x) => x.id.equals(where.id));
        Object.assign(u, data);
        return u;
      },
    },
    ownerInvitation: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of invitations) {
          if (rowMatches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
      create: async ({ data }: any) => {
        invitations.push({ ...data, acceptedAt: null, revokedAt: null });
        return data;
      },
      findFirst: async ({ where }: any) => {
        const row = invitations.find(
          (i) =>
            i.tokenHash === where.tokenHash &&
            i.acceptedAt === null &&
            i.revokedAt === null &&
            i.expiresAt > where.expiresAt.gt,
        );
        if (!row) return null;
        const u = users.find((x) => x.id.equals(row.userId));
        return {
          id: row.id,
          companyId: row.companyId,
          userId: row.userId,
          user: { isActive: u.isActive, deletedAt: u.deletedAt },
          company: { name: 'Shop', publicStoreId: 'ABCDEF1234' },
        };
      },
    },
  };
  const hashing = { hash: async (plain: string) => `argon2:${plain}` };
  const sessions = {
    revokeAll: async (userId: Buffer) => {
      revoked.push(userId);
      return 0;
    },
  };
  const audit = {
    record: async (e: unknown) => {
      audits.push(e);
    },
  };
  const service = new OwnerInvitationService(prisma as never, hashing as never, sessions as never, audit as never);
  return { service, users, invitations, audits, revoked };
}

describe('issuing an invitation', () => {
  it('returns the token once and stores only its hash', async () => {
    const { service, invitations, audits } = makeWorld();
    const issued = await service.issue(COMPANY, { admin: ADMIN, reason: 'Created at the counter' });

    expect(issued.token.length).toBeGreaterThanOrEqual(32);
    expect(issued.delivery).toBe('manual');
    expect(issued.owner).toEqual({ name: 'Amina', destinationMasked: 'am***@example.test' });
    expect(issued.expiresAt.getTime() - Date.now()).toBeGreaterThan((OWNER_INVITATION_TTL_HOURS - 1) * 3_600_000);

    expect(invitations).toHaveLength(1);
    expect(invitations[0].tokenHash).toBe(sha256(issued.token));
    expect(JSON.stringify(invitations)).not.toContain(issued.token);
    expect(JSON.stringify(audits)).not.toContain(issued.token);
    expect(audits[0]).toMatchObject({
      action: 'owner_invitation.issue',
      reason: 'Created at the counter',
      after: { owner: 'Amina', delivery: 'manual', replaced: 0 },
    });
  });

  it('a new one revokes every unspent one, so "I lost it" leaves no loose keys', async () => {
    const { service, invitations } = makeWorld();
    const first = await service.issue(COMPANY, { admin: ADMIN });
    const second = await service.issue(COMPANY, { admin: ADMIN });

    expect(second.replaced).toBe(1);
    expect(invitations[0].revokedAt).toBeInstanceOf(Date);
    expect(invitations[1].revokedAt).toBeNull();
    await expect(service.accept(first.token, 'NewPassw0rd!', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an unknown or malformed business, and one with no active Owner', async () => {
    const { service } = makeWorld();
    await expect(service.issue('not-a-uuid', { admin: ADMIN })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.issue('018f0000-0000-7000-8000-00000000c999', { admin: ADMIN }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const inactive = makeWorld({ ownerActive: false });
    await expect(inactive.service.issue(COMPANY, { admin: ADMIN })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('accepting an invitation', () => {
  it('sets the password, spends the key, cuts old sessions, and says who did it', async () => {
    const { service, users, invitations, revoked, audits } = makeWorld();
    const issued = await service.issue(COMPANY, { admin: ADMIN });

    const out = await service.accept(issued.token, 'NewPassw0rd!', { ip: '10.0.0.5' });
    expect(out).toEqual({ publicStoreId: 'ABCDEF1234', businessName: 'Shop' });
    expect(users[0].passwordHash).toBe('argon2:NewPassw0rd!');
    expect(invitations[0].acceptedAt).toBeInstanceOf(Date);
    expect(revoked.map((b) => binToUuid(b))).toEqual([binToUuid(OWNER_ID)]);
    expect(audits[1]).toMatchObject({
      admin: null,
      actor: `owner:${binToUuid(OWNER_ID)}`,
      action: 'owner_invitation.accept',
      ip: '10.0.0.5',
    });
  });

  it('works exactly once', async () => {
    const { service, users } = makeWorld();
    const issued = await service.issue(COMPANY, { admin: ADMIN });
    await service.accept(issued.token, 'NewPassw0rd!', {});
    await expect(service.accept(issued.token, 'Another0ne!', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(users[0].passwordHash).toBe('argon2:NewPassw0rd!');
  });

  it('refuses the unknown, the expired and the deactivated with one and the same answer', async () => {
    const { service, invitations } = makeWorld();
    const issued = await service.issue(COMPANY, { admin: ADMIN });
    const message = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (e as Error).message);

    const unknown = await message(service.accept('definitely-not-a-token-anyone-issued', 'NewPassw0rd!', {}));
    const empty = await message(service.accept('', 'NewPassw0rd!', {}));
    invitations[0].expiresAt = new Date(Date.now() - 1000);
    const expired = await message(service.accept(issued.token, 'NewPassw0rd!', {}));

    const inactive = makeWorld({ ownerActive: false });
    // Issued while active, then the Owner was deactivated.
    inactive.users[0].isActive = true;
    const theirs = await inactive.service.issue(COMPANY, { admin: ADMIN });
    inactive.users[0].isActive = false;
    const deactivated = await message(inactive.service.accept(theirs.token, 'NewPassw0rd!', {}));

    expect(new Set([unknown, empty, expired, deactivated]).size).toBe(1);
    expect(unknown).toMatch(/cannot be used/);
  });

  it('holds the Owner to the same password minimum registration does', async () => {
    const { service, invitations } = makeWorld();
    const issued = await service.issue(COMPANY, { admin: ADMIN });
    await expect(service.accept(issued.token, 'short', {})).rejects.toBeInstanceOf(BadRequestException);
    // The key is not spent by a refused password.
    expect(invitations[0].acceptedAt).toBeNull();
  });
});
