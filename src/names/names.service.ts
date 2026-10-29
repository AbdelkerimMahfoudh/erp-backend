import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { bilingual } from '../common/bilingual-name';
import { binToUuid, isUuid, uuidToBin } from '../common/utils/uuid.util';
import type { UpdateNamesDto } from './dto/update-names.dto';

type Named = { name: string; nameAr: string | null };

/** What changed between two names, for the update and its audit; nothing when nothing did. */
function changes(before: Named, dto: UpdateNamesDto): Partial<Named> {
  const data: Partial<Named> = {};
  if (dto.name !== undefined && dto.name !== before.name) data.name = dto.name;
  if (dto.nameAr !== undefined && dto.nameAr !== before.nameAr) data.nameAr = dto.nameAr;
  return data;
}

function pick(row: Named, keys: string[]): Record<string, string | null> {
  return Object.fromEntries(keys.map((k) => [k, row[k as keyof Named]]));
}

/**
 * The business's and its stores' names (D225). The Owner's alone: `settings.manage` for the business, `branch.manage`
 * for a store — neither is a Store Manager's or an Employee's. People's names are edited on Team (`user.manage`).
 *
 * A rename changes what screens show from now on. A sale confirmed before it keeps the names it was sold under
 * (`sales.*_name_snapshot`), so an old receipt never starts naming a shop it was not issued by.
 */
@Injectable()
export class NamesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
  ) {}

  /** The business and every store, each with whether its Arabic name is still missing: the completion list. */
  async overview() {
    const companyId = this.tenant.companyId();
    const [company, branches] = await Promise.all([
      this.db.company.findUnique({ where: { id: companyId }, select: { name: true, nameAr: true } }),
      this.db.branch.findMany({
        where: { companyId, isActive: true },
        select: { id: true, name: true, nameAr: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    if (!company) throw new NotFoundException('Business not found');
    return {
      business: bilingual(company),
      stores: branches.map((b) => ({ id: binToUuid(b.id), ...bilingual(b) })),
    };
  }

  async renameBusiness(dto: UpdateNamesDto) {
    const companyId = this.tenant.companyId();
    const before = await this.db.company.findUnique({ where: { id: companyId }, select: { name: true, nameAr: true } });
    if (!before) throw new NotFoundException('Business not found');
    const data = changes(before, dto);
    const keys = Object.keys(data);
    if (keys.length === 0) throw new BadRequestException('No changes were provided');
    const was = pick(before, keys);
    const after = await this.db.company.update({ where: { id: companyId }, data, select: { name: true, nameAr: true } });
    await this.audit.record({
      entityType: 'Company',
      entityId: companyId,
      action: 'update',
      before: was,
      after: pick(after, keys),
    });
    return bilingual(after);
  }

  async renameStore(idStr: string, dto: UpdateNamesDto) {
    if (!isUuid(idStr)) throw new NotFoundException('Store not found');
    const id = uuidToBin(idStr);
    const companyId = this.tenant.companyId();
    const before = await this.db.branch.findFirst({ where: { id, companyId }, select: { name: true, nameAr: true } });
    if (!before) throw new NotFoundException('Store not found');
    const data = changes(before, dto);
    const keys = Object.keys(data);
    if (keys.length === 0) throw new BadRequestException('No changes were provided');
    const was = pick(before, keys);
    const after = await this.db.branch.update({ where: { id }, data, select: { name: true, nameAr: true } });
    await this.audit.record({
      entityType: 'Branch',
      entityId: id,
      branchId: id,
      action: 'update',
      before: was,
      after: pick(after, keys),
    });
    return { id: idStr, ...bilingual(after) };
  }
}
