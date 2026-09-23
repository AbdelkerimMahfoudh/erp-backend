/**
 * The messaging boundary (F1 Stage 4A).
 *
 * Authentication code depends on THIS FILE and nothing else. No Meta, Twilio or
 * Infobip type may ever appear above an adapter, so swapping providers — or
 * running with none — never touches a security service.
 *
 * Two deliberate absences:
 *
 * 1. **There is no raw-message call.** A caller names an approved template and
 *    supplies validated variables. A provider-neutral `sendText(body)` would let
 *    any future feature put arbitrary content — including a code — into a
 *    message path nobody reviewed.
 * 2. **No provider error type escapes.** Adapters classify failures into the
 *    small set below, so callers cannot accidentally branch on a vendor's HTTP
 *    body, and a vendor payload cannot reach a log or an audit row.
 */

import { TemplateKey } from './templates';

/** E.164, e.g. `+2223xxxxxx`. Canonical form is the caller's responsibility. */
export type E164 = string;

/** What may be asked for; a template still declares what it supports. */
export type MessageLanguage = 'en' | 'ar' | 'fr';

export interface WhatsAppMessage {
  /** Canonical E.164 destination. Adapters must not reformat it silently. */
  to: E164;
  template: TemplateKey;
  language: MessageLanguage;
  /**
   * Template variables, already validated against the registry. Values are
   * strings because that is what every template API accepts; the registry is
   * what guarantees the right ones are present.
   */
  variables: Record<string, string>;
  /**
   * Application-side idempotency reference. An adapter that supports it should
   * pass it through so a retried delivery cannot duplicate a real message.
   */
  idempotencyKey: string;
}

/**
 * Why a delivery failed, in terms a caller can act on.
 *
 * `temporary` is the only class that may be retried. `rejected` and
 * `unavailable` must not be, because retrying a malformed template or a
 * disabled channel just burns attempts.
 */
export type DeliveryFailureReason =
  /** No provider configured. Not an error — the deployment chose this. */
  | 'channel_unavailable'
  /** The provider refused it: bad number, template not approved, opted out. */
  | 'rejected'
  /** Network, timeout, 5xx, throttling. Retryable with backoff. */
  | 'temporary'
  /** Credentials or permissions are wrong. Retrying will not fix it. */
  | 'not_authorized';

export type DeliveryResult =
  | {
      status: 'accepted';
      /** The provider's own id, when it gives one. Safe to store and log. */
      providerMessageId: string | null;
      provider: string;
    }
  | {
      status: 'failed';
      reason: DeliveryFailureReason;
      /**
       * A SHORT, provider-neutral description safe for logs and audit rows.
       * Adapters must not put a raw provider payload here.
       */
      detail: string;
      provider: string;
    };

/**
 * What every adapter implements. Kept to one method on purpose: the smaller
 * this surface, the less there is to get wrong in a vendor integration written
 * under deadline.
 */
export interface WhatsAppChannel {
  /** A stable name for logs, metrics and audit rows. Never a credential. */
  readonly name: string;
  /** False when the deployment has no provider — callers must not pretend otherwise. */
  readonly isEnabled: boolean;
  send(message: WhatsAppMessage): Promise<DeliveryResult>;
}

/** DI token. Injected by interface, never by concrete adapter. */
export const WHATSAPP_CHANNEL = Symbol('WHATSAPP_CHANNEL');
