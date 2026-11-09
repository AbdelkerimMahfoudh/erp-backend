import { format as formatDateFns } from 'date-fns';
import { dateLocaleFor } from './vendor/date-locale';
import { calendarDate, dayRangeShape } from './vendor/day-range';
import { formatMoney, formatNumber } from './vendor/money-format';
import { REPORT_PDF_WORDS } from './vendor/report-pdf-words';
import type { ReportPdfContext, ReportPdfLanguage } from './vendor/report-pdf-html';

/**
 * The page's context on the server: the app's own words and formatters (lib/format.ts), with one difference —
 * a phone writes an instant on its own clock, the server on the business's configured zone.
 */
export function serverReportContext(lang: ReportPdfLanguage, timeZone: string): ReportPdfContext {
  const locale = dateLocaleFor(lang);
  const words = REPORT_PDF_WORDS[lang];
  const day = (d: string, pattern: string) => formatDateFns(calendarDate(d), pattern, { locale });
  return {
    lang,
    rtl: lang === 'ar',
    text: (key) => words[key] ?? REPORT_PDF_WORDS.en[key] ?? key,
    formatMoney: (v) => formatMoney(v),
    formatNumber: (v) => formatNumber(v),
    formatDate: (d) => day(d, 'd MMM yyyy'),
    formatDateTime: (instant) => formatDateFns(inZone(new Date(instant), timeZone), 'd MMM yyyy · HH:mm', { locale }),
    formatMonth: (month) => {
      const text = day(`${month}-01`, 'MMMM yyyy');
      return text.charAt(0).toUpperCase() + text.slice(1);
    },
    formatDayRange: (from, to) => {
      switch (dayRangeShape(from, to)) {
        case 'day':
          return day(from, 'd MMM yyyy');
        case 'month':
          return `${day(from, 'd')}–${day(to, 'd MMM yyyy')}`;
        case 'year':
          return `${day(from, 'd MMM')} – ${day(to, 'd MMM yyyy')}`;
        default:
          return `${day(from, 'd MMM yyyy')} – ${day(to, 'd MMM yyyy')}`;
      }
    },
  };
}

/** The wall-clock reading of `instant` in `timeZone`, as a local Date for date-fns to print. */
export function inZone(instant: Date, timeZone: string): Date {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(instant)
        .map((p) => [p.type, p.value]),
    );
  } catch {
    return inZone(instant, 'UTC');
  }
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}
