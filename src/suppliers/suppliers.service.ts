import { Inject, Injectable } from '@nestjs/common';
import { Supplier } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { CreateSupplierDto } from './dto/create-supplier.dto';

@Injectable()
export class SuppliersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateSupplierDto): Promise<Supplier> {
    const supplier = await this.db.supplier.create({
      data: {
        id: newUuidV7Bin(),
        companyId: this.tenant.companyId(),
        name: dto.name,
        phone: dto.phone ?? null,
        notes: dto.notes ?? null,
      },
    });
    await this.audit.record({
      entityType: 'Supplier',
      entityId: supplier.id,
      action: 'create',
      after: { name: supplier.name },
    });
    return supplier;
  }

  list(): Promise<Supplier[]> {
    return this.db.supplier.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      take: 200,
    });
  }
}
