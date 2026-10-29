import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { REQUIRE_PERMISSIONS_KEY } from '../rbac/require-permissions.decorator';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions';
import { uuidToBin } from '../common/utils/uuid.util';
import { NamesController } from './names.controller';
import { NamesService } from './names.service';
import { UpdateNamesDto } from './dto/update-names.dto';

/**
 * A business's and its stores' two names (D225): the Owner's to edit, each language on its own, audited.
 */

const COMPANY = uuidToBin('00000000-0000-7000-8000-000000000001');
const STORE = '00000000-0000-7000-8000-000000000002';
const OTHER_COMPANY_STORE = '00000000-0000-7000-8000-000000000003';

function harness() {
  const company = { name: 'Boutique Kiffa', nameAr: null as string | null };
  const stores = new Map([[STORE, { companyId: COMPANY, name: 'Centre', nameAr: null as string | null }]]);
  stores.set(OTHER_COMPANY_STORE, { companyId: uuidToBin('00000000-0000-7000-8000-000000000009'), name: 'Theirs', nameAr: null });
  const audits: any[] = [];
  const key = (id: Buffer) => [...stores.keys()].find((k) => uuidToBin(k).equals(id));
  const db = {
    company: {
      findUnique: async () => ({ ...company }),
      update: async ({ data }: any) => Object.assign(company, data) && { ...company },
    },
    branch: {
      findMany: async () => [{ id: uuidToBin(STORE), name: stores.get(STORE)!.name, nameAr: stores.get(STORE)!.nameAr }],
      findFirst: async ({ where }: any) => {
        const k = key(where.id);
        const s = k ? stores.get(k) : undefined;
        return s && s.companyId.equals(where.companyId) ? { name: s.name, nameAr: s.nameAr } : null;
      },
      update: async ({ where, data }: any) => {
        const s = stores.get(key(where.id)!)!;
        Object.assign(s, data);
        return { name: s.name, nameAr: s.nameAr };
      },
    },
  };
  const tenant = { companyId: () => COMPANY };
  const audit = { record: jest.fn(async (p: unknown) => void audits.push(p)) };
  return { service: new NamesService(db as never, tenant as never, audit as never), company, stores, audits };
}

describe('who may rename', () => {
  const required = (method: keyof NamesController) =>
    Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, NamesController.prototype[method]) as string[];

  it('the business needs settings.manage, a store branch.manage', () => {
    expect(required('overview')).toEqual(['settings.manage']);
    expect(required('renameBusiness')).toEqual(['settings.manage']);
    expect(required('renameStore')).toEqual(['branch.manage']);
  });

  it('which the Owner holds, and a Store Manager or an Employee does not', () => {
    for (const key of ['settings.manage', 'branch.manage']) {
      expect(ROLE_PERMISSIONS.owner).toContain(key);
      expect(ROLE_PERMISSIONS.store_manager).not.toContain(key);
      expect(ROLE_PERMISSIONS.store_employee).not.toContain(key);
    }
  });
});

describe('renaming', () => {
  it('completes the Arabic name without touching the Latin one, and audits only what changed', async () => {
    const h = harness();
    const out = await h.service.renameBusiness({ nameAr: 'بوتيك كيفة' });
    expect(out).toEqual({ name: 'Boutique Kiffa', nameAr: 'بوتيك كيفة', nameIncomplete: false });
    expect(h.audits).toEqual([
      expect.objectContaining({ entityType: 'Company', action: 'update', before: { nameAr: null }, after: { nameAr: 'بوتيك كيفة' } }),
    ]);
  });

  it('edits the Latin name of a store and leaves its Arabic name', async () => {
    const h = harness();
    await h.service.renameStore(STORE, { nameAr: 'المركز' });
    const out = await h.service.renameStore(STORE, { name: 'Centre-Ville' });
    expect(out).toEqual({ id: STORE, name: 'Centre-Ville', nameAr: 'المركز', nameIncomplete: false });
    expect(h.audits[1]).toMatchObject({ entityType: 'Branch', before: { name: 'Centre' }, after: { name: 'Centre-Ville' } });
  });

  it('answers another business’s store exactly as one that does not exist', async () => {
    const h = harness();
    await expect(h.service.renameStore(OTHER_COMPANY_STORE, { name: 'Mine now' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.renameStore('not-a-uuid', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.stores.get(OTHER_COMPANY_STORE)!.name).toBe('Theirs');
    expect(h.audits).toEqual([]);
  });

  it('refuses an edit that changes nothing', async () => {
    const h = harness();
    await expect(h.service.renameBusiness({ name: 'Boutique Kiffa' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.renameBusiness({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists what is still missing an Arabic name, for the Owner to complete', async () => {
    const h = harness();
    expect(await h.service.overview()).toEqual({
      business: { name: 'Boutique Kiffa', nameAr: null, nameIncomplete: true },
      stores: [{ id: STORE, name: 'Centre', nameAr: null, nameIncomplete: true }],
    });
  });
});

describe('what the body may carry', () => {
  const errors = (body: object) => validateSync(plainToInstance(UpdateNamesDto, body)).map((e) => e.property);

  it('a real shop name in either script, digits and brands included', () => {
    expect(errors({ name: 'PS5 Center', nameAr: 'مركز PS5' })).toEqual([]);
  });

  it('refuses each name in the other’s field', () => {
    expect(errors({ name: 'مركز', nameAr: 'Center' })).toEqual(['name', 'nameAr']);
  });
});
