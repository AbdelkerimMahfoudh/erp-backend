import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';

/**
 * Keyed recipient hashes for the message records (D181 §7).
 *
 * A phone number or an email address is enumerable: Mauritania has a few million numbers, so a plain SHA-256 of one
 * is reversed by hashing them all. Every record therefore keys its hash with a dedicated secret,
 * `MESSAGING_HASH_KEY` — never the OTP pepper, so rotating one never touches the other. Without the key a hash is
 * just noise; with it, the same number always gives the same hash, which is what lets an opt-out received on the
 * webhook find the number an Owner consented with.
 *
 * Production refuses to boot without the key whenever a real channel is configured (`production-guard.ts`).
 * Elsewhere a fixed development key stands in, said once in the log, so a developer's records still match each
 * other across restarts. It protects nothing, which is why production never uses it.
 */
export const DEVELOPMENT_HASH_KEY = 'development-only-messaging-hash-key-not-a-secret';

/** HMAC-SHA256 of the canonical form: an E.164 number as given, an email address lowercased and trimmed. */
export function recipientHash(recipient: string, key: string): string {
  const canonical = recipient.includes('@') ? recipient.trim().toLowerCase() : recipient.trim();
  return createHmac('sha256', key).update(`recipient:${canonical}`).digest('hex');
}

@Injectable()
export class RecipientHasher {
  private readonly logger = new Logger(RecipientHasher.name);
  private readonly key: string;

  constructor(config: AppConfigService) {
    const configured = config.messagingHashKey;
    if (configured) {
      this.key = configured;
    } else {
      this.key = DEVELOPMENT_HASH_KEY;
      if (config.isProduction) {
        // Unreachable when the production guard ran; said loudly in case a script skipped it.
        this.logger.error('MESSAGING_HASH_KEY is not set: message records are keyed with the development key');
      } else {
        this.logger.warn('MESSAGING_HASH_KEY is not set: message records use the development key (not for production)');
      }
    }
  }

  hash(recipient: string): string {
    return recipientHash(recipient, this.key);
  }
}
