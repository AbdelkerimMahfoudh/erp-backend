import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Inject,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../common/config/app-config.service';
import { Public } from '../common/decorators/public.decorator';
import { newUuidV7Bin, uuidToBin } from '../common/utils/uuid.util';
import { CLOCK, type Clock } from './clock';

/**
 * Platform provisioning (Milestone K).
 *
 * **This is not a tenant route.** It carries `@Public()` so the tenant JWT
 * guard does not run — and is then gated on a platform key that no tenant ever
 * holds. That is the point of the separation: a shop's Owner, however many
 * permissions they hold, has no path to extend their own subscription or grant
 * themselves free access. Entitlement is a fact about the shop decided outside
 * the shop.
 *
 * Hidden from Swagger, because the tenant-facing API documentation is not where
 * an operations endpoint belongs.
 *
 * If no platform key is configured the whole surface refuses. An unset secret
 * must never mean "no check".
 */
class ProvisionDto {
  @IsString()
  @MinLength(1)
  companyId: string;

  /** Months to extend from the later of now and the current period end. */
  @IsOptional()
  @IsInt()
  @Min(1)
  months?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  subscribedBranchCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  additionalSeats?: number;

  @IsOptional()
  @IsBoolean()
  complimentary?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  /** Who is doing this, for the append-only record. */
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  actor: string;
}

@ApiExcludeController()
@Public()
@Controller('platform/provisioning')
export class ProvisioningController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private assertPlatform(key: string | undefined): void {
    const expected = process.env.PLATFORM_ADMIN_KEY;
    // An unset secret means the surface is closed, never that it is open.
    if (!expected || expected.length < 16) {
      throw new ForbiddenException('Provisioning is not configured on this server');
    }
    if (!key || key !== expected) {
      throw new ForbiddenException('Not a platform operator');
    }
  }

  @Post()
  async provision(
    @Headers('x-platform-key') key: string | undefined,
    @Body() dto: ProvisionDto,
  ) {
    this.assertPlatform(key);

    const companyId = uuidToBin(dto.companyId);
    const existing = await this.prisma.subscription.findFirst({ where: { companyId } });
    if (!existing) throw new BadRequestException('No such company');

    const now = this.clock.now();
    const data: Record<string, unknown> = {};
    let kind = 'extended';

    if (dto.months) {
      // Extend from whichever is later, so renewing early does not shorten the
      // period a shop has already paid for.
      const from =
        existing.currentPeriodEnd && existing.currentPeriodEnd > now ? existing.currentPeriodEnd : now;
      const end = new Date(from);
      end.setMonth(end.getMonth() + dto.months);
      data.currentPeriodEnd = end;
    }
    if (dto.subscribedBranchCount !== undefined) {
      data.subscribedBranchCount = dto.subscribedBranchCount;
      kind = 'branches_changed';
    }
    if (dto.additionalSeats !== undefined) {
      data.additionalSeats = dto.additionalSeats;
      kind = 'seats_changed';
    }
    if (dto.complimentary !== undefined) {
      if (dto.complimentary && !dto.reason) {
        // A grant nobody can explain is indistinguishable from a mistake.
        throw new BadRequestException('A complimentary grant needs a reason');
      }
      data.isComplimentary = dto.complimentary;
      data.complimentaryReason = dto.complimentary ? dto.reason : null;
      if (dto.complimentary) {
        const until = new Date(now);
        until.setMonth(until.getMonth() + (dto.months ?? 1));
        data.complimentaryUntil = until;
      } else {
        data.complimentaryUntil = null;
      }
      kind = dto.complimentary ? 'complimentary_granted' : 'complimentary_revoked';
    }

    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to change');

    const updated = await this.prisma.subscription.update({
      where: { id: existing.id },
      data: { ...data, version: { increment: 1 } },
    });

    // Append-only, and enforced by triggers. The record of who granted what
    // survives whatever happens to the subscription row afterwards.
    await this.prisma.subscriptionEvent.create({
      data: {
        id: newUuidV7Bin(),
        companyId,
        subscriptionId: existing.id,
        kind,
        note: dto.reason ?? null,
        periodEndAfter: updated.currentPeriodEnd,
        branchesAfter: updated.subscribedBranchCount,
        seatsAfter: updated.additionalSeats,
        actor: dto.actor,
      },
    });

    return {
      companyId: dto.companyId,
      periodEnd: updated.currentPeriodEnd,
      subscribedBranchCount: updated.subscribedBranchCount,
      additionalSeats: updated.additionalSeats,
      isComplimentary: updated.isComplimentary,
    };
  }
}
