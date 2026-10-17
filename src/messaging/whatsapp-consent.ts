import { BadRequestException } from '@nestjs/common';
import type { MessageLanguage } from './whatsapp-channel';

/**
 * WhatsApp consent: the copy a person agrees to, its version and purposes, the opt-out keywords, and what stops
 * working when the mandatory channel is withdrawn (D181 §3, §5; docs/98).
 *
 * The copy is served by the API so the screen that shows it and the record that stores the agreement can never
 * disagree: a client sends back the `version` it displayed, and a stale version is refused. Changing a word here
 * means a new version — never an edit under the same one.
 */

export const WHATSAPP_CONSENT_VERSION = 'wa-consent-2026-10-17';

/**
 * The purposes the copy names. The first five make WhatsApp the account's mandatory verified contact; only
 * `operational_notices` can be stopped while the account keeps working.
 */
export const MANDATORY_PURPOSES = [
  'authentication',
  'account_recovery',
  'employee_invitations',
  'security_alerts',
  'account_deletion',
] as const;
export const OPTIONAL_PURPOSES = ['operational_notices'] as const;
export const CONSENT_PURPOSES: readonly string[] = [...MANDATORY_PURPOSES, ...OPTIONAL_PURPOSES];

export interface ConsentCopy {
  version: string;
  language: MessageLanguage;
  title: string;
  body: string;
  agreement: string;
  purposes: readonly string[];
}

const COPY: Record<MessageLanguage, Omit<ConsentCopy, 'version' | 'language' | 'purposes'>> = {
  en: {
    title: 'WhatsApp is your account contact',
    body:
      'Dukan ERP uses your WhatsApp number as the verified contact of your account. TSX-MR sends you WhatsApp ' +
      'messages to: sign in and verify your number; recover your account; verify the employees you invite; send ' +
      'security alerts; and confirm an account deletion. These messages are required for your account to work. ' +
      'With your agreement we also send operational notices, such as closing notices; you can stop them at any time ' +
      'by replying STOP, without affecting your account. We never send marketing messages.',
    agreement: 'I agree that TSX-MR contacts me on WhatsApp for these purposes.',
  },
  fr: {
    title: 'WhatsApp est le contact de votre compte',
    body:
      'Dukan ERP utilise votre numéro WhatsApp comme contact vérifié de votre compte. TSX-MR vous envoie des ' +
      'messages WhatsApp pour : vous connecter et vérifier votre numéro ; récupérer votre compte ; vérifier les ' +
      'employés que vous invitez ; vous envoyer des alertes de sécurité ; et confirmer une suppression de compte. Ces ' +
      'messages sont nécessaires au fonctionnement de votre compte. Avec votre accord, nous envoyons aussi des avis ' +
      'opérationnels, comme les avis de clôture ; vous pouvez les arrêter à tout moment en répondant STOP, sans ' +
      'conséquence pour votre compte. Nous n’envoyons jamais de messages publicitaires.',
    agreement: 'J’accepte que TSX-MR me contacte sur WhatsApp à ces fins.',
  },
  ar: {
    title: 'واتساب هو جهة الاتصال لحسابك',
    body:
      'يستخدم Dukan ERP رقم واتساب الخاص بك كجهة اتصال موثّقة لحسابك. ترسل لك TSX-MR رسائل واتساب من أجل: ' +
      'تسجيل الدخول والتحقق من رقمك؛ واستعادة حسابك؛ والتحقق من الموظفين الذين تدعوهم؛ وإرسال تنبيهات الأمان؛ ' +
      'وتأكيد حذف الحساب. هذه الرسائل ضرورية لعمل حسابك. وبموافقتك نرسل أيضًا إشعارات تشغيلية، مثل إشعارات ' +
      'الإغلاق، ويمكنك إيقافها في أي وقت بالرد بكلمة STOP أو «توقف» دون أن يتأثر حسابك. لا نرسل أبدًا رسائل تسويقية.',
    agreement: 'أوافق على أن تتواصل معي TSX-MR عبر واتساب لهذه الأغراض.',
  },
};

/**
 * Whether a number given for WhatsApp must come with a consent (D181 §5): whenever the Cloud API would really send to
 * it in live mode. In test mode only the operator's allowlisted numbers are reached, and with no real channel
 * nothing is; a consent sent anyway is still checked and recorded.
 */
export function consentRequired(whatsappChannel: string, mode: string): boolean {
  const channel = whatsappChannel.trim().toLowerCase();
  return (channel === 'cloud' || channel === 'cloud-api') && mode === 'live';
}

/**
 * The consent version a client sent, checked before anything is saved: a stale version is refused (the person saw
 * other words), and a missing one is refused when consent is required. Returns the version to record, or null.
 */
export function acceptedConsentVersion(given: string | undefined | null, required: boolean): string | null {
  const version = given?.trim() || null;
  if (version && version !== WHATSAPP_CONSENT_VERSION) {
    throw new BadRequestException({
      code: 'whatsapp_consent_outdated',
      message: 'The WhatsApp consent shown is not the current one. Show the current text and ask again.',
      currentVersion: WHATSAPP_CONSENT_VERSION,
    });
  }
  if (!version && required) {
    throw new BadRequestException({
      code: 'whatsapp_consent_required',
      message: 'A WhatsApp number needs the person’s agreement to the WhatsApp consent. Nothing was saved.',
      currentVersion: WHATSAPP_CONSENT_VERSION,
    });
  }
  return version;
}

export function consentCopy(language: MessageLanguage): ConsentCopy {
  const lang: MessageLanguage = COPY[language] ? language : 'en';
  return { version: WHATSAPP_CONSENT_VERSION, language: lang, ...COPY[lang], purposes: CONSENT_PURPOSES };
}

/**
 * What a person can no longer do once they withdraw WhatsApp as their account contact. Said plainly instead of
 * pretending these keep working without a verified channel (D181 §5).
 */
export const UNAVAILABLE_WITHOUT_WHATSAPP = [
  'sign_in_verification',
  'account_recovery',
  'employee_invitation_verification',
  'security_verification',
  'account_deletion',
] as const;

const WITHDRAWN_EXPLANATION: Record<MessageLanguage, string> = {
  en:
    'You withdrew WhatsApp as your account contact. Until you agree again, these are unavailable: sign-in steps that ' +
    'need a code, account recovery, verifying the employees you invite, security verification, and deleting your ' +
    'account (its code goes by WhatsApp only). Your business data is not affected.',
  fr:
    'Vous avez retiré WhatsApp comme contact de votre compte. Tant que vous ne l’acceptez pas à nouveau, ceci est ' +
    'indisponible : les étapes de connexion qui demandent un code, la récupération du compte, la vérification des ' +
    'employés que vous invitez, la vérification de sécurité et la suppression de votre compte (son code passe ' +
    'uniquement par WhatsApp). Les données de votre commerce ne sont pas touchées.',
  ar:
    'لقد سحبت واتساب كجهة اتصال لحسابك. وإلى أن توافق من جديد، لا يتاح ما يلي: خطوات تسجيل الدخول التي تتطلب ' +
    'رمزًا، واستعادة الحساب، والتحقق من الموظفين الذين تدعوهم، والتحقق الأمني، وحذف حسابك (يُرسل رمزه عبر ' +
    'واتساب فقط). لا تتأثر بيانات متجرك.',
};

export function withdrawnExplanation(language: MessageLanguage): string {
  return WITHDRAWN_EXPLANATION[language] ?? WITHDRAWN_EXPLANATION.en;
}

/**
 * The opt-out keywords, EN/FR/AR (D181 §3). A message opts out only when its WHOLE text is one of these, after
 * case, accents, Arabic letter variants and punctuation are folded away — "please don't stop" opts nobody out. The
 * text is examined here, in memory, and dropped: only the resulting signal is kept.
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
