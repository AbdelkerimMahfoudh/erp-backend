import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ContactChannel } from '@prisma/client';
import { DeliveryResult as ChannelResult, WHATSAPP_CHANNEL, WhatsAppChannel } from '../messaging/whatsapp-channel';
import { AUTH_OTP_TEMPLATE } from '../messaging/templates';
import { EMAIL_CHANNEL, EmailChannel } from '../messaging/email-channel';

/**
 * Sending a code to a contact.
 *
 * WhatsApp numbers go through the WhatsApp boundary; email addresses through the
 * email boundary (`messaging/email-channel.ts`, 2026-10-12), which connects no
 * provider until TSX-MR supplies one. Meanwhile a development outbox lets the
 * flow be exercised.
 *
 * The rule that shapes the whole file: **never claim a message was sent when
 * nothing sent it.** A "verification code sent" screen in front of a provider
 * that does not exist is worse than an honest refusal, because the shopkeeper
 * waits for a message that is never coming and concludes the product is broken.
 * So the outbox reports itself as the outbox, and production without a provider
 * refuses outright.
 */

/**
 * Whether the development outbox may handle delivery.
 *
 * An explicit opt-in, not "anything that is not production". The old test
 * was `NODE_ENV !== 'production'`, which quietly hands the outbox to any
 * environment somebody forgot to label — and an outbox that silently stands
 * in for a provider is how a real shop ends up waiting for a message nobody
 * ever sent.
 *
 * Two doors, and production is barred at both:
 *
 *  - ordinary local development (`NODE_ENV=development`);
 *  - staging, and only when it ALSO sets `STAGING_CONTACT_OUTBOX=enabled`.
 *
 * Staging runs with `NODE_ENV=production` so it exercises production code
 * paths, which is exactly why it needs its own deliberate flag rather than
 * inheriting a development default.
 */
export function outboxAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const appEnv = (env.APP_ENV ?? '').toLowerCase();
  const nodeEnv = (env.NODE_ENV ?? '').toLowerCase();

  // Never, under any combination of flags.
  if (appEnv === 'production') return false;

  if (appEnv === 'staging') return env.STAGING_CONTACT_OUTBOX === 'enabled';
  return nodeEnv !== 'production';
}

/**
 * Whether a code may be returned in an HTTP response.
 *
 * Stricter than {@link outboxAllowed}, deliberately. In **staging** the
 * answer is always no: a tester fetches the code with a server-side command,
 * because a code in a response body makes the whole verification
 * meaningless — anybody could "verify" any address they liked.
 */
export function codeMayBeReturned(env: NodeJS.ProcessEnv = process.env): boolean {
  const appEnv = (env.APP_ENV ?? '').toLowerCase();
  if (appEnv === 'staging' || appEnv === 'production') return false;
  return (env.NODE_ENV ?? '') !== 'production';
}

export interface DeliveryRequest {
  channel: ContactChannel;
  /** Normalised: a lowercased email, or an E.164 number. */
  destination: string;
  code: string;
  language: 'en' | 'ar' | 'fr';
}

export interface DeliveryResult {
  /** What actually happened. `outbox` is not a claim of delivery. */
  delivery: 'sent' | 'outbox';
  provider: string;
  /** The provider's own message id, when it gave one: recorded on the code's row (0093). */
  providerMessageId?: string | null;
}

export abstract class ContactDeliveryProvider {
  abstract readonly name: string;
  abstract send(req: DeliveryRequest): Promise<DeliveryResult>;
  /**
   * Whether a code to this kind of contact can actually leave this server.
   *
   * Asked BEFORE anything is created for somebody to wait on — the rule the
   * deletion flow follows (`56bddbe`). A registration refused up front with
   * "nothing was saved" is honest; a pending business whose Owner waits for a
   * code that is never coming is not (`docs/67` RC-02).
   */
  abstract canDeliver(channel: ContactChannel, destination?: string): boolean;
}

/**
 * The development outbox.
 *
 * Holds codes in memory so a developer or a live-check harness can read the one
 * it just triggered. Two properties matter:
 *
 *  - it is **never** selected when `NODE_ENV === 'production'`;
 *  - the code is readable **only** through {@link peek}, which no HTTP route
 *    exposes in production. A verification code returned from a production
 *    endpoint would make the whole verification meaningless.
 */
@Injectable()
export class OutboxDeliveryProvider extends ContactDeliveryProvider {
  readonly name = 'dev-outbox';

  /** Development only: the outbox takes every channel. */
  canDeliver(_channel: ContactChannel): boolean {
    return true;
  }
  private readonly log = new Logger('ContactOutbox');
  private readonly recent = new Map<string, { code: string; at: Date }>();

  async send(req: DeliveryRequest): Promise<DeliveryResult> {
    this.recent.set(req.destination, { code: req.code, at: new Date() });
    // The destination, never the code. A log file is not a safe place for a
    // working credential, even a short-lived one.
    this.log.log(`verification code queued in the dev outbox for ${req.destination}`);
    return { delivery: 'outbox', provider: this.name };
  }

  /**
   * Read a stored code.
   *
   * Available wherever the outbox itself is, so the staging retrieval
   * command can work — but the ROUTE still refuses to put the result in a
   * response outside development. Two separate gates, on purpose.
   */
  peek(destination: string): string | null {
    if (!outboxAllowed()) return null;
    return this.recent.get(destination)?.code ?? null;
  }

  clear(): void {
    this.recent.clear();
  }
}

/**
 * What runs when nothing is configured in production.
 *
 * Refuses, loudly. The alternative — quietly succeeding — would tell every new
 * shop that a code was on its way and strand all of them.
 */
@Injectable()
export class UnconfiguredDeliveryProvider extends ContactDeliveryProvider {
  readonly name = 'none';

  canDeliver(_channel: ContactChannel): boolean {
    return false;
  }

  async send(): Promise<DeliveryResult> {
    throw new ServiceUnavailableException({
      code: 'delivery_unavailable',
      message: 'No contact delivery provider is configured. Refusing to claim a message was sent.',
    });
  }
}

/**
 * The provider every caller holds: it asks which provider is right on EVERY call (F11, 2026-10-13).
 *
 * The choice used to be made once, when the module was built — before `WhatsAppReadiness` had read a single
 * delivery proof. In production a configured WhatsApp channel stays closed until its proofs load, so a deployment
 * whose only channel is WhatsApp looked undeliverable at that moment, was handed the honest refusal, and kept
 * refusing every code for as long as the process ran: the proofs loading a moment later, or the webhook completing
 * one, changed nothing until a restart. A registration it refused said "nothing was saved", truthfully, about a
 * server that could in fact send.
 *
 * Choosing per call costs a few property reads, and each answer is the true one at that moment: closed before the
 * proofs, open from the instant they load, closed again if the channel goes away. `choose` is pure selection over the
 * registered instances — nothing is built per call, so the outbox a code was stored in is the outbox it is read from.
 */
export class SelectedContactDelivery extends ContactDeliveryProvider {
  constructor(private readonly choose: () => ContactDeliveryProvider) {
    super();
  }

  /** The name of the provider a call would reach now — what a code's row records as its provider. */
  get name(): string {
    return this.choose().name;
  }

  canDeliver(channel: ContactChannel, destination?: string): boolean {
    return this.choose().canDeliver(channel, destination);
  }

  send(req: DeliveryRequest): Promise<DeliveryResult> {
    return this.choose().send(req);
  }
}

/** A real channel: enabled, and not one that only writes to a development log. */
export function isRealChannel(channel: { isEnabled: boolean; name: string }): boolean {
  return channel.isEnabled && channel.name !== 'development-log';
}

/**
 * Send once, and once more only when the failure is temporary (a timeout, a 5xx, throttling) — under the SAME
 * idempotency key, so a provider that did take the first one does not deliver it twice. A refusal, a credential
 * problem or a missing channel is never retried.
 */
export async function sendWithOneRetry(send: (idempotencyKey: string) => Promise<ChannelResult>): Promise<ChannelResult> {
  const key = randomUUID();
  const first = await send(key);
  if (first.status === 'accepted' || first.reason !== 'temporary') return first;
  return send(key);
}

/**
 * The real one (docs/64 §3): WhatsApp numbers through the WhatsApp boundary, email addresses through the email
 * boundary — each with its approved text, its classification of failures, and one retry for a temporary one.
 * A contact whose channel has no real provider is refused honestly.
 *
 * A refused or failed delivery is a 503 with a stable code, never a 200 that claims a message went out — and the
 * code is never shown instead.
 */
@Injectable()
export class WhatsAppContactDeliveryProvider extends ContactDeliveryProvider {
  readonly name = 'channels';

  constructor(
    @Inject(WHATSAPP_CHANNEL) private readonly channel: WhatsAppChannel,
    private readonly unconfigured: UnconfiguredDeliveryProvider,
    @Optional() @Inject(EMAIL_CHANNEL) private readonly email?: EmailChannel,
  ) {
    super();
  }

  /**
   * A WhatsApp number while WhatsApp is on — and, given the number, only one the channel would send to (test mode
   * reaches its exact allowlist only, D181 §4); an email address while a real email provider is on.
   */
  canDeliver(channel: ContactChannel, destination?: string): boolean {
    if (channel === 'phone') {
      if (!this.channel.isEnabled) return false;
      return destination && this.channel.accepts ? this.channel.accepts(destination) : true;
    }
    return this.email !== undefined && isRealChannel(this.email);
  }

  async send(req: DeliveryRequest): Promise<DeliveryResult> {
    if (!this.canDeliver(req.channel)) return this.unconfigured.send();
    const result =
      req.channel === 'phone'
        ? await sendWithOneRetry((idempotencyKey) =>
            this.channel.send({
              to: req.destination,
              template: AUTH_OTP_TEMPLATE.key,
              language: req.language,
              variables: { code: req.code, ttlMinutes: '10' },
              // A retried `start()` issues a NEW code, so each start is its own message.
              idempotencyKey,
            }),
          )
        : await sendWithOneRetry((idempotencyKey) =>
            this.email!.send({
              to: req.destination,
              template: 'contact.verification',
              language: req.language,
              variables: { code: req.code, ttlMinutes: '10' },
              idempotencyKey,
            }),
          );
    if (result.status !== 'accepted') {
      throw new ServiceUnavailableException({
        code: 'delivery_failed',
        // The failure class, under the name the exception filter passes through.
        delivery: result.reason,
        message: 'The verification code could not be sent. Please try again in a moment.',
      });
    }
    return { delivery: 'sent', provider: `${req.channel === 'phone' ? 'whatsapp' : 'email'}:${result.provider}`, providerMessageId: result.providerMessageId };
  }
}
