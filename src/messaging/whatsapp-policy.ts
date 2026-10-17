import { Logger } from '@nestjs/common';
import type { DeliveryFailureReason, DeliveryResult, E164, WhatsAppChannel, WhatsAppMessage } from './whatsapp-channel';
import { getTemplate, type TemplateDefinition, type TemplateUse } from './templates';
import { maskDestination } from './channels';
import type { ContactState, WhatsAppRecords } from './whatsapp-records';

/**
 * What may leave this server by WhatsApp, decided before the provider is called (D181 §4, §5).
 *
 * Three independent controls, none of which implies another:
 *
 *  - `WHATSAPP_CHANNEL` — whether a provider is configured at all;
 *  - `WHATSAPP_MODE` — `test` sends ONLY to the exact numbers of `WHATSAPP_TEST_RECIPIENTS`, whatever the
 *    application's data says; `live` may reach real customers;
 *  - `WHATSAPP_LIVE_SENDS` — in live mode, nothing is sent until it is `enabled`.
 *
 * Then the person's own choices: a withdrawn channel stops everything, an opt-out stops optional notices, and in
 * live mode an optional notice needs a recorded consent. Every decision is recorded (`whatsapp_messages`), with the
 * number as a keyed hash and a masked form — never the variables, which can be a code or a token.
 *
 * A refusal is a failed delivery with the boundary's reasons, so every caller already written for a missing
 * channel refuses honestly. Nothing ever falls back to another channel or to a log.
 */

export type WhatsAppMode = 'test' | 'live';

export interface WhatsAppSendControls {
  mode: WhatsAppMode;
  /** Exact E.164 numbers; the only destinations test mode may reach. */
  testRecipients: ReadonlySet<string>;
  /** Live mode only: false blocks every real-customer send. */
  liveSends: boolean;
  phoneNumberId: string;
  maxPerSecond: number;
  recipientMinIntervalMs: number;
}

const E164 = /^\+[1-9]\d{7,14}$/;

/** The allowlist, exactly as configured: comma- or space-separated E.164 numbers. Anything else is refused. */
export function parseTestRecipients(raw: string): string[] {
  const items = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = items.filter((n) => !E164.test(n));
  if (bad.length > 0) {
    throw new Error(
      `WHATSAPP_TEST_RECIPIENTS must list E.164 numbers such as +22236000000; ${bad.length} entr${bad.length === 1 ? 'y is' : 'ies are'} not.`,
    );
  }
  return [...new Set(items)];
}

export interface Refusal {
  reason: DeliveryFailureReason;
  detail: string;
}

/** The whole decision, pure: the controls, the template's use, the destination and what is known about it. */
export function policyRefusal(
  controls: Pick<WhatsAppSendControls, 'mode' | 'testRecipients' | 'liveSends'>,
  use: TemplateUse,
  to: E164,
  contact: Pick<ContactState, 'optOutScope' | 'consented'>,
): Refusal | null {
  if (controls.mode === 'test') {
    if (!controls.testRecipients.has(to)) {
      return { reason: 'channel_unavailable', detail: 'Test mode: the number is not an allowlisted test recipient' };
    }
  } else {
    if (use === 'operator') return { reason: 'rejected', detail: 'The delivery check is sent in test mode only' };
    if (!controls.liveSends) return { reason: 'channel_unavailable', detail: 'Live sends are disabled (WHATSAPP_LIVE_SENDS)' };
  }
  if (contact.optOutScope === 'all') {
    return { reason: 'rejected', detail: 'The recipient withdrew WhatsApp as their account contact' };
  }
  if (use === 'optional' && contact.optOutScope === 'optional') {
    return { reason: 'rejected', detail: 'The recipient opted out of optional notifications' };
  }
  if (use === 'optional' && controls.mode === 'live' && !contact.consented) {
    return { reason: 'rejected', detail: 'No recorded WhatsApp consent for optional notifications' };
  }
  return null;
}

/**
 * Outbound pacing, in this process: a token bucket for the sending number (the provider's throughput) and a minimum
 * gap per recipient (its pair rate limit, 131056). A retry of the same message is not a new message and skips the
 * per-recipient gap. One API instance is the supported deployment (docs/97); a second would pace separately.
 */
export class SendPacer {
  private tokens: number;
  private refilledAt: number;
  private readonly lastByRecipient = new Map<string, number>();

  constructor(
    private readonly maxPerSecond: number,
    private readonly recipientMinIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = maxPerSecond;
    this.refilledAt = now();
  }

  take(recipient: string, isRetry: boolean): 'ok' | 'sender' | 'recipient' {
    const t = this.now();
    this.tokens = Math.min(this.maxPerSecond, this.tokens + ((t - this.refilledAt) / 1000) * this.maxPerSecond);
    this.refilledAt = t;
    const last = this.lastByRecipient.get(recipient);
    if (!isRetry && last !== undefined && t - last < this.recipientMinIntervalMs) return 'recipient';
    if (this.tokens < 1) return 'sender';
    this.tokens -= 1;
    this.lastByRecipient.set(recipient, t);
    if (this.lastByRecipient.size > 10_000) {
      for (const [k, v] of this.lastByRecipient) if (t - v >= this.recipientMinIntervalMs) this.lastByRecipient.delete(k);
    }
    return 'ok';
  }
}

/** The provider says this number cannot receive the message: remembered, never retried. */
const UNDELIVERABLE = 131026;

export class GovernedWhatsAppChannel implements WhatsAppChannel {
  private readonly logger = new Logger(GovernedWhatsAppChannel.name);
  private readonly pacer: SendPacer;

  constructor(
    private readonly inner: WhatsAppChannel,
    private readonly controls: WhatsAppSendControls,
    private readonly records: WhatsAppRecords,
    pacer?: SendPacer,
  ) {
    this.pacer = pacer ?? new SendPacer(controls.maxPerSecond, controls.recipientMinIntervalMs);
  }

  get name(): string {
    return this.inner.name;
  }

  get mode(): WhatsAppMode {
    return this.controls.mode;
  }

  /** Test mode is open only with an allowlist; live mode only once live sends are enabled. */
  get isEnabled(): boolean {
    if (!this.inner.isEnabled) return false;
    return this.controls.mode === 'test' ? this.controls.testRecipients.size > 0 : this.controls.liveSends;
  }

  accepts(to: E164): boolean {
    return this.isEnabled && (this.controls.mode === 'live' || this.controls.testRecipients.has(to));
  }

  async send(message: WhatsAppMessage): Promise<DeliveryResult> {
    let template: TemplateDefinition;
    try {
      template = getTemplate(message.template);
    } catch {
      return this.failed('rejected', 'Unknown template');
    }

    let contact: ContactState;
    let isRetry: boolean;
    try {
      contact = await this.records.contactState(message.to);
      isRetry = await this.records.messageExists(message.idempotencyKey);
    } catch {
      // Without the records no opt-out can be honoured: nothing is sent.
      this.logger.warn(`WhatsApp send held for ${maskDestination(message.to)} (${message.template}): records unavailable`);
      return this.failed('temporary', 'Message records are unavailable');
    }

    const refusal = policyRefusal(this.controls, template.use, message.to, contact);
    if (refusal) {
      await this.record(message, template, { status: 'failed', ...refusal, provider: this.name }, true);
      return this.failed(refusal.reason, refusal.detail);
    }

    const paced = this.pacer.take(message.to, isRetry);
    if (paced !== 'ok') {
      const detail = paced === 'sender' ? 'Outbound rate limit for this sending number' : 'Too soon after the last message to this number';
      await this.record(message, template, { status: 'failed', reason: 'temporary', detail, provider: this.name }, true);
      return this.failed('temporary', detail);
    }

    let result: DeliveryResult;
    try {
      result = await this.inner.send(message);
    } catch {
      result = { status: 'failed', reason: 'temporary', detail: 'Channel raised an unexpected error', provider: this.name };
    }
    await this.record(message, template, result, false);
    if (result.status === 'failed' && result.providerCode === UNDELIVERABLE) {
      await this.records.markUndeliverable(message.to).catch(() => undefined);
    }
    return result;
  }

  /** Recorded after the fact: a record that cannot be written never turns a sent message into a failure. */
  private async record(message: WhatsAppMessage, template: TemplateDefinition, result: DeliveryResult, refused: boolean): Promise<void> {
    try {
      await this.records.recordSend({
        idempotencyKey: message.idempotencyKey,
        to: message.to,
        template: template.key,
        use: template.use,
        language: message.language,
        mode: this.controls.mode,
        phoneNumberId: this.controls.phoneNumberId,
        result,
        refused,
      });
    } catch {
      this.logger.warn(`WhatsApp message record could not be written for ${maskDestination(message.to)} (${message.template})`);
    }
  }

  private failed(reason: DeliveryFailureReason, detail: string): DeliveryResult {
    return { status: 'failed', reason, detail, provider: this.name };
  }
}
