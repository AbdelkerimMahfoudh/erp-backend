import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { TenantContext } from '../../common/tenant/tenant-context.service';
import { ClaimTrialDto, TrialLinkDto } from './trial.dto';
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
 * The free trial on the Dukan ERP website (0095; docs/76): the Owner's card, the setup link check, the claim, and
 * sending the setup instructions again.
 *
 * Tenant routes — the shop's own session, never `@Public` — answering only about the caller's own company, from the
 * session, and only to its Owner. Every handler takes the body at most, and nothing else from the request: no header,
 * no IP, no `Origin` or `Referer`. Those say where a request claims to come from, a client sets them at will, and
 * "website only" is a product boundary — only the website shows this — never a check a client could pass by lying
 * (the owner's correction of 2026-10-13).
 *
 * None of them takes a token from a URL, and the one GET carries none: a link preview or a mail scanner opening the
 * setup link loads the website's static page and reaches nothing here. A token travels only in a POST body after
 * sign-in, and only the claim — the Owner's explicit confirmation — consumes it.
 *
 * All four stay reachable while the business is closed (`route-classification.ts`): a business that has not started
 * is exactly the one that needs them. The app reaches none of them: it reads a display-only status under `account/`
 * (`trial-setup.controller.ts`) and has no trial action of any kind (the owner's correction of 2026-10-13).
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

  /** What a setup link is worth to the signed-in Owner. Never consumes it. */
  @Post('my-subscription/trial/link')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  checkLink(@Body() dto: TrialLinkDto) {
    return this.trial.checkLink(this.principal(), dto.token);
  }

  /** Start the free trial: 201 the first time; 200 when the same attempt is retried, which changes nothing. */
  @Post('my-subscription/trial/claim')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(SENSITIVE_THROTTLE)
  async claim(@Body() dto: ClaimTrialDto, @Res({ passthrough: true }) res: Response) {
    const answer = await this.trial.claim(this.principal(), dto);
    if (answer.replayed) res.status(HttpStatus.OK);
    return answer;
  }

  /**
   * Send the setup instructions again — the website's own action, for the signed-in Owner, and the only way to ask
   * for them besides support: never from the app. It reads nothing from the request, not even a body: the
   * instructions go to the Owner's verified contacts and nowhere a request could name. Throttled by the attempts the
   * business already has; starting the trial never depends on it.
   */
  @Post('my-subscription/trial/setup/resend')
  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_THROTTLE)
  resendSetup() {
    return this.setup.resend(this.principal());
  }
}
