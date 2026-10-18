import { Logger } from '@nestjs/common';
import type { DeliveryFailureReason, DeliveryResult, MessageLanguage } from './whatsapp-channel';
import { SmtpEmailChannel, type SmtpConfig } from './smtp-email-channel';

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
 *    built without its key and sender, and is refused in production over plain HTTP; `smtp` (Brevo, D181) refuses
 *    to be built without its credentials and a sender (`smtp-email-channel.ts`).
 *
 * Every email carries a plain-text and an HTML alternative composed here from the same reviewed text: every variable
 * HTML-escaped, Arabic laid out right to left, no remote image, no tracking pixel, no stylesheet from anywhere. The
 * From address follows the message's class ({@link senderFor}); Reply-To is the support address.
 *
 * `resend` stays dormant (D181 §2). The credentials of either provider live in server-side configuration only.
 */

export type EmailTemplateKey = 'contact.verification' | 'staff.invitation' | 'password.recovery' | 'security.alert' | 'trial.setup' | 'delivery.check';

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

/**
 * Which From address a message goes out under (D181): codes and security messages from the verification sender,
 * operational messages from the notifications sender. The report and receipt senders exist in configuration only —
 * no report or receipt email is sent (D111).
 */
export type EmailSenderClass = 'verification' | 'notifications';

export interface EmailSenders {
  verification: string;
  notifications: string;
  reports: string;
  receipts: string;
  /** EMAIL_FROM (no-reply@…): used for any class whose own sender is empty. */
  fallback: string;
}

interface EmailTemplate {
  /** The From address class. */
  sender: EmailSenderClass;
  /**
   * A code or a security message the person needs now: it may use the reserve of the daily safety limit
   * (`email-log.ts`). Everything else stops at the limit minus the reserve.
   */
  essential: boolean;
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
    sender: 'verification',
    essential: true,
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
    sender: 'verification',
    essential: true,
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
    sender: 'verification',
    essential: true,
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
    sender: 'verification',
    essential: true,
    variables: ['what', 'when'],
    wired: false,
    subject: { en: 'Dukan ERP security notice', fr: 'Avis de sécurité Dukan ERP', ar: 'تنبيه أمني من Dukan ERP' },
    body: {
      en: '{what} on your Dukan ERP account at {when}. If this was not you, change your password and contact your business owner.',
      fr: '{what} sur votre compte Dukan ERP le {when}. Si ce n’était pas vous, changez votre mot de passe et contactez le propriétaire de votre commerce.',
      ar: '{what} على حسابك في Dukan ERP بتاريخ {when}. إن لم تكن أنت، فغيّر كلمة مرورك وتواصل مع مالك متجرك.',
    },
  },
  /*
   * The free trial's setup instructions (0095; docs/76): sent once the Owner's required contacts are verified, and
   * again only when the Owner, signed in on the website, asks. `{link}` is the website's page with the one-time setup
   * token in its fragment: it opens a page and starts nothing — the trial starts only on the Owner's explicit
   * confirmation there, and an Owner who signs in without the link sees the same offer. No price, no amount, no
   * payment instruction: the one sentence about money says that none is required.
   */
  'trial.setup': {
    sender: 'notifications',
    essential: false,
    variables: ['business', 'link'],
    wired: true,
    subject: {
      en: 'Your Dukan ERP free trial is ready to start',
      fr: 'Votre essai gratuit Dukan ERP est prêt à démarrer',
      ar: 'فترتك التجريبية المجانية في Dukan ERP جاهزة للبدء',
    },
    body: {
      en: '{business} is eligible for a 7-day free trial of Dukan ERP. Your trial has not started.\n\nTo start it, open this link, sign in, and confirm "Start my 7-day free trial" on the Dukan ERP website:\n{link}\n\nThe trial lasts 7 days from the moment you confirm it. No payment is required. The link expires in 24 hours and works for your account only; after it expires, sign in on the Dukan ERP website to start your trial or to get a new link. If you did not create this account, ignore this email.\n\nNeed help? Contact Dukan ERP support.\n\nDukan ERP is developed and operated by TSX-MR.',
      fr: '{business} peut bénéficier d’un essai gratuit de 7 jours de Dukan ERP. Votre essai n’a pas commencé.\n\nPour le démarrer, ouvrez ce lien, connectez-vous et confirmez « Démarrer mon essai gratuit de 7 jours » sur le site Dukan ERP :\n{link}\n\nL’essai dure 7 jours à partir de votre confirmation. Aucun paiement n’est demandé. Le lien expire dans 24 heures et ne fonctionne que pour votre compte ; ensuite, connectez-vous sur le site Dukan ERP pour démarrer votre essai ou recevoir un nouveau lien. Si vous n’avez pas créé ce compte, ignorez cet e-mail.\n\nBesoin d’aide ? Contactez l’assistance Dukan ERP.\n\nDukan ERP est développé et exploité par TSX-MR.',
      ar: '{business} مؤهل لفترة تجريبية مجانية من Dukan ERP مدتها 7 أيام. لم تبدأ فترتك التجريبية بعد.\n\nلبدئها، افتح هذا الرابط وسجّل الدخول ثم أكّد «ابدأ فترتي التجريبية المجانية لمدة 7 أيام» على موقع Dukan ERP:\n{link}\n\nتستمر الفترة التجريبية 7 أيام من لحظة تأكيدك. لا يلزم أي دفع. تنتهي صلاحية الرابط خلال 24 ساعة ويعمل لحسابك فقط، وبعد ذلك سجّل الدخول على موقع Dukan ERP لبدء فترتك التجريبية أو للحصول على رابط جديد. إن لم تُنشئ هذا الحساب، فتجاهل هذه الرسالة.\n\nهل تحتاج إلى مساعدة؟ تواصل مع دعم Dukan ERP.\n\nتطوّر TSX-MR منصة Dukan ERP وتشغّلها.',
    },
  },
  /*
   * The operator's delivery proof (D200, docs/100 §7): sent by `scripts/email-prove.ts` only, one message per run, to
   * the one test address the operator holds. It carries nothing a person could act on or misuse: no code, no link, no
   * customer or business data, no variable at all — it says what it is and that nothing is required.
   */
  'delivery.check': {
    sender: 'verification',
    essential: false,
    variables: [],
    wired: true,
    subject: { en: 'Dukan ERP delivery test', fr: 'Test de distribution Dukan ERP', ar: 'اختبار إيصال من Dukan ERP' },
    body: {
      en: 'This is a Dukan ERP delivery test. No action is required.\n\nThe Dukan ERP operator sent it once, to check that email from Dukan ERP is delivered. It contains no code and no link.\n\nDukan ERP is developed and operated by TSX-MR.',
      fr: 'Ceci est un test de distribution de Dukan ERP. Aucune action n’est requise.\n\nL’opérateur de Dukan ERP l’a envoyé une seule fois, pour vérifier que les e-mails de Dukan ERP sont bien distribués. Il ne contient ni code ni lien.\n\nDukan ERP est développé et exploité par TSX-MR.',
      ar: 'هذه رسالة اختبار إيصال من Dukan ERP. لا يلزم القيام بأي إجراء.\n\nأرسلها مشغّل Dukan ERP مرة واحدة للتحقق من وصول رسائل البريد الإلكتروني الصادرة عن Dukan ERP. لا تحتوي على أي رمز أو رابط.\n\nتطوّر TSX-MR منصة Dukan ERP وتشغّلها.',
    },
  },
};

/** The template's sender class and whether it is essential; undefined for an unknown template. */
export function emailTemplateClass(template: string): { sender: EmailSenderClass; essential: boolean } | undefined {
  const t = (EMAIL_TEMPLATES as Record<string, EmailTemplate | undefined>)[template];
  return t ? { sender: t.sender, essential: t.essential } : undefined;
}

/** The From address for a template: its class's sender, or EMAIL_FROM when that class has none. Empty if neither. */
export function senderFor(template: EmailTemplateKey, senders: EmailSenders): string {
  const cls = emailTemplateClass(template)?.sender;
  return ((cls ? senders[cls] : '') || senders.fallback || '').trim();
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Variables shown left to right inside any paragraph (a code, an address), so Arabic text never reorders them. */
const LTR_VARIABLES = new Set(['code', 'link']);

/**
 * The HTML alternative: the same reviewed text, paragraph for paragraph. Each variable is escaped; a `link` that is
 * an https:// address becomes a link to itself (the address shown is the address followed); nothing else is markup.
 */
export function renderEmailHtml(language: MessageLanguage, subject: string, body: string, variables: Record<string, string>): string {
  const rtl = language === 'ar';
  const fill = (line: string) =>
    escapeHtml(line).replace(/\{(\w+)\}/g, (_, k: string) => {
      const value = variables[k] ?? '';
      const safe = escapeHtml(value);
      if (k === 'link' && /^https:\/\/[^\s"'<>]+$/.test(value)) return `<a href="${safe}" dir="ltr" style="color:#0b57d0;word-break:break-all">${safe}</a>`;
      if (k === 'code') return `<strong dir="ltr" style="font-size:20px;letter-spacing:2px">${safe}</strong>`;
      return LTR_VARIABLES.has(k) ? `<span dir="ltr">${safe}</span>` : safe;
    });
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${p.split('\n').map(fill).join('<br>')}</p>`)
    .join('');
  return (
    `<!doctype html><html lang="${language}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px 16px;background:#ffffff;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">` +
    `<div dir="${rtl ? 'rtl' : 'ltr'}" style="max-width:560px;margin:0 auto;text-align:${rtl ? 'right' : 'left'}">${paragraphs}</div></body></html>`
  );
}

/** Subject and body, or a refusal: an unknown, held, incomplete or over-filled template never reaches a provider. */
export function composeEmail(message: Pick<EmailMessage, 'template' | 'language' | 'variables'>): { subject: string; text: string; html: string } {
  const template = EMAIL_TEMPLATES[message.template];
  if (!template) throw new Error(`Unknown email template "${message.template}"`);
  if (!template.wired) throw new Error(`Email template "${message.template}" is not wired to any flow and cannot be sent`);
  const given = Object.keys(message.variables).sort();
  const wanted = [...template.variables].sort();
  if (given.join() !== wanted.join() || template.variables.some((v) => !message.variables[v]?.trim())) {
    throw new Error(`Email template "${message.template}" needs exactly: ${template.variables.join(', ')}`);
  }
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => message.variables[k]);
  const subject = fill(template.subject[message.language]);
  return {
    subject,
    text: fill(template.body[message.language]),
    html: renderEmailHtml(message.language, subject, template.body[message.language], message.variables),
  };
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
    let composed: { subject: string; text: string; html: string };
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
  smtp?: SmtpConfig | null;
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
  if (choice === 'smtp') {
    const c = selection.smtp;
    if (!c || !c.username.trim() || !c.password || !c.host.trim()) {
      throw new Error('EMAIL_CHANNEL=smtp needs SMTP_HOST, SMTP_USERNAME and SMTP_PASSWORD. Nothing is faked: set them, or set EMAIL_CHANNEL=disabled.');
    }
    if (!c.senders.fallback.trim() && !c.senders.verification.trim()) {
      throw new Error('EMAIL_CHANNEL=smtp needs a sender: EMAIL_FROM, or EMAIL_FROM_VERIFICATION and EMAIL_FROM_NOTIFICATIONS.');
    }
    if (selection.isProduction && c.port !== 587) throw new Error('SMTP_PORT must be 587 (STARTTLS) in production.');
    return new SmtpEmailChannel(c);
  }
  throw new Error(`Unknown EMAIL_CHANNEL "${selection.channel}". Valid values: disabled, development-log (non-production only), resend, smtp.`);
}
