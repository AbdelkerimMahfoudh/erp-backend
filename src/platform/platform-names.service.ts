import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { bilingual } from '../common/bilingual-name';
import { isUuid, uuidToBin } from '../common/utils/uuid.util';
import { PlatformAuditService } from './platform-audit.service';
import type { PlatformAdminIdentity } from './platform-admin.service';

export interface NamesInput {
  name?: string;
  nameAr?: string;
}

type Named = { name: string; nameAr: string | null };

function changes(before: Named, input: NamesInput): Partial<Named> {
  const data: Partial<Named> = {};
  if (input.name !== undefined && input.name !== before.name) data.name = input.name;
  if (input.nameAr !== undefined && input.nameAr !== before.nameAr) data.nameAr = input.nameAr;
  return data;
}

const pick = (row: Named, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k as keyof Named]]));

/**
 * The console's edit of a business's, a store's or a person's two names (D225) — the completion of the records
 * created before 0111, and corrections. Each name on its own; every change in the platform audit with what it was.
 * A sale's receipt keeps the names it was issued under (`sales.*_name_snapshot`).
 */
@Injectable()
export class PlatformNamesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  private companyId(id: string): Buffer {
    if (!isUuid(id)) throw new NotFoundException('Business not found');
    return uuidToBin(id);
  }

  async renameBusiness(id: string, input: NamesInput, ctx: { admin: PlatformAdminIdentity; ip?: string | null; reason: string }) {
    const companyId = this.companyId(id);
    const before = await this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true, nameAr: true } });
    if (!before) throw new NotFoundException('Business not found');
    const data = changes(before, input);
    const keys = Object.keys(data);
    if (keys.length === 0) throw new BadRequestException('No changes were provided');
    const was = pick(before, keys);
    const after = await this.prisma.company.update({ where: { id: companyId }, data, select: { name: true, nameAr: true } });
    await this.audit.record({
      admin: ctx.admin,
      action: 'business.rename',
      targetType: 'Company',
      targetId: companyId,
      targetLabel: after.name,
      reason: ctx.reason,
      before: was,
      after: pick(after, keys),
      ip: ctx.ip ?? null,
    });
    return bilingual(after);
  }

  async renameStore(id: string, storeId: string, input: NamesInput, ctx: { admin: PlatformAdminIdentity; ip?: string | null; reason: string }) {
    const companyId = this.companyId(id);
    if (!isUuid(storeId)) throw new NotFoundException('Store not found');
    const branchId = uuidToBin(storeId);
    // The store must be THIS business's: an id from another business answers as one that does not exist.
    const before = await this.prisma.branch.findFirst({ where: { id: branchId, companyId }, select: { name: true, nameAr: true } });
    if (!before) throw new NotFoundException('Store not found');
    const data = changes(before, input);
    const keys = Object.keys(data);
    if (keys.length === 0) throw new BadRequestException('No changes were provided');
    const was = pick(before, keys);
    const after = await this.prisma.branch.update({ where: { id: branchId }, data, select: { name: true, nameAr: true } });
    await this.audit.record({
      admin: ctx.admin,
      action: 'store.rename',
      targetType: 'Branch',
      targetId: branchId,
      targetLabel: after.name,
      reason: ctx.reason,
      before: was,
      after: pick(after, keys),
      ip: ctx.ip ?? null,
    });
    return { id: storeId, ...bilingual(after) };
  }

  async renamePerson(id: string, userId: string, input: NamesInput, ctx: { admin: PlatformAdminIdentity; ip?: string | null; reason: string }) {
    const companyId = this.companyId(id);
    if (!isUuid(userId)) throw new NotFoundException('Account not found');
    const target = uuidToBin(userId);
    const before = await this.prisma.user.findFirst({
      where: { id: target, companyId, deletedAt: null },
      select: { name: true, nameAr: true },
    });
    if (!before) throw new NotFoundException('Account not found');
    const data = changes(before, input);
    const keys = Object.keys(data);
    if (keys.length === 0) throw new BadRequestException('No changes were provided');
    const was = pick(before, keys);
    const after = await this.prisma.user.update({ where: { id: target }, data, select: { name: true, nameAr: true } });
    await this.audit.record({
      admin: ctx.admin,
      action: 'account.rename',
      targetType: 'User',
      targetId: target,
      targetLabel: after.name,
      reason: ctx.reason,
      before: was,
      after: pick(after, keys),
      ip: ctx.ip ?? null,
    });
    return { id: userId, ...bilingual(after) };
  }
}
