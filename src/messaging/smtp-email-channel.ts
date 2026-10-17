import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { DeliveryFailureReason, DeliveryResult } from './whatsapp-channel';
import { composeEmail, maskEmail, senderFor, type EmailChannel, type EmailMessage, type EmailSenders } from './email-channel';

/**
 * Transactional email over SMTP — Brevo's relay (D181).
 *
 * The connection is fixed, not configurable: STARTTLS is required (a server that does not offer it is refused, never
 * used in clear), TLS 1.2 is the minimum, the certificate is verified, and every phase has a finite timeout. Debug
 * logging is off, and no error ever carries the transport's own message — only its code — so neither the password
 * nor a recipient can reach a log or a caller.
 *
 * A retry of the same message (the same idempotency key, the same code) carries the same Message-ID, so a recipient
 * whose first copy did arrive after an ambiguous timeout sees one message — or two identical ones, both valid.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  /** Secret. Given to the transport and nothing else. */
  password: string;
  senders: EmailSenders;
  /** support@… — every email's Reply-To. */
  replyTo: string;
  timeouts: { connectionMs: number; greetingMs: number; socketMs: number };
}

/** The part of a nodemailer transport this channel uses; a fake in tests. */
export interface SmtpTransport {
  sendMail(mail: nodemailer.SendMailOptions): Promise<{ messageId?: string }>;
}

/** The transport options, exposed so a test can prove them without opening a connection. */
export function smtpTransportOptions(cfg: SmtpConfig) {
  return {
    host: cfg.host,
    port: cfg.port,
    // 587: plain connect, then STARTTLS — required, never optional.
    secure: false,
    requireTLS: true,
    ignoreTLS: false,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { minVersion: 'TLSv1.2' as const, rejectUnauthorized: true, servername: cfg.host },
    connectionTimeout: cfg.timeouts.connectionMs,
    greetingTimeout: cfg.timeouts.greetingMs,
    socketTimeout: cfg.timeouts.socketMs,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function createSmtpTransport(cfg: SmtpConfig): SmtpTransport {
  return nodemailer.createTransport(smtpTransportOptions(cfg));
}

const TEMPORARY_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNRESET', 'ECONNREFUSED', 'ETLS', 'EPROTOCOL']);

/**
 * The transport's failure in the boundary's terms, from its code and SMTP reply code only. The reply TEXT is never
 * read: servers echo addresses and usernames in it.
 */
export function classifySmtpFailure(error: unknown): { reason: DeliveryFailureReason; detail: string } {
  const e = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof e.code === 'string' ? e.code.replace(/[^A-Z_]/g, '').slice(0, 20) : '';
  const reply = typeof e.responseCode === 'number' ? e.responseCode : null;
  const label = `SMTP ${code || 'error'}${reply !== null ? ` ${reply}` : ''}`;
  if (code === 'EAUTH' || reply === 535 || reply === 534 || reply === 530) {
    return { reason: 'not_authorized', detail: `${label}: the SMTP server refused the credentials` };
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return { reason: 'rejected', detail: `${label}: the message or recipient was refused` };
  if (reply !== null && reply >= 500) return { reason: 'rejected', detail: `${label}: the message was refused` };
  if (reply !== null && reply >= 400) return { reason: 'temporary', detail: `${label}: the server asked to try later` };
  if (TEMPORARY_CODES.has(code)) return { reason: 'temporary', detail: `${label}: the server could not be reached or did not answer` };
  return { reason: 'temporary', detail: `${label}: the message could not be handed over` };
}

/** `<hash@domain>`: stable for one logical message, revealing nothing about it. */
export function messageIdFor(idempotencyKey: string, from: string): string {
  const address = from.replace(/^.*<([^>]+)>\s*$/, '$1');
  const domain = address.split('@')[1]?.replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  return `<${createHash('sha256').update(`email:${idempotencyKey}`).digest('hex').slice(0, 40)}@${domain}>`;
}

export class SmtpEmailChannel implements EmailChannel {
  readonly name = 'smtp';
  readonly isEnabled = true;
  private readonly logger = new Logger(SmtpEmailChannel.name);
  private readonly transport: SmtpTransport;

  constructor(
    private readonly cfg: SmtpConfig,
    transport?: SmtpTransport,
  ) {
    this.transport = transport ?? createSmtpTransport(cfg);
  }

  async send(message: EmailMessage): Promise<DeliveryResult> {
    let composed: { subject: string; text: string; html: string };
    try {
      composed = composeEmail(message);
    } catch {
      return this.failed('rejected', 'The email template could not be composed');
    }
    const from = senderFor(message.template, this.cfg.senders);
    if (!from) return this.failed('rejected', 'No sender is configured for this message class');
    const messageId = messageIdFor(message.idempotencyKey, from);
    try {
      const info = await this.transport.sendMail({
        from,
        to: message.to,
        ...(this.cfg.replyTo ? { replyTo: this.cfg.replyTo } : {}),
        subject: composed.subject,
        text: composed.text,
        html: composed.html,
        messageId,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return { status: 'accepted', providerMessageId: (info?.messageId ?? messageId).slice(0, 191), provider: this.name };
    } catch (e) {
      const { reason, detail } = classifySmtpFailure(e);
      this.logger.warn(`Email "${message.template}" to ${maskEmail(message.to)} not handed over: ${detail}`);
      return this.failed(reason, detail);
    }
  }

  private failed(reason: DeliveryFailureReason, detail: string): DeliveryResult {
    return { status: 'failed', reason, detail, provider: this.name };
  }
}
