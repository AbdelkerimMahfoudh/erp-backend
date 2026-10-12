import { Logger } from '@nestjs/common';
import type { DeliveryFailureReason, DeliveryResult, MessageLanguage } from './whatsapp-channel';

/**
 * The email boundary (correction phase, 2026-10-12).
 *
 * The same rules as the WhatsApp boundary, for the same reasons:
 *
 *  - **no raw-message call.** A caller names a template from {@link EMAIL_TEMPLATES} and supplies its variables;
 *    the subject and body are composed here, in EN/FR/AR, from text a person reviewed;
 *  - **no provider type escapes.** Failures are classified into the WhatsApp boundary's four reasons;
 *  - **nothing is claimed that did not happen.** `disabled` is the default and sends nothing; `development-log`
 *    writes the destination and template — never a code — and is refused in production; `resend` refuses to be
 *    built without its key and sender, and is refused in production over plain HTTP.
 *
 * No provider is connected by this file: `resend` stays inert until TSX-MR supplies an account, a verified sending
 * domain (SPF, DKIM, DMARC — docs/64) and a key, and approves the connection. The key lives in server-side
 * configuration only.
 */

export type EmailTemplateKey = 'contact.verification' | 'staff.invitation' | 'password.recovery' | 'security.alert';

export interface EmailMessage {
  /** Normalised, lowercased address. */
  to: string;
  template: EmailTemplateKey;
  language: MessageLanguage;
  variables: Record<string, string>;
  /** Passed to the provider so a retried send cannot duplicate a real message. */
  idempotencyKey: string;
}

export interface EmailChannel {
  readonly name: string;
  readonly isEnabled: boolean;
  send(message: EmailMessage): Promise<DeliveryResult>;
}

export const EMAIL_CHANNEL = Symbol('EMAIL_CHANNEL');

interface EmailTemplate {
  variables: readonly string[];
  /**
   * Wired to a flow, or held for one that does not exist yet. A held template cannot be sent: there is no
   * password-recovery flow and no security-alert trigger in the backend today, and deletion codes go by WhatsApp
   * only — email deletion codes are not approved (docs/24).
   */
  wired: boolean;
  subject: Record<MessageLanguage, string>;
  body: Record<MessageLanguage, string>;
}

/** Text a person reviewed. `{name}` placeholders only; nothing else is interpolated. */
export const EMAIL_TEMPLATES: Record<EmailTemplateKey, EmailTemplate> = {
  'contact.verification': {
    variables: ['code', 'ttlMinutes'],
    wired: true,
    subject: { en: 'Your Dukan ERP code', fr: 'Votre code Dukan ERP', ar: 'رمز Dukan ERP الخاص بك' },
    body: {
      en: 'Your Dukan ERP verification code is {code}. It expires in {ttlMinutes} minutes. If you did not ask for it, ignore this email.\n\nDukan ERP is developed and operated by TSX-MR.',
      fr: 'Votre code de vérification Dukan ERP est {code}. Il expire dans {ttlMinutes} minutes. Si vous ne l’avez pas demandé, ignorez cet e-mail.\n\nDukan ERP est développé et exploité par TSX-MR.',
      ar: 'رمز التحقق الخاص بك في Dukan ERP هو {code}. تنتهي صلاحيته خلال {ttlMinutes} دقائق. إن لم تطلبه، فتجاهل هذه الرسالة.\n\nتطوّر TSX-MR منصة Dukan ERP وتشغّلها.',
    },
  },
  'staff.invitation': {
    variables: ['code', 'ttlMinutes', 'business'],
    // Invitations go out today as a contact verification code; this text waits for an invitation flow of its own.
    wired: false,
    subject: { en: 'You were added to {business} on Dukan ERP', fr: 'Vous avez été ajouté à {business} sur Dukan ERP', ar: 'أُضفت إلى {business} على Dukan ERP' },
    body: {
      en: '{business} added you on Dukan ERP. Your code is {code}; it expires in {ttlMinutes} minutes. Open the Dukan ERP app to finish.\n\nDukan ERP is developed and operated by TSX-MR.',
      fr: '{business} vous a ajouté sur Dukan ERP. Votre code est {code} ; il expire dans {ttlMinutes} minutes. Ouvrez l’application Dukan ERP pour terminer.\n\nDukan ERP est développé et exploité par TSX-MR.',
      ar: 'أضافك {business} على Dukan ERP. رمزك هو {code}، وتنتهي صلاحيته خلال {ttlMinutes} دقائق. افتح تطبيق Dukan ERP لإكمال العملية.\n\nتطوّر TSX-MR منصة Dukan ERP وتشغّلها.',
    },
  },
  'password.recovery': {
    variables: ['code', 'ttlMinutes'],
    wired: false,
    subject: { en: 'Reset your Dukan ERP password', fr: 'Réinitialiser votre mot de passe Dukan ERP', ar: 'إعادة تعيين كلمة مرور Dukan ERP' },
    body: {
      en: 'Your Dukan ERP password reset code is {code}. It expires in {ttlMinutes} minutes. If you did not ask for it, your password is unchanged.',
      fr: 'Votre code de réinitialisation Dukan ERP est {code}. Il expire dans {ttlMinutes} minutes. Si vous ne l’avez pas demandé, votre mot de passe reste inchangé.',
      ar: 'رمز إعادة تعيين كلمة مرور Dukan ERP هو {code}. تنتهي صلاحيته خلال {ttlMinutes} دقائق. إن لم تطلبه، فكلمة مرورك لم تتغير.',
    },
  },
  'security.alert': {
    variables: ['what', 'when'],
    wired: false,
    subject: { en: 'Dukan ERP security notice', fr: 'Avis de sécurité Dukan ERP', ar: 'تنبيه أمني من Dukan ERP' },
    body: {
      en: '{what} on your Dukan ERP account at {when}. If this was not you, change your password and contact your business owner.',
      fr: '{what} sur votre compte Dukan ERP le {when}. Si ce n’était pas vous, changez votre mot de passe et contactez le propriétaire de votre commerce.',
      ar: '{what} على حسابك في Dukan ERP بتاريخ {when}. إن لم تكن أنت، فغيّر كلمة مرورك وتواصل مع مالك متجرك.',
    },
  },
};

/** Subject and body, or a refusal: an unknown, held, incomplete or over-filled template never reaches a provider. */
export function composeEmail(message: Pick<EmailMessage, 'template' | 'language' | 'variables'>): { subject: string; text: string } {
  const template = EMAIL_TEMPLATES[message.template];
  if (!template) throw new Error(`Unknown email template "${message.template}"`);
  if (!template.wired) throw new Error(`Email template "${message.template}" is not wired to any flow and cannot be sent`);
  const given = Object.keys(message.variables).sort();
  const wanted = [...template.variables].sort();
  if (given.join() !== wanted.join() || template.variables.some((v) => !message.variables[v]?.trim())) {
    throw new Error(`Email template "${message.template}" needs exactly: ${template.variables.join(', ')}`);
  }
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => message.variables[k]);
  return { subject: fill(template.subject[message.language]), text: fill(template.body[message.language]) };
}

const failed = (provider: string, reason: DeliveryFailureReason, detail: string): DeliveryResult => ({ status: 'failed', reason, detail, provider });

export class DisabledEmailChannel implements EmailChannel {
  readonly name = 'disabled';
  readonly isEnabled = false;
  async send(): Promise<DeliveryResult> {
    return failed(this.name, 'channel_unavailable', 'No email provider is configured');
  }
}

/** Development only: writes that a message would go out — never its code. Refused in production. */
export class DevelopmentLogEmailChannel implements EmailChannel {
  readonly name = 'development-log';
  readonly isEnabled = true;
  private readonly log = new Logger('EmailDevelopmentLog');
  async send(message: EmailMessage): Promise<DeliveryResult> {
    composeEmail(message);
    this.log.log(`email "${message.template}" (${message.language}) would go to ${maskEmail(message.to)}`);
    return { status: 'accepted', providerMessageId: null, provider: this.name };
  }
}

export interface ResendConfig {
  baseUrl: string;
  apiKey: string;
  from: string;
  replyTo: string;
  timeoutMs: number;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). Inert until configured. */
export class ResendEmailChannel implements EmailChannel {
  readonly name = 'resend';
  readonly isEnabled = true;
  constructor(
    private readonly config: ResendConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
  ) {}

  async send(message: EmailMessage): Promise<DeliveryResult> {
    let composed: { subject: string; text: string };
    try {
      composed = composeEmail(message);
    } catch {
      return failed(this.name, 'rejected', 'The email template could not be composed');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, '')}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          ...(this.config.replyTo ? { reply_to: this.config.replyTo } : {}),
          subject: composed.subject,
          text: composed.text,
        }),
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) {
        const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
        return { status: 'accepted', providerMessageId: typeof body?.id === 'string' ? body.id : null, provider: this.name };
      }
      if (res.status === 401 || res.status === 403) return failed(this.name, 'not_authorized', `Provider refused the credentials (${res.status})`);
      if (res.status === 429 || res.status >= 500) return failed(this.name, 'temporary', `Provider unavailable (${res.status})`);
      return failed(this.name, 'rejected', `Provider rejected the message (${res.status})`);
    } catch {
      return failed(this.name, 'temporary', 'The provider could not be reached');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Enough of an address to recognise it in a log, never enough to write to it. */
export function maskEmail(address: string): string {
  const [local, domain] = address.split('@');
  if (!domain) return '***';
  return `${(local ?? '').slice(0, 1)}***@${domain}`;
}

export interface EmailSelection {
  channel: string;
  isProduction: boolean;
  resend?: ResendConfig | null;
}

export function createEmailChannel(selection: EmailSelection): EmailChannel {
  const choice = (selection.channel || 'disabled').trim().toLowerCase();
  if (choice === 'disabled') return new DisabledEmailChannel();
  if (choice === 'development-log') {
    if (selection.isProduction) throw new Error('EMAIL_CHANNEL=development-log is not permitted in production. Use "resend" with real credentials, or "disabled".');
    return new DevelopmentLogEmailChannel();
  }
  if (choice === 'resend') {
    const c = selection.resend;
    if (!c || !c.apiKey.trim() || !c.from.trim()) {
      throw new Error('EMAIL_CHANNEL=resend needs RESEND_API_KEY and EMAIL_FROM. Nothing is faked: set them, or set EMAIL_CHANNEL=disabled.');
    }
    if (selection.isProduction && !/^https:\/\//i.test(c.baseUrl)) throw new Error('RESEND_API_BASE_URL must be an https:// address in production.');
    return new ResendEmailChannel(c);
  }
  throw new Error(`Unknown EMAIL_CHANNEL "${selection.channel}". Valid values: disabled, development-log (non-production only), resend.`);
}
