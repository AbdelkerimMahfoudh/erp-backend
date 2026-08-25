import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { binToUuid, uuidToBin, isUuid } from '../common/utils/uuid.util';
import { buildEntitlement } from '../entitlement/entitlement-rules';
import {
  ADMIN_SESSION_COOKIE,
  PlatformAdminGuard,
  readCookie,
  type AdminRequest,
} from './platform-admin.guard';
import { PlatformAdminService, ADMIN_SESSION_TTL_HOURS } from './platform-admin.service';
import { PlatformAuditService } from './platform-audit.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { RegistrationService } from './registration.service';
import { BillingService } from '../billing/billing.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { TenantContext } from '../common/tenant/tenant-context.service';

/**
 * The platform-control API.
 *
 * Hidden from the tenant-facing Swagger document: an operations surface is not
 * something the shop API's documentation should advertise.
 *
 * ## What `@Public()` means on an administrator route
 *
 * It is **not** "anyone may call this". `@Public()` only tells the global
 * TENANT authentication guard to stand down — that guard looks for a shop's
 * JWT, and an administrator does not have one, so without this every
 * administrator request is rejected before {@link PlatformAdminGuard} ever
 * runs. (It was, and the live check caught it: thirteen routes returning 401 to
 * a perfectly good administrator session.)
 *
 * Authorisation is then done entirely by `PlatformAdminGuard`, which reads a
 * different credential from a different table. The existing provisioning
 * controller uses exactly this pairing for exactly this reason.
 *
 * The two genuinely public routes — registration and administrator sign-in —
 * carry no `PlatformAdminGuard` and are both rate-limited.
 */

/** Registration and admin sign-in are both unauthenticated. Both are throttled. */
const PUBLIC_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

class RegisterDto {
  /** The client's own key, so a retry cannot create a second business. */
  @IsString() @IsNotEmptyish() @MaxLength(80) idempotencyKey: string;

  @IsString() @MinLength(1) @MaxLength(160) ownerName: string;
  @IsString() @MinLength(1) @MaxLength(160) businessName: string;
  @IsString() @MinLength(1) @MaxLength(160) branchName: string;

  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(24) phone?: string;

  @IsString() @MinLength(8) @MaxLength(200) password: string;
  @IsIn(['en', 'ar', 'fr']) language: 'en' | 'ar' | 'fr';
}

class AdminSignInDto {
  @IsEmail() @MaxLength(160) email: string;
  @IsString() @MinLength(1) @MaxLength(200) password: string;
}

class GrantDto {
  @IsInt() @Min(1) days: number;
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
  @IsOptional() @IsInt() expectedVersion?: number;
  /** Step-up. High-impact actions do not run on a warm session alone. */
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class ReasonDto {
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
  @IsOptional() @IsInt() expectedVersion?: number;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class ExtendDto {
  @IsInt() @Min(1) months: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsInt() expectedVersion?: number;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class PaymentDto {
  /** A string, so no float ever rounds somebody's money on the way in. */
  @IsNumberString() amount: string;
  @IsString() paidAt: string;
  @IsOptional() @IsIn(['manual', 'bank_transfer', 'mobile_money']) channel?:
    | 'manual'
    | 'bank_transfer'
    | 'mobile_money';
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() confirm?: boolean;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

class PlanVersionDto {
  @IsInt() @Min(0) branchMonthly: number;
  @IsInt() @Min(0) includedStaffPerBranch: number;
  @IsInt() @Min(0) extraStaffMonthly: number;
  /** ISO date. Must be in the future — a past price would rewrite history. */
  @IsString() effectiveFrom: string;
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
  @IsOptional() @IsString() @MaxLength(200) confirmPassword?: string;
}

/** `@IsNotEmpty` under a name that reads in this file. */
function IsNotEmptyish() {
  return MinLength(1);
}

@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class PlatformController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admins: PlatformAdminService,
    private readonly audit: PlatformAuditService,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly registration: RegistrationService,
    private readonly billing: BillingService,
    private readonly entitlement: EntitlementService,
    private readonly tenant: TenantContext,
  ) {}

  // ── Public: a shop signs itself up ───────────────────────────────────────

  @Public()
  @Throttle(PUBLIC_THROTTLE)
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    return this.registration.register({
      idempotencyKey: dto.idempotencyKey,
      ownerName: dto.ownerName,
      businessName: dto.businessName,
      branchName: dto.branchName,
      city: dto.city,
      email: dto.email,
      phone: dto.phone,
      password: dto.password,
      language: dto.language,
    });
  }

  // ── Administrator sign-in ────────────────────────────────────────────────

  @Public()
  @Throttle(PUBLIC_THROTTLE)
  @Post('admin/sign-in')
  @HttpCode(HttpStatus.OK)
  async adminSignIn(
    @Body() dto: AdminSignInDto,
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.admins.signIn(dto.email, dto.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    /*
     * HttpOnly, so no script on the page can read it — the administration
     * portal can reach every business on the platform, and a token in
     * `localStorage` would put that behind any injected script.
     */
    res.cookie(ADMIN_SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000,
      path: '/',
    });

    await this.audit.record({
      admin: { id: Buffer.from(result.admin.id, 'hex'), email: result.admin.email, name: result.admin.name },
      action: 'admin.sign_in',
      targetType: 'PlatformAdmin',
      targetLabel: result.admin.email,
      ip: req.ip ?? null,
    });

    // The token is NOT in the body. It is in the cookie and nowhere else,
    // except outside production where the harness needs it.
    return {
      admin: result.admin,
      expiresAt: result.expiresAt.toISOString(),
      ...(process.env.NODE_ENV !== 'production' ? { sessionToken: result.sessionToken } : {}),
    };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('admin/sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  async adminSignOut(@Req() req: AdminRequest, @Res({ passthrough: true }) res: Response) {
    // The session that authenticated THIS request, whichever way it arrived.
    await this.admins.signOut(req.platformSessionToken);
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('admin/me')
  me(@Req() req: AdminRequest) {
    const a = req.platformAdmin!;
    return { id: binToUuid(a.id), email: a.email, name: a.name };
  }

  // ── Dashboard ────────────────────────────────────────────────────────────

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('dashboard')
  async dashboard() {
    const now = new Date();
    const subs = await this.prisma.subscription.findMany({
      select: {
        status: true,
        currentPeriodEnd: true,
        isComplimentary: true,
        complimentaryUntil: true,
        subscribedBranchCount: true,
        additionalSeats: true,
      },
    });

    // Counted from the SAME rules the app enforces, never a second
    // interpretation of the dates.
    const tally: Record<string, number> = {};
    for (const s of subs) {
      const e = buildEntitlement(
        { ...s, status: s.status },
        { seatsUsed: 0, activeBranchCount: 0 },
        now,
      );
      tally[e.state] = (tally[e.state] ?? 0) + 1;
    }

    const [businesses, branches, activeUsers] = await Promise.all([
      this.prisma.company.count(),
      this.prisma.branch.count(),
      this.prisma.user.count({ where: { isActive: true, deletedAt: null } }),
    ]);

    return {
      byState: {
        pending: tally.pending ?? 0,
        active: tally.active ?? 0,
        grace: tally.grace ?? 0,
        complimentary: tally.complimentary ?? 0,
        suspended: tally.suspended ?? 0,
        expired: tally.expired ?? 0,
        cancelled: tally.cancelled ?? 0,
      },
      businesses,
      branches,
      activeUsers,
      /*
       * No revenue figure. Payment history is incomplete by construction —
       * this checkpoint records manual payments only, and no provider is
       * integrated — so any total would be a number that looks authoritative
       * and is not.
       */
      revenue: null,
      calculatedAt: now.toISOString(),
    };
  }

  // ── Businesses ───────────────────────────────────────────────────────────

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('businesses')
  async businesses(
    @Query('q') q?: string,
    @Query('state') state?: string,
    @Query('page') page?: string,
  ) {
    const take = 25;
    const skip = Math.max(0, (Number(page) || 1) - 1) * take;
    const term = q?.trim();

    const where: Record<string, unknown> = term
      ? {
          OR: [
            { name: { contains: term } },
            { publicStoreId: { contains: term } },
            { users: { some: { email: { contains: term } } } },
            { users: { some: { phone: { contains: term } } } },
          ],
        }
      : {};

    const [rows, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          publicStoreId: true,
          city: true,
          createdAt: true,
          subscription: true,
          _count: { select: { branches: true, users: true } },
        },
      }),
      this.prisma.company.count({ where }),
    ]);

    const now = new Date();
    const mapped = rows.map((c) => {
      const sub = c.subscription;
      const ent = sub
        ? buildEntitlement(
            { ...sub, status: sub.status },
            { seatsUsed: 0, activeBranchCount: c._count.branches },
            now,
          )
        : null;
      return {
        id: binToUuid(c.id),
        name: c.name,
        publicStoreId: c.publicStoreId,
        city: c.city,
        createdAt: c.createdAt.toISOString(),
        branches: c._count.branches,
        users: c._count.users,
        state: ent?.state ?? 'expired',
        status: sub?.status ?? 'activated',
        periodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
        version: sub?.version ?? 0,
      };
    });

    return {
      rows: state ? mapped.filter((r) => r.state === state) : mapped,
      total,
      page: Number(page) || 1,
      pageSize: take,
    };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('businesses/:id')
  async business(@Param('id') id: string) {
    if (!isUuid(id)) return { error: 'Unknown business' };
    const companyId = uuidToBin(id);

    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        publicStoreId: true,
        city: true,
        createdAt: true,
        subscription: true,
        branches: { select: { id: true, name: true, type: true } },
        /*
         * Owner CONTACT and verification state only.
         *
         * Note what is absent, deliberately: no sales, no IMEIs, no cost
         * prices, no margins, no expenses. A platform administrator
         * administers the platform. Being able to see a shop's takings is not
         * part of that, and the query simply cannot return them.
         */
        users: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            emailVerifiedAt: true,
            phoneVerifiedAt: true,
            isActive: true,
            lastLoginAt: true,
          },
          take: 50,
        },
      },
    });

    const now = new Date();
    const sub = company.subscription;
    const seatsUsed = company.users.filter((u) => u.isActive).length - 1;
    const ent = sub
      ? buildEntitlement(
          { ...sub, status: sub.status },
          {
            seatsUsed: Math.max(0, seatsUsed),
            activeBranchCount: company.branches.length,
          },
          now,
        )
      : null;

    const timeline = await this.lifecycle.timeline(id);

    return {
      id: binToUuid(company.id),
      name: company.name,
      publicStoreId: company.publicStoreId,
      city: company.city,
      createdAt: company.createdAt.toISOString(),
      branches: company.branches.map((b) => ({
        id: binToUuid(b.id),
        name: b.name,
        type: b.type,
      })),
      people: company.users.map((u) => ({
        id: binToUuid(u.id),
        name: u.name,
        email: u.email,
        phone: u.phone,
        emailVerified: u.emailVerifiedAt !== null,
        phoneVerified: u.phoneVerifiedAt !== null,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      })),
      entitlement: ent,
      version: sub?.version ?? 0,
      ...timeline,
    };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('pending')
  async pending() {
    const rows = await this.prisma.registrationAttempt.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const ids = rows.map((r) => r.companyId).filter((b): b is Buffer => b !== null);
    const subs = await this.prisma.subscription.findMany({
      where: { companyId: { in: ids } },
      select: { companyId: true, status: true },
    });
    const byCompany = new Map(subs.map((s) => [s.companyId.toString('hex'), s.status]));

    return rows.map((r) => ({
      id: binToUuid(r.id),
      companyId: r.companyId ? binToUuid(r.companyId) : null,
      businessName: r.businessName,
      ownerName: r.ownerName,
      city: r.city,
      email: r.email,
      phone: r.phone,
      language: r.language,
      registeredAt: r.createdAt.toISOString(),
      status: r.companyId ? (byCompany.get(r.companyId.toString('hex')) ?? 'unknown') : 'incomplete',
    }));
  }

  // ── Lifecycle actions ────────────────────────────────────────────────────

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/activate-grant')
  @HttpCode(HttpStatus.OK)
  async activateGrant(@Param('id') id: string, @Body() dto: GrantDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    const r = await this.lifecycle.activateByGrant(
      id,
      { days: dto.days, reason: dto.reason, expectedVersion: dto.expectedVersion },
      { admin, ip: req.ip },
    );
    return { applied: r.applied, version: r.subscription.version, status: r.subscription.status };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/extend')
  @HttpCode(HttpStatus.OK)
  async extend(@Param('id') id: string, @Body() dto: ExtendDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    const r = await this.lifecycle.extend(
      id,
      { months: dto.months, reason: dto.reason, expectedVersion: dto.expectedVersion },
      { admin, ip: req.ip },
    );
    return {
      applied: r.applied,
      version: r.subscription.version,
      periodEnd: r.subscription.currentPeriodEnd?.toISOString() ?? null,
    };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    const r = await this.lifecycle.suspend(
      id,
      { reason: dto.reason, expectedVersion: dto.expectedVersion },
      { admin, ip: req.ip },
    );
    return { applied: r.applied, version: r.subscription.version, status: r.subscription.status };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/reinstate')
  @HttpCode(HttpStatus.OK)
  async reinstate(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    const r = await this.lifecycle.reinstate(
      id,
      { reason: dto.reason, expectedVersion: dto.expectedVersion },
      { admin, ip: req.ip },
    );
    return { applied: r.applied, version: r.subscription.version, status: r.subscription.status };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    const r = await this.lifecycle.cancel(
      id,
      { reason: dto.reason, expectedVersion: dto.expectedVersion },
      { admin, ip: req.ip },
    );
    return { applied: r.applied, version: r.subscription.version, status: r.subscription.status };
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('businesses/:id/payments')
  @HttpCode(HttpStatus.CREATED)
  async payment(@Param('id') id: string, @Body() dto: PaymentDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);
    const p = await this.lifecycle.recordPayment(
      id,
      {
        amount: dto.amount,
        paidAt: new Date(dto.paidAt),
        channel: dto.channel,
        reference: dto.reference,
        note: dto.note,
        confirm: dto.confirm === true,
      },
      { admin, ip: req.ip },
    );
    return {
      id: binToUuid(p.id),
      amount: p.amount.toString(),
      currency: p.currency,
      confirmedAt: p.confirmedAt?.toISOString() ?? null,
      /** Stated on every response, so no caller can infer otherwise. */
      providerVerified: false,
    };
  }

  // ── The customer portal ──────────────────────────────────────────────────

  /**
   * Everything an Owner's account page shows.
   *
   * A TENANT route, not an administrator one: it runs on the shop's own JWT
   * and answers only about that shop. It is deliberately reachable in every
   * subscription state — pending, suspended and expired included — because it
   * is where somebody goes to find out WHY they cannot get in.
   *
   * It returns no operational data. Identity, subscription, price, history.
   */
  @Get('my-subscription')
  async mySubscription() {
    const companyId = this.tenant.companyId();

    const [company, entitlement, pricing] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({
        where: { id: companyId },
        select: {
          name: true,
          city: true,
          createdAt: true,
          branches: { where: { isActive: true }, select: { name: true, type: true } },
        },
      }),
      this.entitlement.forCompany(companyId),
      this.billing.pricingFor(companyId),
    ]);

    const timeline = await this.lifecycle.timeline(binToUuid(companyId));

    const owner = await this.prisma.user.findFirst({
      where: { companyId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { name: true, email: true, phone: true, emailVerifiedAt: true, phoneVerifiedAt: true },
    });

    return {
      business: {
        name: company.name,
        city: company.city,
        createdAt: company.createdAt.toISOString(),
        // Names and types only. No internal binary id reaches the client.
        branches: company.branches.map((b) => ({ name: b.name, type: b.type })),
      },
      owner: owner
        ? {
            name: owner.name,
            email: owner.email,
            phone: owner.phone,
            emailVerified: owner.emailVerifiedAt !== null,
            phoneVerified: owner.phoneVerifiedAt !== null,
          }
        : null,
      entitlement,
      pricing,
      ...timeline,
    };
  }

  // ── Pricing administration ───────────────────────────────────────────────

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('plans')
  async plans() {
    const rows = await this.prisma.planVersion.findMany({
      where: { planKey: 'standard' },
      orderBy: { effectiveFrom: 'asc' },
    });
    const now = new Date();
    return rows.map((r) => ({
      id: binToUuid(r.id),
      version: r.version,
      branchMonthly: r.branchMonthly,
      includedStaffPerBranch: r.includedStaffPerBranch,
      extraStaffMonthly: r.extraStaffMonthly,
      effectiveFrom: r.effectiveFrom.toISOString(),
      reason: r.reason,
      createdBy: r.createdBy,
      state: r.effectiveFrom.getTime() <= now.getTime() ? 'in_force' : 'scheduled',
    }));
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Post('plans')
  @HttpCode(HttpStatus.CREATED)
  async schedulePlan(@Body() dto: PlanVersionDto, @Req() req: AdminRequest) {
    const admin = req.platformAdmin!;
    await this.admins.confirmPassword(admin.id, dto.confirmPassword);

    const created = await this.billing.schedulePlanVersion({
      branchMonthly: dto.branchMonthly,
      includedStaffPerBranch: dto.includedStaffPerBranch,
      extraStaffMonthly: dto.extraStaffMonthly,
      effectiveFrom: new Date(dto.effectiveFrom),
      reason: dto.reason,
      createdBy: admin.email,
    });

    await this.audit.record({
      admin,
      action: 'plan.schedule',
      targetType: 'PlanVersion',
      targetLabel: `standard v${created.version}`,
      reason: dto.reason,
      after: created,
      ip: req.ip ?? null,
    });

    return created;
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get('audit')
  async auditLog(@Query('action') action?: string, @Query('page') page?: string) {
    const take = 50;
    const skip = Math.max(0, (Number(page) || 1) - 1) * take;
    const rows = await this.prisma.platformAuditEvent.findMany({
      where: action ? { action } : {},
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
    return rows.map((r) => ({
      id: binToUuid(r.id),
      actor: r.actor,
      action: r.action,
      targetType: r.targetType,
      targetLabel: r.targetLabel,
      reason: r.reason,
      before: r.beforeJson,
      after: r.afterJson,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
