import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { AuditService } from '../common/audit/audit.service';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TenantPrisma } from '../prisma/tenant.extension';
import { binToUuid, newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { CreateCustomerDto, ListCustomersDto } from './dto/customer.dto';

/**
 * Customers, as the till needs them (4a).
 *
 * A sale has always been able to name a customer — `sales.customerId` exists,
 * credit and partial sales REQUIRE one, and the sale list already searches by
 * customer name and phone. What was missing was any way to find or create one,
 * so the field could only ever be filled by something other than this app.
 *
 * Two operations and nothing more. Editing, merging, balances and history are
 * deliberately absent: this exists so a sale can be attributed, and every extra
 * verb here would be a customer-management feature nobody asked for.
 *
 * **Tenant isolation is structural.** Every query goes through the tenant
 * client, which injects `companyId` into the where clause and into created
 * rows, so one company's customers cannot be searched, read or created into
 * another's — there is no code path here that could forget.
 */
@Injectable()
export class CustomersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
  ) {}

  /**
   * Find a customer. Deleted rows never appear.
   *
   * Ordered by id, which is UUIDv7 and therefore time-ordered, so a keyset
   * cursor cannot skip or repeat a row when somebody is added mid-scroll.
   */
  async list(query: ListCustomersDto) {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const search = query.search?.trim();

    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      ...(query.id ? { id: uuidToBin(query.id) } : {}),
      ...(search
        ? { OR: [{ name: { contains: search } }, { phone: { contains: search } }] }
        : {}),
    };

    const rows = await this.db.customer.findMany({
      where,
      ...(query.cursor ? { cursor: { id: uuidToBin(query.cursor) }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    return {
      rows: page.map((c) => ({
        id: binToUuid(c.id),
        name: c.name,
        phone: c.phone,
        /**
         * What this customer still owes, carried on the customer row by the
         * sale flow. Returned because a till about to sell on credit needs to
         * know — it is the same number `sales.service` increments, never a
         * second calculation of it.
         */
        balance: Number(c.balance),
      })),
      nextCursor: rows.length > limit ? binToUuid(page[page.length - 1]!.id) : null,
    };
  }

  /**
   * Create a customer from the till.
   *
   * No uniqueness rule on name or phone: two real people share a name, one
   * person has two numbers, and refusing the second would stop a sale over a
   * bookkeeping preference. Duplicates are a merge problem, not a sale problem.
   */
  async create(dto: CreateCustomerDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('A customer needs a name to be found by later');

    // Passed explicitly as well as injected by the tenant client: defence in
    // depth, and the same shape every other service uses.
    const companyId = this.tenant.companyId();
    const customer = await this.db.customer.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        name,
        phone: dto.phone?.trim() || null,
        notes: dto.notes?.trim() || null,
      },
    });

    await this.audit.record({
      entityType: 'Customer',
      entityId: customer.id,
      action: 'create',
      after: { name: customer.name, phone: customer.phone },
    });

    return {
      id: binToUuid(customer.id),
      name: customer.name,
      phone: customer.phone,
      balance: Number(customer.balance),
    };
  }
}
