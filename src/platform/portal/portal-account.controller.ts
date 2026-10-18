import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TenantContext } from '../../common/tenant/tenant-context.service';
import { EntitlementService } from '../../entitlement/entitlement.service';
import type { Entitlement } from '../../entitlement/entitlement-rules';
import { BillingService } from '../../billing/billing.service';
import { NoticeService } from '../../notices/notice.service';
import { paymentInstructions } from '../payment-instructions';
import { TrialService } from '../trial/trial.service';
import type { TrialPrincipal } from '../trial/trial-facts';
import { EmailCodeDto, EmailVerifyStartDto } from './portal.dto';
import { OwnerContactsService } from './owner-contacts.service';

/*
 * The account's sensitive-route limit, read the way `account.controller.ts` reads it: a decorator is evaluated before
 * anything is injected, the Joi schema validates the variable, and the fallback is the schema's own default.
 */
const SENSITIVE_THROTTLE = { default: { limit: Number(process.env.ACCOUNT_THROTTLE_LIMIT) || 5, ttl: 60_000 } };

/**
 * What the Owner may do on the portal, and what the business can do in the app, as the server decides them (0099;
 * docs/101 §4). The portal renders them; it never works one out.
 *
 *  - `operational` — the app works: a paid period, its grace, a grant or a running trial;
 *  - `read_only` — records stay readable, nothing new is written: a trial or a paid period over, or not started yet;
 *  - `stopped` — suspended, cancelled or refused: the Owner keeps the portal, its support and legal pages.
 */
export type AccessState = 'operational' | 'read_only' | 'stopped';

export function accessOf(e: Pick<Entitlement, 'canWrite' | 'state'>): AccessState {
  if (e.canWrite) return 'operational';
  return e.state === 'suspended' || e.state === 'cancelled' || e.state === 'rejected' ? 'stopped' : 'read_only';
}

/**
 * The portal's Owner routes beside the subscription itself (0099): what the business can do and what its Owner may
 * do now, the messages' timeline, and the verification of the Owner's optional email address. Tenant routes — the
 * portal cookie authenticates them, with the CSRF token on every POST — answering only about the caller's own
 * company, and only to its Owner (403 `owner_only` before anything is read).
 */
@ApiExcludeController()
@Controller({ path: 'platform/my-subscription', version: '1' })
export class PortalAccountController {
  constructor(
    private readonly tenant: TenantContext,
    private readonly entitlement: EntitlementService,
    private readonly billing: BillingService,
    private readonly notices: NoticeService,
    private readonly trial: TrialService,
    private readonly contacts: OwnerContactsService,
  ) {}

  private principal(): TrialPrincipal {
    return { companyId: this.tenant.companyId(), userId: this.tenant.requireUserId() };
  }

  /**
   * The server-calculated status the portal shows above everything else: access, the paid period's start and end, the
   * grace and its allowance, where the subscription messages stand (the next, the newest), and the actions the Owner
   * may take now — each decided here.
   */
  @Get('status')
  async status() {
    const who = this.principal();
    // The trial card first: it refuses anybody but the Owner before anything else is read.
    const card = await this.trial.status(who);
    const [entitlement, period, timeline] = await Promise.all([
      this.entitlement.forCompany(who.companyId),
      this.billing.latestPeriod(who.companyId),
      this.notices.timelineOf(who.companyId),
    ]);
    const payments = paymentInstructions();
    return {
      access: accessOf(entitlement),
      state: entitlement.state,
      period: { start: period?.periodStart.toISOString() ?? null, end: entitlement.periodEnd },
      grace: entitlement.grace,
      notices: timeline,
      actions: {
        claimTrial: card.offer?.available === true,
        resendInstructions: card.setup?.canResendNow === true,
        paymentInstructions: payments.available,
      },
      timeZone: entitlement.timeZone,
      calculatedAt: entitlement.calculatedAt,
    };
  }

  /** Send a code to the Owner's own email address — the one on the account, never one a request names. */
  @Post('contacts/email/verify/start')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  startEmailVerification(@Body() dto: EmailVerifyStartDto) {
    return this.contacts.startEmailVerification(this.principal(), dto.language);
  }

  /** Check the code: the address becomes verified — and may then carry a message WhatsApp cannot. */
  @Post('contacts/email/verify/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  confirmEmailVerification(@Body() dto: EmailCodeDto) {
    return this.contacts.confirmEmailVerification(this.principal(), dto.code);
  }
}
