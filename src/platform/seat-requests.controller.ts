import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { uuidToBin, isUuid } from '../common/utils/uuid.util';
import { PlatformAdminGuard, type AdminRequest } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';
import { BillingService, ESTIMATE_MAX_STORES } from '../billing/billing.service';
import { SeatAllocationService } from './seat-allocation.service';
import { StaffActivationService } from './staff-activation.service';

const PUBLIC_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

class QuoteDto {
  /** Non-Owner employees at each store. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ESTIMATE_MAX_STORES)
  @IsInt({ each: true })
  @Min(0, { each: true })
  stores: number[];
}

class SeatRequestDto {
  @IsUUID() branchId: string;
}

class StoreRequestDto {
  @IsString() @MinLength(1) @MaxLength(160) name: string;
}

class ConfirmSeatPaymentDto {
  /** Decimal string, MRU. */
  @IsString() @MinLength(1) @MaxLength(20) amount: string;
  @IsISO8601() paidAt: string;
  @IsOptional() @IsIn(['manual', 'bank_transfer', 'mobile_money']) channel?:
    | 'manual'
    | 'bank_transfer'
    | 'mobile_money';
  /** Required by the service, which answers `reference_required` — a code the website can name, unlike a validation message. */
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsInt() expectedVersion?: number;
  /** Step-up. High-impact actions do not run on a warm session alone. */
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class SeatReasonDto {
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
  @IsOptional() @IsInt() expectedVersion?: number;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

function idOf(value: string, what: string): Buffer {
  if (!isUuid(value)) throw new BadRequestException(`Unknown ${what}`);
  return uuidToBin(value);
}

/**
 * Seats and stores beyond the included ones, and the price list (docs/21,
 * 2026-10-05; docs/68).
 *
 * Three audiences, the same separation `PlatformController` keeps:
 *
 *  - **anybody**: the plan in force and a stateless estimate — prices, never a
 *    business;
 *  - **the Owner**, on their tenant session: their own requests, asking for a
 *    seat or a store, withdrawing an unpaid request;
 *  - **a platform administrator**, on the cookie realm with step-up: the queue,
 *    confirming a payment with a reference, refusing, releasing.
 *
 * No route here takes an amount from a customer. The Owner asks; the server
 * prices; an administrator confirms what was actually paid.
 */
@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class SeatRequestsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly admins: PlatformAdminService,
    private readonly billing: BillingService,
    private readonly allocations: SeatAllocationService,
    private readonly activation: StaffActivationService,
  ) {}

  // ── Public: the price list ───────────────────────────────────────────────

  @Public()
  @Throttle(PUBLIC_THROTTLE)
  @Get('plan')
  plan() {
    return this.billing.publicPlan();
  }

  @Public()
  @Throttle(PUBLIC_THROTTLE)
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  quote(@Body() dto: QuoteDto) {
    return this.billing.estimate(dto.stores);
  }

  // ── The Owner's own requests ─────────────────────────────────────────────

  @Get('my-subscription/seat-requests')
  @RequirePermissions('settings.manage')
  mySeatRequests() {
    return this.allocations.listForCompany(this.tenant.companyId());
  }

  @Post('my-subscription/seat-requests')
  @RequirePermissions('settings.manage')
  @HttpCode(HttpStatus.CREATED)
  async requestSeat(@Body() dto: SeatRequestDto) {
    const companyId = this.tenant.companyId();
    return this.allocations.requestSeat(companyId, {
      branchId: uuidToBin(dto.branchId),
      requestedBy: await this.actorLabel(),
    });
  }

  @Post('my-subscription/store-requests')
  @RequirePermissions('settings.manage')
  @HttpCode(HttpStatus.CREATED)
  async requestStore(@Body() dto: StoreRequestDto) {
    const companyId = this.tenant.companyId();
    return this.allocations.requestStore(companyId, {
      name: dto.name,
      requestedBy: await this.actorLabel(),
    });
  }

  @Post('my-subscription/seat-requests/:rid/withdraw')
  @RequirePermissions('settings.manage')
  @HttpCode(HttpStatus.OK)
  async withdrawSeatRequest(@Param('rid') rid: string) {
    const companyId = this.tenant.companyId();
    return this.allocations.withdraw(companyId, idOf(rid, 'request'), await this.actorLabel());
  }

  private async actorLabel(): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: this.tenant.requireUserId() },
      select: { name: true, email: true, phone: true },
    });
    return user.email ?? user.phone ?? user.name;
  }

  // ── Administrators ───────────────────────────────────────────────────────

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('seat-requests')
  seatRequests(@Query('status') status?: string) {
    const allowed = ['pending_payment', 'paid', 'granted', 'released', 'refused'] as const;
    const wanted = allowed.find((s) => s === status) ?? 'pending_payment';
    return this.allocations.queue(wanted);
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('businesses/:id/seat-requests')
  businessSeatRequests(@Param('id') id: string) {
    return this.allocations.listForCompany(idOf(id, 'business'));
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/seat-requests/:rid/confirm-payment')
  @HttpCode(HttpStatus.OK)
  async confirmSeatPayment(
    @Param('id') id: string,
    @Param('rid') rid: string,
    @Body() dto: ConfirmSeatPaymentDto,
    @Req() req: AdminRequest,
  ) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    const companyId = idOf(id, 'business');
    const allocationId = idOf(rid, 'request');
    await this.assertBelongs(companyId, allocationId);

    const result = await this.allocations.confirmPayment(
      allocationId,
      {
        amount: dto.amount,
        paidAt: new Date(dto.paidAt),
        channel: dto.channel,
        reference: dto.reference ?? '',
        note: dto.note,
        expectedVersion: dto.expectedVersion,
      },
      { admin, ip: req.ip ?? null },
    );

    // A paid seat activates nobody by itself: the person must also have proven
    // their contacts. The server checks both, here, and says what is left.
    const activation = result.allocation.person
      ? await this.activation.tryActivate(uuidToBin(result.allocation.person.id), admin.email)
      : null;
    return { ...result, activation };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/seat-requests/:rid/refuse')
  @HttpCode(HttpStatus.OK)
  async refuseSeatRequest(
    @Param('id') id: string,
    @Param('rid') rid: string,
    @Body() dto: SeatReasonDto,
    @Req() req: AdminRequest,
  ) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    const allocationId = idOf(rid, 'request');
    await this.assertBelongs(idOf(id, 'business'), allocationId);
    return this.allocations.refuse(
      allocationId,
      { reason: dto.reason, expectedVersion: dto.expectedVersion },
      { admin, ip: req.ip ?? null },
    );
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/seat-requests/:rid/release')
  @HttpCode(HttpStatus.OK)
  async releaseSeat(
    @Param('id') id: string,
    @Param('rid') rid: string,
    @Body() dto: SeatReasonDto,
    @Req() req: AdminRequest,
  ) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    const allocationId = idOf(rid, 'request');
    await this.assertBelongs(idOf(id, 'business'), allocationId);
    return this.allocations.release(
      allocationId,
      { reason: dto.reason, expectedVersion: dto.expectedVersion },
      { admin, ip: req.ip ?? null },
    );
  }

  /** The request in the path must belong to the business in the path, or the path is lying. */
  private async assertBelongs(companyId: Buffer, allocationId: Buffer): Promise<void> {
    const row = await this.prisma.seatAllocation.findUnique({
      where: { id: allocationId },
      select: { companyId: true },
    });
    if (!row || !row.companyId.equals(companyId)) throw new BadRequestException('Unknown request');
  }
}
