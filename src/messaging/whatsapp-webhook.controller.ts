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
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AppConfigService } from '../common/config/app-config.service';
import { maskDestination } from './channels';
import { RecipientHasher } from './recipient-hash';
import { optOutSignalOf } from './whatsapp-consent';
import { WhatsAppWebhookWorker } from './whatsapp-webhook.worker';

/**
 * The provider's webhook (docs/64 §3; asynchronous since 0098, D181 §8).
 *
 * Two routes, both public by necessity — the provider holds no credential of ours — and both closed by
 * construction until the operator configures them:
 *
 *  - `GET` answers the provider's one-time subscription check, and only with the configured verify token;
 *  - `POST` accepts a delivery only when its `X-Hub-Signature-256` is the HMAC of the exact bytes received, keyed by
 *    the app secret. An unsigned or mis-signed body is refused before it is read.
 *
 * A signed delivery is then split into items — statuses, and inbound messages reduced to an id, a keyed hash of the
 * sender and an opt-out signal decided here, in memory, from text that is then dropped — and the items are stored
 * in ONE statement before the provider is answered. A provider retry collapses on each item's key. If the items
 * cannot be stored the answer is a 503, so the provider retries: an acknowledged delivery is never a lost one. The
 * work itself (statuses, delivery proofs, opt-outs) happens in {@link WhatsAppWebhookWorker}, under a lease.
 */
const WEBHOOK_THROTTLE = { default: { limit: 120, ttl: 60_000 } };

export interface ProviderStatus {
  id: string;
  status: string;
  errorCode?: number;
}

/** One stored item of a delivery: nothing beyond what processing needs. */
export interface WebhookItem {
  dedupeKey: string;
  kind: 'status' | 'inbound';
  providerMessageId: string;
  status: string | null;
  errorCode: number | null;
  senderHash: string | null;
  senderMasked: string | null;
  optOutSignal: 'stop' | 'start' | null;
  occurredAt: Date | null;
}

interface Change {
  value?: { statuses?: unknown[]; messages?: unknown[] };
}

function changesOf(body: unknown): Change[] {
  const out: Change[] = [];
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] } | null)?.changes;
    if (Array.isArray(changes)) for (const change of changes) if (change && typeof change === 'object') out.push(change as Change);
  }
  return out;
}

/** The provider's unix-seconds timestamp, or null. */
function instant(value: unknown): Date | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

/** The statuses in a Cloud API webhook body, and nothing else from it. */
export function extractStatuses(body: unknown): ProviderStatus[] {
  const out: ProviderStatus[] = [];
  for (const change of changesOf(body)) {
    const statuses = change.value?.statuses;
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
  return out;
}

/**
 * Every item of a delivery, ready to store. An inbound message's text (or quick-reply button text) is examined for
 * an opt-out keyword and dropped; the sender is kept only as a keyed hash and a masked form.
 */
export function extractItems(body: unknown, hash: (e164: string) => string): WebhookItem[] {
  const items: WebhookItem[] = [];
  for (const change of changesOf(body)) {
    for (const s of Array.isArray(change.value?.statuses) ? change.value!.statuses! : []) {
      const row = s as { id?: unknown; status?: unknown; timestamp?: unknown; errors?: { code?: unknown }[] } | null;
      if (!row || typeof row.id !== 'string' || typeof row.status !== 'string') continue;
      const id = row.id.slice(0, 120);
      const status = row.status.slice(0, 20);
      const code = row.errors?.[0]?.code;
      items.push({
        dedupeKey: `s:${id}:${status}`,
        kind: 'status',
        providerMessageId: id,
        status,
        errorCode: typeof code === 'number' ? code : null,
        senderHash: null,
        senderMasked: null,
        optOutSignal: null,
        occurredAt: instant(row.timestamp),
      });
    }
    for (const m of Array.isArray(change.value?.messages) ? change.value!.messages! : []) {
      const row = m as { id?: unknown; from?: unknown; timestamp?: unknown; text?: { body?: unknown }; button?: { text?: unknown } } | null;
      if (!row || typeof row.id !== 'string' || typeof row.from !== 'string' || !/^\d{8,15}$/.test(row.from)) continue;
      const id = row.id.slice(0, 120);
      const e164 = `+${row.from}`;
      items.push({
        dedupeKey: `m:${id}`,
        kind: 'inbound',
        providerMessageId: id,
        status: null,
        errorCode: null,
        senderHash: hash(e164),
        senderMasked: maskDestination(e164),
        optOutSignal: optOutSignalOf(row.text?.body ?? row.button?.text),
        occurredAt: instant(row.timestamp),
      });
    }
  }
  return items;
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
    private readonly hasher: RecipientHasher,
    private readonly worker: WhatsAppWebhookWorker,
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

    const items = extractItems(req.body, (e164) => this.hasher.hash(e164));
    try {
      await this.worker.enqueue(items);
    } catch {
      // Not stored, so not acknowledged: the provider retries the same delivery.
      this.logger.warn(`WhatsApp webhook delivery not stored (${items.length} items): answered 503 for a retry`);
      throw new ServiceUnavailableException('Not stored; retry later');
    }
    if (items.length > 0) void this.worker.processNow();
    return { received: items.length };
  }
}
