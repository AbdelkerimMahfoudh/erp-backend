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

export type EmailTemplateKey =
  | 'contact.verification'
  | 'staff.invitation'
  | 'password.recovery'
  | 'security.alert'
  | SubscriptionEmailKey
  | 'delivery.check';

/** The portal instructions and the subscription lifecycle messages (0099; docs/101 §7): the WhatsApp templates' keys. */
export type SubscriptionEmailKey =
  | 'portal.instructions'
  | 'subscription.trial_reminder'
  | 'subscription.trial_expired'
  | 'subscription.paid_reminder'
  | 'subscription.grace_started'
  | 'subscription.no_grace'
  | 'subscription.grace_reminder'
  | 'subscription.grace_ended';

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

const HELP: Record<MessageLanguage, string> = {
  en: '\n\nNeed help? Contact Dukan ERP support.\n\nDukan ERP is developed and operated by TSX-MR.',
  fr: '\n\nBesoin d’aide ? Contactez l’assistance Dukan ERP.\n\nDukan ERP est développé et exploité par TSX-MR.',
  ar: '\n\nهل تحتاج إلى مساعدة؟ تواصل مع دعم Dukan ERP.\n\nتطوّر TSX-MR منصة Dukan ERP وتشغّلها.',
};

/** What read-only means, said the same way in every message that announces it. */
const READ_ONLY: Record<MessageLanguage, string> = {
  en: 'The app is now read-only: your records stay readable, but new sales and changes are paused until the subscription is renewed.',
  fr: 'L’application est désormais en lecture seule : vos données restent consultables, mais les nouvelles ventes et modifications sont suspendues jusqu’au renouvellement de l’abonnement.',
  ar: 'أصبح التطبيق الآن للقراءة فقط: تبقى سجلاتك متاحة للاطلاع، لكن المبيعات الجديدة والتعديلات متوقفة إلى أن يُجدَّد الاشتراك.',
};

const RENEW: Record<MessageLanguage, string> = {
  en: 'To renew, sign in at {link}.',
  fr: 'Pour renouveler, connectez-vous sur {link}.',
  ar: 'للتجديد، سجّل الدخول على {link}.',
};

const withHelp = (body: Record<MessageLanguage, string>): Record<MessageLanguage, string> => ({
  en: body.en + HELP.en,
  fr: body.fr + HELP.fr,
  ar: body.ar + HELP.ar,
});

const subscriptionEmail = (
  variables: readonly string[],
  subject: Record<MessageLanguage, string>,
  body: Record<MessageLanguage, string>,
): EmailTemplate => ({ sender: 'notifications', essential: false, variables: [...variables, 'link'], wired: true, subject, body: withHelp(body) });

/*
 * The portal instructions and the subscription lifecycle messages (0099; the owner's brief of 2026-10-18; docs/101 §7)
 * — the email each WhatsApp template falls back to, under the recorded conditions only (`notices/notice-rules.ts`).
 *
 * The same facts as the WhatsApp copy, with `{link}`: always the portal's one address, https://dukan.tsxmr.com/
 * subscription — never a token, a customer identifier or anything built per person. No price, no amount, no payment
 * instruction. A free trial's messages never mention grace except to say there is none; a paid expiry says which it
 * is: grace started, with its exact end and the uses left, or none, because the three of the last 12 months are used.
 */
const SUBSCRIPTION_EMAILS: Record<SubscriptionEmailKey, EmailTemplate> = {
  'portal.instructions': subscriptionEmail(
    ['business'],
    {
      en: 'Start your Dukan ERP free trial',
      fr: 'Démarrez votre essai gratuit Dukan ERP',
      ar: 'ابدأ فترتك التجريبية المجانية في Dukan ERP',
    },
    {
      en: '{business} can start one 7-day free trial of Dukan ERP. It has not started yet.\n\nTo start it, go to {link}, sign in with the same details you use in the Dukan ERP app, and confirm.\n\nThe trial starts as soon as you confirm and lasts exactly 7 days (168 hours). It cannot be paused or restarted. No payment is required. If you did not create this account, ignore this email.',
      fr: '{business} peut démarrer un essai gratuit de 7 jours de Dukan ERP. Il n’a pas encore commencé.\n\nPour le démarrer, rendez-vous sur {link}, connectez-vous avec les mêmes identifiants que dans l’application Dukan ERP, puis confirmez.\n\nL’essai commence dès votre confirmation et dure exactement 7 jours (168 heures). Il ne peut être ni mis en pause ni redémarré. Aucun paiement n’est demandé. Si vous n’avez pas créé ce compte, ignorez cet e-mail.',
      ar: '{business} مؤهل لفترة تجريبية مجانية واحدة من Dukan ERP مدتها 7 أيام، ولم تبدأ بعد.\n\nلبدئها، انتقل إلى {link} وسجّل الدخول بالبيانات نفسها التي تستخدمها في تطبيق Dukan ERP، ثم أكّد.\n\nتبدأ الفترة التجريبية فور تأكيدك وتستمر 7 أيام بالضبط (168 ساعة)، ولا يمكن إيقافها مؤقتًا أو إعادة بدئها. لا يلزم أي دفع. إن لم تُنشئ هذا الحساب، فتجاهل هذه الرسالة.',
    },
  ),
  'subscription.trial_reminder': subscriptionEmail(
    ['business', 'remaining', 'ends'],
    {
      en: 'Your Dukan ERP free trial ends in {remaining}',
      fr: 'Votre essai gratuit Dukan ERP se termine dans {remaining}',
      ar: 'تنتهي فترتك التجريبية المجانية في Dukan ERP خلال {remaining}',
    },
    {
      en: 'The free trial of {business} on Dukan ERP ends in {remaining}, on {ends}.\n\nFree trials have no grace period: when the trial ends, the app becomes read-only. Your records stay readable, but new sales and changes stop until a subscription starts.\n\nTo choose a subscription, sign in at {link}.',
      fr: 'L’essai gratuit de {business} sur Dukan ERP se termine dans {remaining}, le {ends}.\n\nLes essais gratuits n’ont pas de période de grâce : à la fin de l’essai, l’application passe en lecture seule. Vos données restent consultables, mais les nouvelles ventes et modifications s’arrêtent jusqu’au début d’un abonnement.\n\nPour choisir un abonnement, connectez-vous sur {link}.',
      ar: 'تنتهي الفترة التجريبية المجانية لـ{business} في Dukan ERP خلال {remaining}، في {ends}.\n\nلا توجد فترة سماح للفترات التجريبية المجانية: عند انتهاء الفترة التجريبية يصبح التطبيق للقراءة فقط. تبقى سجلاتك متاحة للاطلاع، لكن المبيعات الجديدة والتعديلات تتوقف إلى أن يبدأ اشتراك.\n\nلاختيار اشتراك، سجّل الدخول على {link}.',
    },
  ),
  'subscription.trial_expired': subscriptionEmail(
    ['business', 'ended'],
    {
      en: 'Your Dukan ERP free trial has ended',
      fr: 'Votre essai gratuit Dukan ERP est terminé',
      ar: 'انتهت فترتك التجريبية المجانية في Dukan ERP',
    },
    {
      en: 'The free trial of {business} on Dukan ERP ended on {ended}.\n\nThe app is now read-only: your records stay readable, but new sales and changes are paused until a subscription starts. Free trials have no grace period.\n\nTo start a subscription, sign in at {link}.',
      fr: 'L’essai gratuit de {business} sur Dukan ERP s’est terminé le {ended}.\n\nL’application est désormais en lecture seule : vos données restent consultables, mais les nouvelles ventes et modifications sont suspendues jusqu’au début d’un abonnement. Les essais gratuits n’ont pas de période de grâce.\n\nPour démarrer un abonnement, connectez-vous sur {link}.',
      ar: 'انتهت الفترة التجريبية المجانية لـ{business} في Dukan ERP في {ended}.\n\nأصبح التطبيق الآن للقراءة فقط: تبقى سجلاتك متاحة للاطلاع، لكن المبيعات الجديدة والتعديلات متوقفة إلى أن يبدأ اشتراك. لا توجد فترة سماح للفترات التجريبية المجانية.\n\nلبدء اشتراك، سجّل الدخول على {link}.',
    },
  ),
  'subscription.paid_reminder': subscriptionEmail(
    ['business', 'remaining', 'ends'],
    {
      en: 'Your Dukan ERP subscription ends in {remaining}',
      fr: 'Votre abonnement Dukan ERP se termine dans {remaining}',
      ar: 'ينتهي اشتراكك في Dukan ERP خلال {remaining}',
    },
    {
      en: `The Dukan ERP subscription of {business} ends in {remaining}, on {ends}.\n\n${RENEW.en}`,
      fr: `L’abonnement Dukan ERP de {business} se termine dans {remaining}, le {ends}.\n\n${RENEW.fr}`,
      ar: `ينتهي اشتراك {business} في Dukan ERP خلال {remaining}، في {ends}.\n\n${RENEW.ar}`,
    },
  ),
  'subscription.grace_started': subscriptionEmail(
    ['business', 'ended', 'graceEnds', 'usesLeft'],
    {
      en: 'Your Dukan ERP subscription has ended: 72 hours of grace',
      fr: 'Votre abonnement Dukan ERP est terminé : 72 heures de grâce',
      ar: 'انتهى اشتراكك في Dukan ERP: فترة سماح مدتها 72 ساعة',
    },
    {
      en: `The Dukan ERP subscription of {business} ended on {ended}.\n\nA 72-hour grace period has started: the app keeps working until {graceEnds}. After that it becomes read-only until the subscription is renewed.\n\nA business can receive 3 grace periods in any 12 months. Grace periods left after this one: {usesLeft}.\n\n${RENEW.en}`,
      fr: `L’abonnement Dukan ERP de {business} s’est terminé le {ended}.\n\nUne période de grâce de 72 heures a commencé : l’application continue de fonctionner jusqu’au {graceEnds}. Ensuite, elle passera en lecture seule jusqu’au renouvellement de l’abonnement.\n\nUn commerce peut bénéficier de 3 périodes de grâce sur 12 mois glissants. Périodes de grâce restantes après celle-ci : {usesLeft}.\n\n${RENEW.fr}`,
      ar: `انتهى اشتراك {business} في Dukan ERP في {ended}.\n\nبدأت فترة سماح مدتها 72 ساعة: يستمر التطبيق في العمل حتى {graceEnds}، ثم يصبح للقراءة فقط إلى أن يُجدَّد الاشتراك.\n\nيحق لكل متجر 3 فترات سماح خلال أي 12 شهرًا. فترات السماح المتبقية بعد هذه الفترة: {usesLeft}.\n\n${RENEW.ar}`,
    },
  ),
  'subscription.no_grace': subscriptionEmail(
    ['business', 'ended'],
    {
      en: 'Your Dukan ERP subscription has ended',
      fr: 'Votre abonnement Dukan ERP est terminé',
      ar: 'انتهى اشتراكك في Dukan ERP',
    },
    {
      en: `The Dukan ERP subscription of {business} ended on {ended}.\n\nThere is no grace period this time: this business has already used its 3 grace periods of the last 12 months. ${READ_ONLY.en}\n\n${RENEW.en}`,
      fr: `L’abonnement Dukan ERP de {business} s’est terminé le {ended}.\n\nIl n’y a pas de période de grâce cette fois : ce commerce a déjà utilisé ses 3 périodes de grâce des 12 derniers mois. ${READ_ONLY.fr}\n\n${RENEW.fr}`,
      ar: `انتهى اشتراك {business} في Dukan ERP في {ended}.\n\nلا توجد فترة سماح هذه المرة: استخدم هذا المتجر فترات السماح الثلاث المتاحة له خلال آخر 12 شهرًا. ${READ_ONLY.ar}\n\n${RENEW.ar}`,
    },
  ),
  'subscription.grace_reminder': subscriptionEmail(
    ['business', 'remaining', 'graceEnds'],
    {
      en: 'Your Dukan ERP grace period ends in {remaining}',
      fr: 'Votre période de grâce Dukan ERP se termine dans {remaining}',
      ar: 'تنتهي فترة السماح في Dukan ERP خلال {remaining}',
    },
    {
      en: `The grace period of {business} on Dukan ERP ends in {remaining}, on {graceEnds}. After that the app becomes read-only until the subscription is renewed.\n\n${RENEW.en}`,
      fr: `La période de grâce de {business} sur Dukan ERP se termine dans {remaining}, le {graceEnds}. Ensuite, l’application passera en lecture seule jusqu’au renouvellement de l’abonnement.\n\n${RENEW.fr}`,
      ar: `تنتهي فترة السماح لـ{business} في Dukan ERP خلال {remaining}، في {graceEnds}، ثم يصبح التطبيق للقراءة فقط إلى أن يُجدَّد الاشتراك.\n\n${RENEW.ar}`,
    },
  ),
  'subscription.grace_ended': subscriptionEmail(
    ['business', 'ended'],
    {
      en: 'Your Dukan ERP grace period has ended',
      fr: 'Votre période de grâce Dukan ERP est terminée',
      ar: 'انتهت فترة السماح في Dukan ERP',
    },
    {
      en: `The grace period of {business} on Dukan ERP ended on {ended}.\n\n${READ_ONLY.en}\n\n${RENEW.en}`,
      fr: `La période de grâce de {business} sur Dukan ERP s’est terminée le {ended}.\n\n${READ_ONLY.fr}\n\n${RENEW.fr}`,
      ar: `انتهت فترة السماح لـ{business} في Dukan ERP في {ended}.\n\n${READ_ONLY.ar}\n\n${RENEW.ar}`,
    },
  ),
};

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
  ...SUBSCRIPTION_EMAILS,
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
