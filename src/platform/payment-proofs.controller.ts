import { BadRequestException, Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/types/auth-user';
import { uuidToBin } from '../common/utils/uuid.util';
import { uploadLimits } from '../common/upload/upload-limits';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { PlatformAdminGuard, type AdminRequest } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';
import { MAX_PROOF_BYTES, PaymentProofsService } from './payment-proofs.service';

export class RefuseProofDto {
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class ProofRecoveryDto {
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsOptional() @IsBoolean() closeWithoutPeriod?: boolean;
}

export class ApproveProofDto {
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsString() @MaxLength(20) amount!: string;
  @IsString() paidAt!: string;
  @IsOptional() @IsIn(['manual', 'bank_transfer', 'mobile_money']) channel?: 'manual' | 'bank_transfer' | 'mobile_money';
  @Type(() => Number) @IsInt() @Min(1) @Max(60) months!: number;
}

/** The Owner's proof on the web portal, and the administrator's decision on it (D227). */
@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class PaymentProofsController {
  constructor(
    private readonly proofs: PaymentProofsService,
    private readonly tenant: TenantContext,
    private readonly admins: PlatformAdminService,
  ) {}

  /** The portal's plans for this business (owner, 2026-11-05): 1, 3 and 12 months, per store, computed here. */
  @Get('my-subscription/plans')
  @RequirePermissions('settings.manage')
  async plans() {
    const companyId = this.tenant.companyId();
    return { plans: await Promise.all(([1, 3, 12] as const).map((m) => this.proofs.quoteFor(companyId, m))) };
  }

  @Get('my-subscription/payment-proofs')
  @RequirePermissions('settings.manage')
  mine() {
    return this.proofs.listForCompany(this.tenant.companyId());
  }

  @Post('my-subscription/payment-proofs')
  @RequirePermissions('settings.manage')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(MAX_PROOF_BYTES) }))
  submit(
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body() body: { idempotencyKey?: string; amount?: string; paidAt?: string; months?: string; reference?: string; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    // A plan (1, 3 or 12 months, owner 2026-11-05) prices itself on the server; otherwise the amount and date are stated.
    const months = body?.months !== undefined && body.months !== '' ? Number(body.months) : undefined;
    if (months === undefined && (!body?.amount || !body.paidAt)) throw new BadRequestException({ code: 'proof_fields', message: 'Enter the amount and the date paid.' });
    return this.proofs.submit(this.tenant.companyId(), file, {
      idempotencyKey: body.idempotencyKey ?? '',
      amount: body.amount,
      paidAt: body.paidAt,
      months,
      reference: body.reference,
      note: body.note,
      userId: uuidToBin(user.userId),
    });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('payment-proofs')
  list(@Query('status') status?: string) {
    return this.proofs.listForAdmin(['submitted', 'under_review', 'approved', 'refused'].includes(status ?? '') ? status : undefined);
  }

  /** Always a download with its sniffed type: never rendered on the console's origin. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('payment-proofs/:id/file')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'no-store')
  async download(
    @Param('id') id: string,
    @Req() req: AdminRequest,
    @Res() res: { setHeader(k: string, v: string): void; end(b: Buffer): void },
  ) {
    const { file, contentType } = await this.proofs.file(id, { admin: req.platformAdmin!, ip: req.ip });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'attachment; filename="payment-proof"');
    res.end(file);
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('payment-proofs/:id/review')
  @HttpCode(HttpStatus.OK)
  review(@Param('id') id: string, @Req() req: AdminRequest) {
    return this.proofs.review(id, { admin: req.platformAdmin!, ip: req.ip });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('payment-proofs/:id/refuse')
  @HttpCode(HttpStatus.OK)
  async refuse(@Param('id') id: string, @Body() dto: RefuseProofDto, @Req() req: AdminRequest) {
    await this.admins.requireStepUp(req.platformAdmin!);
    return this.proofs.refuse(id, dto.reason, { admin: req.platformAdmin!, ip: req.ip });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('payment-proofs/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(@Param('id') id: string, @Body() dto: ApproveProofDto, @Req() req: AdminRequest) {
    await this.admins.requireStepUp(req.platformAdmin!);
    return this.proofs.approve(id, dto, { admin: req.platformAdmin!, ip: req.ip });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('payment-proofs/:id/recovery')
  recovery(@Param('id') id: string) {
    return this.proofs.recovery(id);
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('payment-proofs/:id/recovery/complete')
  @HttpCode(HttpStatus.OK)
  async completeRecovery(@Param('id') id: string, @Body() dto: ProofRecoveryDto, @Req() req: AdminRequest) {
    await this.admins.requireStepUp(req.platformAdmin!);
    return this.proofs.completeRecovery(id, dto, { admin: req.platformAdmin!, ip: req.ip });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('payment-proofs/:id/recovery/release')
  @HttpCode(HttpStatus.OK)
  async releaseRecovery(@Param('id') id: string, @Body() dto: ProofRecoveryDto, @Req() req: AdminRequest) {
    await this.admins.requireStepUp(req.platformAdmin!);
    return this.proofs.releaseRecovery(id, dto.reason, { admin: req.platformAdmin!, ip: req.ip });
  }
}
