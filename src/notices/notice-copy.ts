import type { MessageLanguage } from '../messaging/whatsapp-channel';

/**
 * The values a subscription message carries (0099; docs/101 §7): the exact instant in the business's own zone, with the
 * zone's full name, and the time left in words — written by the server in the message's language, never by a client.
 *
 * Arabic keeps Latin digits (`ar-u-nu-latn`), as the app does, so a date reads the same in a WhatsApp message, an email
 * and the screen. Times are 24-hour. Nothing here carries an identifier, a token or a contact.
 */

const LOCALE: Record<MessageLanguage, string> = { en: 'en-GB', fr: 'fr-FR', ar: 'ar-u-nu-latn' };

/** `21 October 2026, 14:00 (Greenwich Mean Time)` — the instant in `timeZone`, in the message's language. */
export function formatNoticeInstant(instant: Date, timeZone: string, language: MessageLanguage): string {
  const locale = LOCALE[language];
  const date = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'long', year: 'numeric' }).format(instant);
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
  const zone =
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'long' }).formatToParts(instant).find((p) => p.type === 'timeZoneName')?.value ??
    timeZone;
  const comma = language === 'ar' ? '،' : ',';
  return `${date}${comma} ${time} (${zone})`;
}

/** The reminder thresholds, and how long each leaves, in words. */
export type ReminderThreshold = 'h72' | 'h48' | 'h24';

const DAYS: Record<ReminderThreshold, Record<MessageLanguage, string>> = {
  h72: { en: '3 days', fr: '3 jours', ar: '3 أيام' },
  h48: { en: '2 days', fr: '2 jours', ar: 'يومين' },
  h24: { en: '1 day', fr: '1 jour', ar: 'يوم واحد' },
};

const HOURS: Record<Exclude<ReminderThreshold, 'h72'>, Record<MessageLanguage, string>> = {
  h48: { en: '48 hours', fr: '48 heures', ar: '48 ساعة' },
  h24: { en: '24 hours', fr: '24 heures', ar: '24 ساعة' },
};

/** A trial's or a paid period's time left at its threshold: 3 days, 2 days, 1 day. */
export function daysLeftText(threshold: ReminderThreshold, language: MessageLanguage): string {
  return DAYS[threshold][language];
}

/** A grace period's time left at its threshold: 48 hours, 24 hours. */
export function graceHoursLeftText(threshold: 'h48' | 'h24', language: MessageLanguage): string {
  return HOURS[threshold][language];
}
