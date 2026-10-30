import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { MissingTenantContextError, TenantPrisma } from '../prisma/tenant.extension';
import { AppClsStore } from '../common/context/request-context';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { NotificationChannel, NotificationInput } from './notification-channel';

/**
 * In-app channel: persists a row in `notifications`. Tenant CREATEs pass
 * `companyId` explicitly from the request context (the tenant extension also
 * re-injects it as a safety net); reads are auto-scoped by the extension.
 */
@Injectable()
export class InAppChannel implements NotificationChannel {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrisma,
    private readonly cls: ClsService<AppClsStore>,
    private readonly prisma: PrismaService,
  ) {}

  async deliver(input: NotificationInput): Promise<void> {
    const companyId = this.cls.get('companyId');
    if (!companyId) {
      throw new MissingTenantContextError('Notification', 'create');
    }

    const data = {
      id: newUuidV7Bin(),
      branchId: input.branchId ?? null,
      targetUserId: input.targetUserId ?? null,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      actionLink: input.actionLink ?? null,
      actorUserId: input.actorUserId ?? null,
      ...(input.payload ? { payload: input.payload as Prisma.InputJsonValue } : {}),
    };
    // The other business of a loan or a consignment: its own row, in its own business.
    if (input.companyId && !input.companyId.equals(companyId)) {
      await this.prisma.notification.create({ data: { ...data, companyId: input.companyId } });
      return;
    }
    await this.db.notification.create({ data: { ...data, companyId } });
  }
}
