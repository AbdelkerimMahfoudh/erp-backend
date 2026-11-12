import { BadRequestException, Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/types/auth-user';
import { isUuid, uuidToBin } from '../common/utils/uuid.util';
import { BranchEntitlementService } from '../entitlement/branch-entitlement.service';
import { uploadLimits } from '../common/upload/upload-limits';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { PlatformAdminGuard, type AdminRequest } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';
import { MAX_PROOF_BYTES, PaymentProofsService } from './payment-proofs.service';
import { contentDisposition } from './proof-file';
import { isPaymentCategory, priceList } from '../billing/period-offers';

/** 0138: the revision confirmed, and what was checked on the receiving account. */
export class ConfirmProofDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RefuseProofDto {
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  /** 0135: the revision the decision was made on; a later correction by the Owner refuses it (proof_revised). */
  @Type(() => Number) @IsInt() @Min(1) revision!: number;
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
  /** 0135: the revision the decision was made on; a later correction by the Owner refuses it (proof_revised). */
  @Type(() => Number) @IsInt() @Min(1) revision!: number;
}

/** The Owner's proof on the web portal, and the administrator's decision on it (D227). */
@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class PaymentProofsController {
  constructor(
    private readonly proofs: PaymentProofsService,
    private readonly tenant: TenantContext,
    private readonly admins: PlatformAdminService,
    private readonly branchStatus: BranchEntitlementService,
  ) {}

  /** The portal's plans for this business (owner, 2026-11-05): 1, 3 and 12 months, per store, computed here. */
  @Get('my-subscription/plans')
  @RequirePermissions('settings.manage')
  async plans(@Query('branches') branches?: string, @Query('category') category?: string) {
    const companyId = this.tenant.companyId();
    // 0132: each branch is its own subscription — its state and end beside its price; `branches` narrows the quote.
    const only = branchList(branches);
    return {
      // 0134: the one price list every screen shows, and the categories a payment can be for.
      prices: priceList(),
      plans: await Promise.all(
        ([1, 3, 12] as const).map(async (m) => {
          const q = await this.proofs.quoteFor(companyId, m, only);
          // 0134: a subscription quotes the open stores, an activation the waiting ones — totals from the server.
          if (category !== 'subscription' && category !== 'store_activation') return q;
          const lines = q.lines.filter((l) => !!l.pending === (category === 'store_activation'));
          return { ...q, lines, total: lines.reduce((t, l) => t + l.amount, 0) };
        }),
      ),
      branches: await this.branchStatus.listForCompany(companyId),
    };
  }

  /** 0134: the server's price for a categorised payment the Owner is about to make (extra seats, mostly). */
  @Get('my-subscription/payment-price')
  @RequirePermissions('settings.manage')
  async price(@Query('category') category: string, @Query('months') months?: string, @Query('branches') branches?: string, @Query('seats') seats?: string) {
    if (!isPaymentCategory(category)) throw new BadRequestException({ code: 'category_invalid', message: 'Choose what this payment is for.' });
    return {
      category,
      price: await this.proofs.priceFor(this.tenant.companyId(), {
        category,
        months: months ? Number(months) : undefined,
        branches: branchList(branches),
        seats: seats ? Number(seats) : undefined,
      }),
    };
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
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Body() body: { idempotencyKey?: string; amount?: string; paidAt?: string; months?: string; branches?: string; reference?: string; note?: string; category?: string; seats?: string; payerPhone?: string; receiveService?: string; receiveNumber?: string },
    @CurrentUser() user: AuthUser,
  ) {
    // A plan (1, 3 or 12 months, owner 2026-11-05) prices itself on the server; otherwise the amount and date are stated.
    const months = body?.months !== undefined && body.months !== '' ? Number(body.months) : undefined;
    // 0134: a category prices itself too (an adjustment states its amount and date).
    if (months === undefined && body?.category !== 'other' && (!body?.amount || !body.paidAt)) throw new BadRequestException({ code: 'proof_fields', message: 'Enter the amount and the date paid.' });
    return this.proofs.submit(this.tenant.companyId(), file, {
      idempotencyKey: body.idempotencyKey ?? '',
      amount: body.amount,
      paidAt: body.paidAt,
      months,
      branches: branchList(body.branches),
      reference: body.reference,
      note: body.note,
      category: body.category,
      seats: body.seats !== undefined && body.seats !== '' ? Number(body.seats) : undefined,
      payerPhone: body.payerPhone,
      // 0138: where the Owner sent the money — a pairing the server offers.
      receiveService: body.receiveService,
      receiveNumber: body.receiveNumber,
      userId: uuidToBin(user.userId),
    });
  }

  /**
   * 0135 (owner, 2026-11-11): the Owner corrects a proof still waiting for the decision: the number paid from, the
   * screenshot, the reference. Only their own business's proof (any other id is unknown here).
   */
  @Post('my-subscription/payment-proofs/:id/correct')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('settings.manage')
  @UseInterceptors(FileInterceptor('file', { limits: uploadLimits(MAX_PROOF_BYTES) }))
  correct(
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Body() body: { payerPhone?: string; reference?: string; note?: string; revision?: string; receiveService?: string; receiveNumber?: string },
    @CurrentUser() user: AuthUser,
    @Req() req: { ip?: string },
  ) {
    const revision = body?.revision !== undefined && body.revision !== '' ? Number(body.revision) : undefined;
    return this.proofs.correct(this.tenant.companyId(), id, file, { payerPhone: body?.payerPhone, reference: body?.reference, note: body?.note, revision, receiveService: body?.receiveService, receiveNumber: body?.receiveNumber, userId: uuidToBin(user.userId) }, { ip: req.ip });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('payment-proofs')
  list(@Query('status') status?: string, @Query('company') company?: string) {
    // Owner, 2026-11-12: one business's proofs, whatever their decision — read in its payment history, without downloading.
    if (company !== undefined) {
      if (!isUuid(company)) throw new BadRequestException('Unknown business');
      return this.proofs.listForCompany(uuidToBin(company));
    }
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
    const served = await this.proofs.file(id, { admin: req.platformAdmin!, ip: req.ip });
    sendProof(res, served);
  }

  /** 0136: the Owner's own proof — the file they sent, under its name and true type; only this business's. */
  @Get('my-subscription/payment-proofs/:id/file')
  @RequirePermissions('settings.manage')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'no-store')
  async ownFile(@Param('id') id: string, @Res() res: { setHeader(k: string, v: string): void; end(b: Buffer): void }) {
    sendProof(res, await this.proofs.fileForOwner(this.tenant.companyId(), id));
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
    return this.proofs.refuse(id, dto.reason, { admin: req.platformAdmin!, ip: req.ip }, dto.revision);
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('payment-proofs/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(@Param('id') id: string, @Body() dto: ApproveProofDto, @Req() req: AdminRequest) {
    await this.admins.requireStepUp(req.platformAdmin!);
    return this.proofs.approve(id, dto, { admin: req.platformAdmin!, ip: req.ip });
  }

  /** 0138: the second administrator — never the first — confirms the deposit on the receiving account. */
  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('payment-proofs/:id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@Param('id') id: string, @Body() dto: ConfirmProofDto, @Req() req: AdminRequest) {
    await this.admins.requireStepUp(req.platformAdmin!);
    return this.proofs.confirm(id, dto, { admin: req.platformAdmin!, ip: req.ip });
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

/** `a,b,c` — the branch (or waiting request) ids a quote covers; none: every one. */
function branchList(raw: string | undefined): string[] | undefined {
  const ids = (raw ?? '').split(',').map((x) => x.trim()).filter((x) => isUuid(x));
  return ids.length ? ids : undefined;
}

/**
 * 0136: a proof as a download: its true type (from its bytes), a usable name with the right extension, and its revision.
 * Always `attachment` with nosniff: the console and the portal show it from the bytes they fetched, never on the API's origin.
 */
function sendProof(res: { setHeader(k: string, v: string): void; end(b: Buffer): void }, served: { file: Buffer; contentType: string; fileName: string; revision: number }) {
  res.setHeader('Content-Type', served.contentType);
  res.setHeader('Content-Disposition', contentDisposition(served.fileName));
  res.setHeader('X-Proof-Revision', String(served.revision));
  res.end(served.file);
}
