import { Injectable, Logger } from '@nestjs/common';
import {
  DeliveryResult,
  WhatsAppChannel,
  WhatsAppMessage,
} from './whatsapp-channel';

/**
 * The adapters that exist without a provider (F1 Stage 4A).
 *
 * None of these makes a network call. There is no HTTP client in this project
 * at all, which is exactly why a "disabled" deployment is safe by construction
 * rather than by discipline.
 */

/** Show enough of a number to recognise it, never enough to dial it. */
export function maskDestination(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `${e164.slice(0, 4)}***${digits.slice(-2)}`;
}

/**
 * The default. No provider is configured, so nothing is sent.
 *
 * It returns a controlled failure rather than throwing, and rather than
 * pretending: a caller must be able to tell "we did not send this" from "we
 * sent it", and must never record a challenge as delivered when no message
 * left the building.
 *
 * Safe in production — that is the point. A deployment with no WhatsApp
 * contract keeps working, and every OTP request honestly reports that delivery
 * is unavailable.
 */
@Injectable()
export class DisabledWhatsAppChannel implements WhatsAppChannel {
  readonly name = 'disabled';
  readonly isEnabled = false;

  send(_message: WhatsAppMessage): Promise<DeliveryResult> {
    return Promise.resolve({
      status: 'failed',
      reason: 'channel_unavailable',
      detail: 'No WhatsApp provider is configured for this deployment',
      provider: this.name,
    });
  }
}

/** One captured send, for assertions. Holds the code because tests must check it. */
export interface CapturedMessage extends WhatsAppMessage {
  sentAt: Date;
}

/**
 * Test-only, in-memory.
 *
 * Lets a test assert the exact template, language, destination and variables —
 * including the code — which is the only way to prove the OTP pipeline end to
 * end without a provider.
 *
 * **Never registered outside tests.** `MessagingModule` refuses to build it in
 * production, and this class holds plaintext codes in memory, so a production
 * registration would be a real leak rather than a tidiness problem.
 */
@Injectable()
export class TestWhatsAppChannel implements WhatsAppChannel {
  readonly name = 'test';
  readonly isEnabled = true;

  private readonly captured: CapturedMessage[] = [];
  /** Set to make the next sends fail, for failure-path tests. */
  nextResult: DeliveryResult | null = null;

  send(message: WhatsAppMessage): Promise<DeliveryResult> {
    this.captured.push({ ...message, sentAt: new Date() });
    if (this.nextResult) return Promise.resolve(this.nextResult);
    return Promise.resolve({
      status: 'accepted',
      providerMessageId: `test-${this.captured.length}`,
      provider: this.name,
    });
  }

  get messages(): readonly CapturedMessage[] {
    return this.captured;
  }

  get last(): CapturedMessage | undefined {
    return this.captured[this.captured.length - 1];
  }

  reset(): void {
    this.captured.length = 0;
    this.nextResult = null;
  }
}

/**
 * Local manual testing only.
 *
 * Prints the destination **masked** and the template, and writes the code to a
 * clearly-marked development sink so a developer can complete a flow by hand.
 * It is opt-in by environment and `MessagingModule` refuses to construct it
 * outside development.
 *
 * The code goes through `console.warn` with an unmistakable banner rather than
 * the application logger, deliberately: the app logger is what ships to a log
 * aggregator, and an OTP must never land there.
 */
@Injectable()
export class DevelopmentLogWhatsAppChannel implements WhatsAppChannel {
  readonly name = 'development-log';
  readonly isEnabled = true;
  private readonly logger = new Logger(DevelopmentLogWhatsAppChannel.name);

  send(message: WhatsAppMessage): Promise<DeliveryResult> {
    // Structured application log: no code, masked destination.
    this.logger.warn(
      `[DEV CHANNEL] template=${message.template} lang=${message.language} to=${maskDestination(message.to)}`,
    );
    // The local-development sink. Never the application logger.
    // eslint-disable-next-line no-console
    console.warn(
      `\n=== LOCAL DEV ONLY — NOT A REAL MESSAGE ===\n` +
        `  to:       ${maskDestination(message.to)}\n` +
        `  template: ${message.template} (${message.language})\n` +
        `  variables: ${JSON.stringify(message.variables)}\n` +
        `===========================================\n`,
    );
    return Promise.resolve({
      status: 'accepted',
      providerMessageId: null,
      provider: this.name,
    });
  }
}
