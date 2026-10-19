import { BadRequestException } from '@nestjs/common';
import type { MessageLanguage } from './whatsapp-channel';

/**
 * WhatsApp consent: the copy a person agrees to, its version and purpose, and the rule every sender applies (the
 * owner's brief of 2026-10-19, D213; refines D181 §5; docs/98).
 *
 * One consent, for **operational** Dukan ERP messages on WhatsApp — verification and security codes, account setup,
 * trial and subscription status, expiry reminders and important service notices. Never marketing: there is no
 * marketing purpose, copy or template, and none may be added under this consent.
 *
 * The copy is served by the API so the screen that shows it and the record that stores the agreement can never
 * disagree: a client sends back the `version` it displayed, and any other version is refused. Changing a word here
 * means a new version — never an edit under the same one — and a consent given to an earlier version no longer counts.
 */

export const WHATSAPP_CONSENT_VERSION = 'wa-operational-2026-10-19';

/** The one purpose the copy names. */
export const CONSENT_PURPOSE = 'operational_whatsapp';
export const CONSENT_PURPOSES: readonly string[] = [CONSENT_PURPOSE];

/** The languages the copy is shown in — what a record's `locale` may hold. */
export const CONSENT_LOCALES = ['en', 'fr', 'ar'] as const;
export type ConsentLocale = (typeof CONSENT_LOCALES)[number];

/** Where an agreement or a withdrawal was made (`whatsapp_consents.source`). */
export type ConsentSource =
  | 'mobile_registration'
  | 'website_registration'
  | 'account_settings'
  | 'website'
  | 'number_changed'
  | 'inbound_keyword';

export interface ConsentCopy {
  version: string;
  language: MessageLanguage;
  /** A heading for the consent. */
  title: string;
  /** Why it is asked: WhatsApp is the required operational contact of an account. */
  body: string;
  /** The statement the person ticks: exactly what they agree to. */
  agreement: string;
  purposes: readonly string[];
}

const COPY: Record<MessageLanguage, Omit<ConsentCopy, 'version' | 'language' | 'purposes'>> = {
  en: {
    title: 'Operational messages on WhatsApp',
    body:
      'WhatsApp is the required contact for a Dukan ERP account: we verify your number with a code and send your ' +
      'account’s operational messages there. You can withdraw this agreement at any time in Communication preferences.',
    agreement:
      'I agree to receive operational Dukan ERP messages on WhatsApp, including verification and security codes, ' +
      'account setup information, trial and subscription status, expiry reminders and important service notices. ' +
      'Message frequency depends on account activity. This is not consent to marketing messages.',
  },
  fr: {
    title: 'Messages opérationnels sur WhatsApp',
    body:
      'WhatsApp est le contact obligatoire d’un compte Dukan ERP : nous vérifions votre numéro par un code et y ' +
      'envoyons les messages opérationnels de votre compte. Vous pouvez retirer cet accord à tout moment dans ' +
      'Préférences de communication.',
    agreement:
      'J’accepte de recevoir sur WhatsApp les messages opérationnels de Dukan ERP, notamment les codes de vérification ' +
      'et de sécurité, les informations de configuration du compte, l’état de l’essai et de l’abonnement, les rappels ' +
      'd’expiration et les avis de service importants. La fréquence des messages dépend de l’activité du compte. Il ne ' +
      's’agit pas d’un consentement aux messages marketing.',
  },
  ar: {
    title: 'الرسائل التشغيلية عبر واتساب',
    body:
      'واتساب هو جهة الاتصال المطلوبة لحساب Dukan ERP: نتحقق من رقمك برمز ونرسل إليه الرسائل التشغيلية الخاصة ' +
      'بحسابك. يمكنك سحب هذه الموافقة في أي وقت من «تفضيلات التواصل».',
    agreement:
      'أوافق على تلقي رسائل Dukan ERP التشغيلية عبر واتساب، بما في ذلك رموز التحقق والأمان، ومعلومات إعداد الحساب، ' +
      'وحالة الفترة التجريبية والاشتراك، وتذكيرات انتهاء الصلاحية، وإشعارات الخدمة المهمة. يعتمد عدد الرسائل على ' +
      'نشاط الحساب. وهذه ليست موافقة على تلقي رسائل تسويقية.',
  },
};

/** Whether a recorded version is the one in force: a consent to an earlier copy does not count. */
export function isCurrentConsentVersion(version: string | null | undefined): boolean {
  return version === WHATSAPP_CONSENT_VERSION;
}

/**
 * The consent version a client sent, checked before anything is saved: a missing version is refused (nothing may be
 * inferred from a number being typed or verified), and so is any version but the current one (the person saw other
 * words). Returns the version to record.
 */
export function acceptedConsentVersion(given: string | undefined | null): string {
  const version = given?.trim() || null;
  if (!version) {
    throw new BadRequestException({
      code: 'whatsapp_consent_required',
      message: 'Agree to receive operational Dukan ERP messages on WhatsApp to continue. Nothing was saved.',
      currentVersion: WHATSAPP_CONSENT_VERSION,
    });
  }
  if (!isCurrentConsentVersion(version)) {
    throw new BadRequestException({
      code: 'whatsapp_consent_outdated',
      message: 'The WhatsApp consent shown is not the current one. Show the current text and ask again.',
      currentVersion: WHATSAPP_CONSENT_VERSION,
    });
  }
  return version;
}

/** The locale the copy was shown in, as recorded: one of the copy's languages, else the request's language. */
export function consentLocaleOf(given: string | undefined | null, fallback: string): ConsentLocale {
  const pick = (v: string | undefined | null): ConsentLocale | null =>
    (CONSENT_LOCALES as readonly string[]).includes(v ?? '') ? (v as ConsentLocale) : null;
  return pick(given) ?? pick(fallback) ?? 'en';
}

export function consentCopy(language: MessageLanguage): ConsentCopy {
  const lang: MessageLanguage = COPY[language] ? language : 'en';
  return { version: WHATSAPP_CONSENT_VERSION, language: lang, ...COPY[lang], purposes: CONSENT_PURPOSES };
}

/**
 * The opt-out keywords, EN/FR/AR (D181 §3). A message opts out only when its WHOLE text is one of these, after
 * case, accents, Arabic letter variants and punctuation are folded away — "please don't stop" opts nobody out. The
 * text is examined here, in memory, and dropped: only the resulting signal is kept.
 *
 * STOP withdraws the operational consent, exactly as the app's withdrawal does (D213). START is recognised but grants
 * nothing: a consent is given only with the copy in front of the person, so it returns through the app.
 */
export const STOP_KEYWORDS: readonly string[] = [
  // en
  'STOP', 'UNSUBSCRIBE', 'STOP ALL',
  // fr (accents folded: ARRET covers ARRÊT, DESABONNER covers DÉSABONNER)
  'ARRET', 'ARRETER', 'DESABONNER', 'DESINSCRIRE',
  // ar (alef forms folded: الغاء covers إلغاء)
  'توقف', 'ايقاف', 'الغاء', 'الغاء الاشتراك',
];
export const START_KEYWORDS: readonly string[] = [
  // en
  'START', 'UNSTOP', 'SUBSCRIBE',
  // fr
  'REPRENDRE', 'DEMARRER',
  // ar
  'ابدا', 'استئناف', 'اشتراك',
];

/** Case, Latin accents, Arabic diacritics, tatweel and alef/hamza forms, punctuation and repeated spaces folded away. */
export function foldKeyword(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const STOP = new Set(STOP_KEYWORDS.map(foldKeyword));
const START = new Set(START_KEYWORDS.map(foldKeyword));

export function optOutSignalOf(text: unknown): 'stop' | 'start' | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 40) return null;
  const folded = foldKeyword(text);
  if (STOP.has(folded)) return 'stop';
  if (START.has(folded)) return 'start';
  return null;
}
