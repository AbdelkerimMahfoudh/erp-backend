import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { uuidToBin } from '../common/utils/uuid.util';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformNamesController } from './platform-names.controller';
import { PlatformNamesService } from './platform-names.service';

/**
 * The console completes and corrects names (D225): a business's, a store's, a person's — each language on its own,
 * every change in the platform audit, and nothing reached across businesses.
 */

const BUSINESS = '00000000-0000-7000-8000-000000000001';
const OTHER = '00000000-0000-7000-8000-000000000009';
const STORE = '00000000-0000-7000-8000-000000000002';
const PERSON = '00000000-0000-7000-8000-000000000003';
const admin = { id: uuidToBin('00000000-0000-7000-8000-0000000000aa'), email: 'ops@example.test' } as never;

function harness() {
  const rows = {
    company: new Map([[BUSINESS, { name: 'Boutique Kiffa', nameAr: null as string | null }]]),
    branch: new Map([[STORE, { companyId: BUSINESS, name: 'Centre', nameAr: null as string | null }]]),
    user: new Map([[PERSON, { companyId: BUSINESS, name: 'Aminetou', nameAr: null as string | null, deletedAt: null }]]),
  };
  const hex = (b: Buffer) => b.toString('hex');
  const find = <T,>(map: Map<string, T>, id: Buffer) => [...map.entries()].find(([k]) => hex(uuidToBin(k)) === hex(id));
  const audits: any[] = [];
  const prisma = {
    company: {
      findUnique: async ({ where }: any) => find(rows.company, where.id)?.[1] ?? null,
      update: async ({ where, data }: any) => Object.assign(find(rows.company, where.id)![1], data),
    },
    branch: {
      findFirst: async ({ where }: any) => {
        const hit = find(rows.branch, where.id)?.[1];
        return hit && hex(uuidToBin(hit.companyId)) === hex(where.companyId) ? hit : null;
      },
      update: async ({ where, data }: any) => Object.assign(find(rows.branch, where.id)![1], data),
    },
    user: {
      findFirst: async ({ where }: any) => {
        const hit = find(rows.user, where.id)?.[1];
        return hit && hex(uuidToBin(hit.companyId)) === hex(where.companyId) && hit.deletedAt === null ? hit : null;
      },
      update: async ({ where, data }: any) => Object.assign(find(rows.user, where.id)![1], data),
    },
  };
  const audit = { record: async (input: unknown) => void audits.push(input) };
  return { service: new PlatformNamesService(prisma as never, audit as never), rows, audits };
}

const ctx = { admin, ip: '203.0.113.7', reason: 'Owner gave the Arabic names by phone' };

describe('the console’s name edits', () => {
  it('are behind the administrator guard', () => {
    for (const method of ['business', 'store', 'person'] as const) {
      expect(Reflect.getMetadata(GUARDS_METADATA, PlatformNamesController.prototype[method])).toContain(PlatformAdminGuard);
    }
  });

  it('complete an Arabic name, leave the Latin one, and audit what it was', async () => {
    const h = harness();
    expect(await h.service.renameBusiness(BUSINESS, { nameAr: 'بوتيك كيفة' }, ctx)).toEqual({
      name: 'Boutique Kiffa',
      nameAr: 'بوتيك كيفة',
      nameIncomplete: false,
    });
    expect(h.audits[0]).toMatchObject({
      action: 'business.rename',
      reason: ctx.reason,
      before: { nameAr: null },
      after: { nameAr: 'بوتيك كيفة' },
    });
  });

  it('rename a store and a person of that business', async () => {
    const h = harness();
    await h.service.renameStore(BUSINESS, STORE, { name: 'Centre-Ville', nameAr: 'وسط المدينة' }, ctx);
    await h.service.renamePerson(BUSINESS, PERSON, { nameAr: 'أمينتو' }, ctx);
    expect(h.rows.branch.get(STORE)).toMatchObject({ name: 'Centre-Ville', nameAr: 'وسط المدينة' });
    expect(h.rows.user.get(PERSON)).toMatchObject({ name: 'Aminetou', nameAr: 'أمينتو' });
    expect(h.audits.map((a) => a.action)).toEqual(['store.rename', 'account.rename']);
  });

  it('never reach a store or a person through another business', async () => {
    const h = harness();
    await expect(h.service.renameStore(OTHER, STORE, { name: 'X' }, ctx)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.renamePerson(OTHER, PERSON, { name: 'X' }, ctx)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.audits).toEqual([]);
  });

  it('refuse an edit that changes nothing', async () => {
    const h = harness();
    await expect(h.service.renameBusiness(BUSINESS, { name: 'Boutique Kiffa' }, ctx)).rejects.toBeInstanceOf(BadRequestException);
  });
});
