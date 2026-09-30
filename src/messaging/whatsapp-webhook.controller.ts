import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { OtpDeliveryState } from '@prisma/client';
import { Public } from '../common/decorators/public.decorator';
import { AppConfigService } from '../common/config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The provider's delivery-status webhook (docs/64 §3).
 *
 * Two routes, both public by necessity — the provider holds no credential of
 * ours — and both closed by construction until the operator configures them:
 *
 *  - `GET` answers the provider's one-time subscription check, and only with
 *    the configured verify token;
 *  - `POST` accepts a status report only when its `X-Hub-Signature-256` is the
 *    HMAC of the exact bytes received, keyed by the app secret. An unsigned or
 *    mis-signed body is refused before it is read.
 *
 * What a status changes: the delivery state of the challenge the provider's
 * message id belongs to, so support can answer "did it even arrive?". It grants
 * nothing, verifies nothing, and never carries a code.
 */
const WEBHOOK_THROTTLE = { default: { limit: 120, ttl: 60_000 } };

export interface ProviderStatus {
  id: string;
  status: string;
  errorCode?: number;
}

/** The statuses in a Cloud API webhook body, and nothing else from it. */
export function extractStatuses(body: unknown): ProviderStatus[] {
  const out: ProviderStatus[] = [];
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] } | null)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const statuses = (change as { value?: { statuses?: unknown[] } } | null)?.value?.statuses;
      if (!Array.isArray(statuses)) continue;
      for (const s of statuses) {
        const row = s as { id?: unknown; status?: unknown; errors?: { code?: unknown }[] } | null;
        if (!row || typeof row.id !== 'string' || typeof row.status !== 'string') continue;
        const code = row.errors?.[0]?.code;
        out.push({
          id: row.id.slice(0, 120),
          status: row.status.slice(0, 40),
          ...(typeof code === 'number' ? { errorCode: code } : {}),
        });
      }
    }
  }
  return out;
}

export function signatureMatches(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(header.slice('sha256='.length), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

@ApiExcludeController()
@Public()
@Controller({ path: 'messaging/whatsapp', version: '1' })
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Both settings, or the routes do not exist. */
  private get configured(): { verifyToken: string; appSecret: string } | null {
    const verifyToken = this.config.whatsappWebhookVerifyToken;
    const appSecret = this.config.whatsappAppSecret;
    return verifyToken && appSecret ? { verifyToken, appSecret } : null;
  }

  @Get('webhook')
  @Throttle(WEBHOOK_THROTTLE)
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ): void {
    const cfg = this.configured;
    if (!cfg) throw new NotFoundException();
    if (mode !== 'subscribe' || !token || !constantTimeEqual(token, cfg.verifyToken)) {
      throw new ForbiddenException('Verification refused');
    }
    res.status(200).type('text/plain').send(String(challenge ?? ''));
  }

  @Post('webhook')
  @Throttle(WEBHOOK_THROTTLE)
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): Promise<{ received: number }> {
    const cfg = this.configured;
    if (!cfg) throw new NotFoundException();
    if (!req.rawBody || !signatureMatches(req.rawBody, signature, cfg.appSecret)) {
      throw new UnauthorizedException('Signature required');
    }

    const statuses = extractStatuses(req.body);
    for (const s of statuses) {
      const failed = s.status === 'failed';
      await this.prisma.otpChallenge.updateMany({
        where: { providerMessageId: s.id, provider: 'cloud-api' },
        data: failed
          ? {
              deliveryState: OtpDeliveryState.rejected,
              deliveryDetail: `Provider reported failure${s.errorCode !== undefined ? ` (code ${s.errorCode})` : ''}`,
            }
          : { deliveryDetail: `Provider reported: ${s.status}` },
      });
    }
    if (statuses.length > 0) this.logger.log(`WhatsApp delivery statuses received: ${statuses.length}`);
    return { received: statuses.length };
  }
}
