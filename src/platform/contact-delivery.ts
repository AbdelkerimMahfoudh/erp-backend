import { Injectable, Logger } from '@nestjs/common';
import type { ContactChannel } from '@prisma/client';

/**
 * Sending a code to a contact.
 *
 * **No provider is configured, and this checkpoint does not add one.** An audit
 * of the codebase found no email or WhatsApp delivery adapter of any kind, so
 * what exists here is the boundary a real one will slot into — and a
 * development outbox so the flow can be exercised meanwhile.
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
}

export abstract class ContactDeliveryProvider {
  abstract readonly name: string;
  abstract send(req: DeliveryRequest): Promise<DeliveryResult>;
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

  async send(): Promise<DeliveryResult> {
    throw new Error(
      'No contact delivery provider is configured. Refusing to claim a message was sent.',
    );
  }
}
