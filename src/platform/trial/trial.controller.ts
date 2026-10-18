import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { TenantContext } from '../../common/tenant/tenant-context.service';
import { PortalSessionOnlyGuard } from '../portal/portal-session-only.guard';
import { ClaimTrialDto } from './trial.dto';
import type { TrialPrincipal } from './trial-facts';
import { TrialService } from './trial.service';
import { TrialSetupService } from './trial-setup.service';

/*
 * The account's sensitive-route limit, read the way `account.controller.ts` reads it: a decorator is evaluated before
 * anything is injected, the Joi schema validates the variable, and the fallback is the schema's own default.
 */
const ACCOUNT_THROTTLE_LIMIT = Number(process.env.ACCOUNT_THROTTLE_LIMIT) || 5;
const SENSITIVE_THROTTLE = { default: { limit: ACCOUNT_THROTTLE_LIMIT, ttl: 60_000 } };

/**
 * The free trial on the Dukan ERP portal (0095, 0099; docs/76, docs/101 §5): the Owner's card, the claim, and sending
 * the portal instructions again.
 *
 * Tenant routes — the shop's own session, never `@Public` — answering only about the caller's own company, from the
 * session, and only to its Owner. Every handler takes the body at most, and nothing else from the request: no header,
 * no IP, no `Origin` or `Referer`. Those say where a request claims to come from, a client sets them at will, and no
 * decision rests on them (the owner's correction of 2026-10-13). The claim and the resend require the portal's own
 * session (`PortalSessionOnlyGuard`, D211): the credential the server issued at the portal's sign-in, never a bearer
 * token, which is the app's. No token exists in any message: the instructions carry the portal's one address.
 *
 * All three stay reachable while the business is closed (`route-classification.ts`): a business that has not started
 * is exactly the one that needs them. The app reaches none of them: it reads a display-only status under `account/`
 * (`trial-setup.controller.ts`) and has no trial action of any kind (the owner's brief of 2026-10-18).
 */
@ApiExcludeController()
@Controller({ path: 'platform', version: '1' })
export class TrialController {
  constructor(
    private readonly trial: TrialService,
    private readonly setup: TrialSetupService,
    private readonly tenant: TenantContext,
  ) {}

  /** The caller, from the authenticated session. */
  private principal(): TrialPrincipal {
    return { companyId: this.tenant.companyId(), userId: this.tenant.requireUserId() };
  }

  /** The Owner's trial card: the state, the trial, and what a claim made now would record. */
  @Get('my-subscription/trial')
  status() {
    return this.trial.status(this.principal());
  }

  /** Start the free trial: 201 the first time; 200 when the same attempt is retried, which changes nothing. */
  @Post('my-subscription/trial/claim')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(SENSITIVE_THROTTLE)
  @UseGuards(PortalSessionOnlyGuard)
  async claim(@Body() dto: ClaimTrialDto, @Res({ passthrough: true }) res: Response) {
    const answer = await this.trial.claim(this.principal(), dto);
    if (answer.replayed) res.status(HttpStatus.OK);
    return answer;
  }

  /**
   * Send the portal instructions again — the portal's own action, for the signed-in Owner, and the only way to ask for
   * them besides support: never from the app. It reads nothing from the request, not even a body: the instructions go
   * to the Owner's verified contacts and nowhere a request could name. Throttled by the requests the business already
   * has, and audited; starting the trial never depends on it.
   */
  @Post('my-subscription/trial/setup/resend')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  @UseGuards(PortalSessionOnlyGuard)
  resendSetup() {
    return this.setup.resend(this.principal());
  }
}
