import { createHash } from 'node:crypto';
import type { SmtpConfig } from './smtp-email-channel';

/**
 * The operator's SMTP delivery proof (D200, docs/100 §7): one `delivery.check` email, through the reviewed SMTP
 * channel, to the one test address the operator holds, from the approved verification sender.
 *
 * Everything that decides who receives it and who it comes from is fixed here, not configurable: the sender and the
 * Reply-To are the approved TSX-MR addresses, the port is 587 (STARTTLS required, `smtp-email-channel.ts`), and the
 * recipient is read from a private file — never an argument, so it is in no shell history and no process list. The
 * proof never logs the address, only its masked form, and identifies the provider's message by a one-way reference.
 */
export const EMAIL_PROOF_SENDER = 'Dukan ERP <verification@tsxmr.com>';
export const EMAIL_PROOF_REPLY_TO = 'support@tsxmr.com';
export const EMAIL_PROOF_PORT = 587;

/** The one address in the recipient file. Anything but exactly one plain address is refused. */
export function readProofRecipient(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length !== 1) throw new Error('The recipient file must hold exactly one address.');
  const address = lines[0].toLowerCase();
  if (!/^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/.test(address)) throw new Error('The recipient file does not hold a plain email address.');
  return address;
}

/** A reference to the provider's message that a log may carry: one-way, short, stable for the same id. */
export function proofReference(providerMessageId: string | null | undefined): string {
  if (!providerMessageId) return 'none';
  return `sha256:${createHash('sha256').update(providerMessageId).digest('hex').slice(0, 16)}`;
}

/** The SMTP configuration of the proof: the deployment's relay and credentials, the approved sender and Reply-To. */
export function emailProofConfig(env: NodeJS.ProcessEnv): SmtpConfig {
  const host = (env.SMTP_HOST ?? '').trim();
  const port = Number((env.SMTP_PORT ?? '').trim() || EMAIL_PROOF_PORT);
  const username = (env.SMTP_USERNAME ?? '').trim();
  const password = env.SMTP_PASSWORD ?? '';
  if (!host) throw new Error('SMTP_HOST is not set.');
  if (port !== EMAIL_PROOF_PORT) throw new Error(`SMTP_PORT must be ${EMAIL_PROOF_PORT} (STARTTLS).`);
  if (!username || !password) throw new Error('The SMTP login and key are not available (SMTP_USERNAME_FILE, SMTP_PASSWORD_FILE).');
  return {
    host,
    port,
    username,
    password,
    senders: { verification: EMAIL_PROOF_SENDER, notifications: '', reports: '', receipts: '', fallback: '' },
    replyTo: EMAIL_PROOF_REPLY_TO,
    timeouts: { connectionMs: 15000, greetingMs: 15000, socketMs: 30000 },
  };
}
