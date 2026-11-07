import { localParts } from '../common/business-day';

/**
 * What the Owner is told after a counted close changes (docs/50 §3.4), pure.
 *
 * Three notices — the day reopened, each sale completed while it was open
 * again, and the reclose — each with a STABLE id derived from the record that
 * caused it, so a retried delivery deduplicates instead of repeating. Nothing
 * here may carry a full IMEI, a cost, a customer's number or another tenant's
 * data; `assertNoticeSafe` refuses a variable that looks like one.
 */

export type NoticeLanguage = 'en' | 'ar' | 'fr';

export interface NoticeContext {
  branchName: string;
  timezone: string;
  businessDate: string;
  language: NoticeLanguage;
  includeAmounts: boolean;
  currency: string;
}

export interface Notice {
  /** `closing.reopened` | `closing.sale` | `closing.reclosed` */
  template: 'closing.reopened' | 'closing.sale' | 'closing.reclosed' | 'closing.summary' | 'closing.monthly';
  /** The in-app notification's `dedupeKey` and the WhatsApp `idempotencyKey`. */
  dedupeKey: string;
  variables: Record<string, string>;
  title: string;
  body: string;
  /** Localisable fields for the app; carries no cost and no identifier. */
  payload: Record<string, unknown>;
}

const IMEI_LIKE = /\d{15}/;

export function formatLocalTime(instant: Date, timezone: string): string {
  const p = localParts(instant, timezone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function formatAmount(value: number, currency: string): string {
  const fixed = Math.round(value * 100) / 100;
  const whole = Math.trunc(Math.abs(fixed));
  const cents = Math.round((Math.abs(fixed) - whole) * 100);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = fixed < 0 ? '−' : '';
  return `${sign}${grouped}${cents ? `.${String(cents).padStart(2, '0')}` : ''} ${currency}`;
}

const WORDS: Record<NoticeLanguage, Record<string, string>> = {
  en: {
    reopened: 'Day reopened',
    continued: '{date} continues',
    startedEarly: '{next} started early',
    sale: 'Sale after the close',
    reclosed: 'Day closed again',
    collected: 'collected',
    owed: 'still owed',
    hidden: 'amounts hidden by your settings',
    notVerified: 'cash not counted',
    since: 'since the first count',
    whole: 'whole day',
    at: 'at',
    daily: 'Day closed',
    monthly: 'Month closed',
    sales: '{n} sales',
    salesValue: '{n} sales · {value}',
    collectedOwed: 'collected {collected} · still owed {owed}',
    cashDiff: 'cash difference {diff}',
    days: '{n} days closed',
  },
  fr: {
    reopened: 'Journée rouverte',
    continued: '{date} continue',
    startedEarly: '{next} commencé en avance',
    sale: 'Vente après la clôture',
    reclosed: 'Journée reclôturée',
    collected: 'encaissé',
    owed: 'reste dû',
    hidden: 'montants masqués par vos réglages',
    notVerified: 'caisse non comptée',
    since: 'depuis le premier comptage',
    whole: 'journée entière',
    at: 'à',
    daily: 'Journée clôturée',
    monthly: 'Mois clôturé',
    sales: '{n} ventes',
    salesValue: '{n} ventes · {value}',
    collectedOwed: 'encaissé {collected} · reste dû {owed}',
    cashDiff: 'écart de caisse {diff}',
    days: '{n} jours clôturés',
  },
  ar: {
    reopened: 'أُعيد فتح اليوم',
    continued: 'يستمر يوم {date}',
    startedEarly: 'بدأ يوم {next} مبكرًا',
    sale: 'بيع بعد الإقفال',
    reclosed: 'أُقفل اليوم مجددًا',
    collected: 'محصّل',
    owed: 'متبقٍ',
    hidden: 'المبالغ مخفية حسب إعداداتك',
    notVerified: 'لم يُعدّ النقد',
    since: 'منذ العدّ الأول',
    whole: 'اليوم كاملًا',
    at: 'في',
    daily: 'أُقفل اليوم',
    monthly: 'أُقفل الشهر',
    sales: '{n} عملية بيع',
    salesValue: '{n} عملية بيع · {value}',
    collectedOwed: 'المحصّل {collected} · المتبقي {owed}',
    cashDiff: 'فرق النقد {diff}',
    days: '{n} يوم مُقفل',
  },
};

function word(lang: NoticeLanguage, key: string, vars: Record<string, string> = {}): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), WORDS[lang][key] ?? WORDS.en[key] ?? key);
}

/** Refuse anything that looks like a full IMEI or a cost. Defence in depth. */
export function assertNoticeSafe(variables: Record<string, string>): void {
  for (const [key, value] of Object.entries(variables)) {
    if (IMEI_LIKE.test(value.replace(/[\s-]/g, ''))) throw new Error(`Notice variable "${key}" carries a full identifier`);
    if (/\bcost\b|\bcoût\b|تكلفة/i.test(value)) throw new Error(`Notice variable "${key}" mentions a cost`);
  }
}

export interface ReopenedEvent {
  closingIdHex: string;
  reopenCount: number;
  at: Date;
  mode: 'continue' | 'start_new';
  automatic: boolean;
  nextDate?: string;
}

export function reopenedNotice(ctx: NoticeContext, ev: ReopenedEvent): Notice {
  const time = formatLocalTime(ev.at, ctx.timezone);
  const what =
    ev.mode === 'start_new'
      ? word(ctx.language, 'startedEarly', { next: ev.nextDate ?? '' })
      : word(ctx.language, 'continued', { date: ctx.businessDate });
  const variables = { branch: ctx.branchName, time, date: ctx.businessDate, what };
  assertNoticeSafe(variables);
  return {
    template: 'closing.reopened',
    dedupeKey: `closing:${ev.closingIdHex}:reopened:${ev.reopenCount}`,
    variables,
    title: `${word(ctx.language, 'reopened')} · ${ctx.branchName}`,
    body: `${time} · ${what}`,
    payload: { event: 'reopened', branch: ctx.branchName, time, businessDate: ctx.businessDate, mode: ev.mode, automatic: ev.automatic },
  };
}

export interface SaleEvent {
  saleIdHex: string;
  soldAt: Date;
  total: number;
  amountPaid: number;
  balanceDue: number;
  /** Brand and model only — never an identifier. */
  itemLabel: string;
  itemCount: number;
}

export function saleNotice(ctx: NoticeContext, sale: SaleEvent): Notice {
  const time = formatLocalTime(sale.soldAt, ctx.timezone);
  const item = sale.itemCount > 1 ? `${sale.itemLabel} +${sale.itemCount - 1}` : sale.itemLabel;
  const money = ctx.includeAmounts
    ? sale.balanceDue > 0
      ? `${formatAmount(sale.total, ctx.currency)} · ${formatAmount(sale.amountPaid, ctx.currency)} ${word(ctx.language, 'collected')} · ${formatAmount(sale.balanceDue, ctx.currency)} ${word(ctx.language, 'owed')}`
      : formatAmount(sale.total, ctx.currency)
    : word(ctx.language, 'hidden');
  const variables = { branch: ctx.branchName, time, date: ctx.businessDate, item, money };
  assertNoticeSafe(variables);
  return {
    template: 'closing.sale',
    dedupeKey: `closing-sale:${sale.saleIdHex}`,
    variables,
    title: `${word(ctx.language, 'sale')} · ${ctx.branchName}`,
    body: `${time} · ${item} · ${money}`,
    payload: {
      event: 'sale',
      branch: ctx.branchName,
      time,
      businessDate: ctx.businessDate,
      item,
      ...(ctx.includeAmounts ? { total: sale.total, collected: sale.amountPaid, owed: sale.balanceDue } : {}),
    },
  };
}

export interface ReclosedEvent {
  closingIdHex: string;
  reopenCount: number;
  at: Date;
  sinceFirstCount: { salesValue: number; cashIn: number; salesCount: number };
  /** `countedCash`/`difference` are null when the drawer was not counted at this close (0078). */
  wholeDay: { salesValue: number; expectedCash: number; countedCash: number | null; difference: number | null };
}

export function reclosedNotice(ctx: NoticeContext, ev: ReclosedEvent): Notice {
  const time = formatLocalTime(ev.at, ctx.timezone);
  const since = ctx.includeAmounts
    ? `${word(ctx.language, 'since')}: ${ev.sinceFirstCount.salesCount} · ${formatAmount(ev.sinceFirstCount.salesValue, ctx.currency)}`
    : `${word(ctx.language, 'since')}: ${ev.sinceFirstCount.salesCount}`;
  const whole = ctx.includeAmounts
    ? `${word(ctx.language, 'whole')}: ${formatAmount(ev.wholeDay.salesValue, ctx.currency)} · ${ev.wholeDay.difference === null ? word(ctx.language, 'notVerified') : formatAmount(ev.wholeDay.difference, ctx.currency)}`
    : word(ctx.language, 'hidden');
  const variables = { branch: ctx.branchName, time, date: ctx.businessDate, since, whole };
  assertNoticeSafe(variables);
  return {
    template: 'closing.reclosed',
    dedupeKey: `closing:${ev.closingIdHex}:reclosed:${ev.reopenCount}`,
    variables,
    title: `${word(ctx.language, 'reclosed')} · ${ctx.branchName}`,
    body: `${time} · ${since} · ${whole}`,
    payload: {
      event: 'reclosed',
      branch: ctx.branchName,
      time,
      businessDate: ctx.businessDate,
      sinceFirstCount: ctx.includeAmounts ? ev.sinceFirstCount : { salesCount: ev.sinceFirstCount.salesCount },
      ...(ctx.includeAmounts ? { wholeDay: ev.wholeDay } : {}),
    },
  };
}

export interface DaySummaryEvent {
  closingIdHex: string;
  salesCount: number;
  salesValue: number;
  collected: number;
  owed: number;
  /** Null when the drawer was not counted at this close (0078). */
  difference: number | null;
}

/** The day's summary (owner, 2026-11-07): sent once, at the day's first close — a reclose has its own notice. */
export function daySummaryNotice(ctx: NoticeContext, ev: DaySummaryEvent): Notice {
  const lang = ctx.language;
  const sales = ctx.includeAmounts
    ? word(lang, 'salesValue', { n: String(ev.salesCount), value: formatAmount(ev.salesValue, ctx.currency) })
    : word(lang, 'sales', { n: String(ev.salesCount) });
  const money = ctx.includeAmounts
    ? `${word(lang, 'collectedOwed', { collected: formatAmount(ev.collected, ctx.currency), owed: formatAmount(ev.owed, ctx.currency) })} · ${
        ev.difference === null ? word(lang, 'notVerified') : word(lang, 'cashDiff', { diff: formatAmount(ev.difference, ctx.currency) })
      }`
    : word(lang, 'hidden');
  const variables = { branch: ctx.branchName, date: ctx.businessDate, sales, money };
  assertNoticeSafe(variables);
  return {
    template: 'closing.summary',
    dedupeKey: `closing:${ev.closingIdHex}:summary`,
    variables,
    title: `${word(lang, 'daily')} · ${ctx.branchName}`,
    body: `${ctx.businessDate} · ${sales} · ${money}`,
    payload: {
      event: 'summary',
      branch: ctx.branchName,
      businessDate: ctx.businessDate,
      salesCount: ev.salesCount,
      ...(ctx.includeAmounts ? { salesValue: ev.salesValue, collected: ev.collected, owed: ev.owed, difference: ev.difference } : {}),
    },
  };
}

export interface MonthSummaryEvent {
  /** `YYYY-MM`. */
  month: string;
  branchIdHex: string;
  salesCount: number;
  salesValue: number;
  daysClosed: number;
}

/** The month's summary: sent at the close of the month's last day, once per store and month. */
export function monthSummaryNotice(ctx: NoticeContext, ev: MonthSummaryEvent): Notice {
  const lang = ctx.language;
  const sales = ctx.includeAmounts
    ? word(lang, 'salesValue', { n: String(ev.salesCount), value: formatAmount(ev.salesValue, ctx.currency) })
    : word(lang, 'sales', { n: String(ev.salesCount) });
  const days = word(lang, 'days', { n: String(ev.daysClosed) });
  const variables = { branch: ctx.branchName, month: ev.month, sales, days };
  assertNoticeSafe(variables);
  return {
    template: 'closing.monthly',
    dedupeKey: `closing:${ev.branchIdHex}:monthly:${ev.month}`,
    variables,
    title: `${word(lang, 'monthly')} · ${ctx.branchName}`,
    body: `${ev.month} · ${sales} · ${days}`,
    payload: {
      event: 'monthly',
      branch: ctx.branchName,
      month: ev.month,
      salesCount: ev.salesCount,
      daysClosed: ev.daysClosed,
      ...(ctx.includeAmounts ? { salesValue: ev.salesValue } : {}),
    },
  };
}
