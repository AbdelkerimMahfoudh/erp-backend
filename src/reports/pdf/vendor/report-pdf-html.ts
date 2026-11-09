// GENERATED from erp-mobile lib/report-pdf-html.ts at 5dcfb74 by scripts/sync-report-pdf.mjs — do not edit; sync again.
/* eslint-disable */
// @ts-nocheck
import { esc } from './receipt-html';
import { standingKey, standingTone } from './home-day';
import { verificationKey, verificationTone, warningKey, type Tone } from './closing-report-view';
import type {
  ChannelKind,
  DailyReportDocument,
  DocumentWarning,
  MonthlyReportDocument,
  ReportDocument,
} from './report-document';

/**
 * The daily and monthly reports as a printable page — the HTML that becomes the PDF.
 *
 * Pure, like the invoice builder beside it: the words, the writing direction and the
 * formatters are handed in, so the same builder runs under bare `node` for the tests and
 * inside the app for the PDF. It prints the server's document (`report-document.ts`) and
 * adds nothing up: every figure on the page is a field the server sent.
 *
 * ## What may reach the page
 *
 * Names of the shop and the branch, the closer's display name, channel labels, expense
 * categories and the server's figures — every one escaped, because each is somebody's
 * typing. No id of any kind exists in a document to print. A section the person may not
 * see is absent from the document; the page says it is not included rather than drawing
 * zeros, and it never prints a cost or a profit the server withheld.
 *
 * ## The page
 *
 * A4, white, one restrained accent (the app's indigo) for headings and nothing
 * decorative. Figures sit in one right-hand column (left-hand in Arabic), in tabular
 * digits, isolated left-to-right so "45 500 MRU" never reads backwards in an Arabic
 * line. A heading never ends a page without its figures: every section is kept whole,
 * and the day-by-day table — the only long one — repeats its header if it ever breaks.
 */

export type ReportPdfLanguage = 'en' | 'fr' | 'ar';

/** Every catalogue key the page prints. The test checks all three catalogues carry each one. */
export const REPORT_PDF_KEYS = [
  'reportPdf.daily.title',
  'maintenance.totalProfit',
  'maintenance.netWith',
  'maintenance.income',
  'maintenance.customerPaid',
  'maintenance.repairCost',
  'maintenance.profit',
  'maintenance.separate',
  'reportPdf.monthly.title',
  'reportPdf.generated',
  'reportPdf.window',
  'reportPdf.basis.liveToday',
  'reportPdf.basis.livePast',
  'reportPdf.basis.acknowledged',
  'reportPdf.monthly.whole',
  'reportPdf.monthly.toDate',
  'reportPdf.hidden.result',
  'reportPdf.expenses.variable',
  'reportPdf.expenses.salaries',
  'reportPdf.expenses.reversed',
  'reportPdf.expenses.category',
  'reportPdf.expenses.count',
  'reportPdf.money.channel',
  'reportPdf.money.out',
  'reportPdf.money.notBalance',
  'reportPdf.checks.title',
  'reportPdf.checks.expected',
  'reportPdf.checks.counted',
  'reportPdf.checks.difference',
  'reportPdf.checks.status',
  'reportPdf.checks.note',
  'reportPdf.refunds.title',
  'reportPdf.refunds.confirmedDay',
  'reportPdf.refunds.confirmedMonth',
  'reportPdf.refunds.awaiting',
  'reportPdf.refunds.outstanding',
  'reportPdf.refunds.hidden',
  'reportPdf.owed.title',
  'reportPdf.owed.sales',
  'reportPdf.owed.loansToUs',
  'reportPdf.owed.loansByUs',
  'reportPdf.owed.consignment',
  'reportPdf.owed.wholeBusiness',
  'reportPdf.now',
  'reportPdf.monthly.fixed',
  'reportPdf.monthly.salaries',
  'reportPdf.monthly.beforeFixed',
  'reportPdf.monthly.net',
  'reportPdf.commissions.title',
  'reportPdf.commissions.none',
  'reportPdf.days.title',
  'reportPdf.days.day',
  'reportPdf.days.sales',
  'reportPdf.days.items',
  'reportPdf.days.net',
  'reportPdf.days.month',
  'reportPdf.days.none',
  'reportPdf.warnings.title',
  'reportPdf.warning.month_in_progress',
  'reportPdf.warning.figures_disagree',
  'reportPdf.severity.info',
  'reportPdf.severity.warning',
  'reportPdf.severity.error',
  'reportPdf.footer',
  'dailyReport.headline',
  'dailyReport.counts',
  'dailyReport.sales.title',
  'dailyReport.salesDetails.invoiced',
  'dailyReport.sales.cancelled',
  'dailyReport.sales.returns',
  'dailyReport.sales.net',
  'dailyReport.sales.collected',
  'dailyReport.sales.owed',
  'dailyReport.result.title',
  'dailyReport.result.cost',
  'dailyReport.result.gross',
  'dailyReport.result.beforeFixed',
  'dailyReport.result.after',
  'dailyReport.result.scope',
  'dailyReport.result.cannot',
  'dailyReport.result.cannot.reason',
  'dailyReport.expenses.title',
  'dailyReport.expenses.total',
  'dailyReport.expenses.fixed',
  'dailyReport.expenses.none',
  'dailyReport.movements',
  'dailyReport.movements.total',
  'dailyReport.movements.debtSettled',
  'dailyReport.money.in',
  'dailyReport.money.net',
  'dailyReport.snapshot',
  'dailyReport.snapshot.noName',
  'dailyReport.snapshot.reason',
  'closing.channel.cash',
  'closing.channel.unattributed',
  'closingHistory.inactive.note',
  'results.hidden.title',
] as const;

/** The keys the page reaches through a code — standings, verifications and warnings. */
export const REPORT_PDF_DYNAMIC_PREFIXES = ['closing.standing.', 'dailyReport.verify.', 'dailyReport.warning.'] as const;

export type ReportPdfKey = (typeof REPORT_PDF_KEYS)[number];

export interface ReportPdfContext {
  lang: ReportPdfLanguage;
  rtl: boolean;
  /** The catalogue template of a key, `{placeholders}` intact — the page fills and escapes them. */
  text: (key: string) => string;
  formatMoney: (value: number) => string;
  formatNumber: (value: number) => string;
  /** A business date (`YYYY-MM-DD`) as the app writes it. */
  formatDate: (date: string) => string;
  /** An instant as the app writes it. */
  formatDateTime: (instant: string) => string;
  /** `YYYY-MM` as a month and year. */
  formatMonth: (month: string) => string;
  formatDayRange: (from: string, to: string) => string;
}

/**
 * Print-safe ink: the app's indigo (`colors.ts` brand 600 and 50) for the accent, dark
 * text, a quieter grey, hairlines, and the status pairs the app shows beside a word.
 */
const INK = {
  text: '#151B26',
  muted: '#5F6877',
  rule: '#E2E5EB',
  accent: '#5146D9',
  accentWash: '#EEECFC',
  negative: '#B42318',
  tone: {
    neutral: { fg: '#434C5A', bg: '#F1F3F6' },
    info: { fg: '#4238B8', bg: '#EEECFC' },
    success: { fg: '#1F7A5A', bg: '#E6F4EC' },
    warning: { fg: '#8A5A00', bg: '#FFF4D6' },
    danger: { fg: '#9B1C1C', bg: '#FCE8E8' },
  },
} as const;

const MINUS = '−';

/** The page builder's own vocabulary, closed over one context. */
function writer(ctx: ReportPdfContext) {
  const word = (key: string) => esc(ctx.text(key));
  /** A template with its `{placeholders}` filled by already-escaped HTML; the template itself escaped. */
  const fill = (key: string, params: Record<string, string>) =>
    ctx
      .text(key)
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        return m && m[1] in params ? params[m[1]] : esc(part);
      })
      .join('');
  const figure = (s: string, cls = '') => `<span class="figure${cls ? ` ${cls}` : ''}">${esc(s)}</span>`;
  const count = (n: number) => figure(ctx.formatNumber(n));
  /** An amount. Below zero it carries a true minus sign and the negative ink — never colour alone. */
  const money = (v: number) => (v < 0 ? figure(`${MINUS}${ctx.formatMoney(-v)}`, 'neg') : figure(ctx.formatMoney(v)));
  /** A line that takes something off: shown with a minus, and a reversal of one with a plus. */
  const less = (v: number) => (v > 0 ? figure(`${MINUS}${ctx.formatMoney(v)}`) : v < 0 ? figure(`+${ctx.formatMoney(-v)}`) : figure(ctx.formatMoney(0)));
  /** A result or a net: the same as an amount, named for what the row means. */
  const result = money;
  const row = (label: string, value: string, cls = '') =>
    `<tr${cls ? ` class="${cls}"` : ''}><th scope="row">${label}</th><td class="num">${value}</td></tr>`;
  const chip = (tone: Tone, label: string) => `<span class="chip tone-${tone}">${label}</span>`;
  const section = (title: string, body: string, cls = '') => `<section class="block${cls ? ` ${cls}` : ''}"><h2>${title}</h2>${body}</section>`;
  const note = (html: string) => `<p class="note">${html}</p>`;
  const lines = (rows: string[]) => `<table class="lines"><tbody>${rows.join('')}</tbody></table>`;
  const tile = (label: string, value: string, caption = '') =>
    `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${caption ? `<div class="tile-caption">${caption}</div>` : ''}</div>`;
  const channel = (kind: ChannelKind, label: string) =>
    kind === 'cash' ? word('closing.channel.cash') : kind === 'unattributed' ? word('closing.channel.unattributed') : esc(label);
  /** A day's warning, in the Daily closing's own sentence. */
  const warningText = (w: DocumentWarning) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(w.params ?? {})) {
      if (k === 'date' || k === 'anchorDate' || k === 'to') params[k] = esc(ctx.formatDate(String(v)));
      else if (k === 'amount' && typeof v === 'number') params[k] = money(v);
      else if (typeof v === 'number') params[k] = count(v);
      else params[k] = esc(String(v));
    }
    return fill(warningKey(w.code, w.params), params);
  };
  const warnings = (list: DocumentWarning[], monthly: boolean) => {
    if (list.length === 0) return '';
    const items = list
      .map((w) => {
        const tone: Tone = w.severity === 'error' ? 'danger' : w.severity === 'warning' ? 'warning' : 'info';
        const text = monthly ? fillMonthly(w) : warningText(w);
        return `<li>${chip(tone, word(`reportPdf.severity.${w.severity}`))}<span>${text}</span></li>`;
      })
      .join('');
    return section(word('reportPdf.warnings.title'), `<ul class="warnings">${items}</ul>`);
  };
  /** The monthly document raises two warnings of its own; anything else reads as the day's sentence. */
  const fillMonthly = (w: DocumentWarning) => {
    if (w.code === 'month_in_progress' || w.code === 'figures_disagree') {
      const params: Record<string, string> = {};
      if (w.params?.to !== undefined) params.to = esc(ctx.formatDate(String(w.params.to)));
      if (w.params?.count !== undefined) params.count = count(Number(w.params.count));
      return fill(`reportPdf.warning.${w.code}`, params);
    }
    return warningText(w);
  };
  return { word, fill, figure, count, money, less, result, row, chip, section, note, lines, tile, channel, warnings };
}

/**
 * The shop's name as the title, and the branch under it — once, when the two are the same name. An Arabic report
 * prints the Arabic names when they are given (D225); the file name stays in the Latin alphabet.
 */
function identity(doc: ReportDocument, ctx: ReportPdfContext): string {
  const arabic = ctx.lang === 'ar';
  const company = (arabic && doc.identity.companyAr) || doc.identity.company;
  const branch = (arabic && doc.identity.branchAr) || doc.identity.branch;
  const title = company || branch;
  return `<h1>${esc(title)}</h1>${branch && branch !== title ? `<div class="branch">${esc(branch)}</div>` : ''}`;
}

function page(ctx: ReportPdfContext, title: string, body: string): string {
  const dir = ctx.rtl ? 'rtl' : 'ltr';
  return `<!DOCTYPE html>
<html lang="${esc(ctx.lang)}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  /* A4: 210 × 297 mm. These margins leave a 178 mm column — wide, never a strip. */
  @page { size: A4; margin: 14mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  body {
    font-family: -apple-system, "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, "Noto Sans", "Noto Naskh Arabic", "Geeza Pro", Arial, sans-serif;
    font-size: 11pt; line-height: 1.42; color: ${INK.text};
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .figure { white-space: nowrap; direction: ltr; unicode-bidi: isolate; font-variant-numeric: tabular-nums; }
  .neg { color: ${INK.negative}; }

  header.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm;
                padding-bottom: 5mm; border-bottom: 1.2pt solid ${INK.text}; }
  .who { min-width: 0; }
  .eyebrow { color: ${INK.accent}; font-size: 9.5pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  h1 { font-size: 19pt; line-height: 1.2; margin: 1.5mm 0 0; overflow-wrap: anywhere; }
  .branch { color: ${INK.muted}; margin-top: .8mm; overflow-wrap: anywhere; }
  .when { text-align: end; flex: none; max-width: 46%; }
  .period { font-size: 15pt; font-weight: 700; }
  .meta { color: ${INK.muted}; font-size: 9pt; margin-top: 1.5mm; }
  .basis { margin: 3mm 0 0; color: ${INK.muted}; font-size: 9.5pt; }

  .chip { display: inline-block; padding: .6mm 2.4mm; border-radius: 1.6mm; font-size: 9pt; font-weight: 700;
          white-space: nowrap; margin-top: 1.5mm; }
  .tone-neutral { color: ${INK.tone.neutral.fg}; background: ${INK.tone.neutral.bg}; }
  .tone-info { color: ${INK.tone.info.fg}; background: ${INK.tone.info.bg}; }
  .tone-success { color: ${INK.tone.success.fg}; background: ${INK.tone.success.bg}; }
  .tone-warning { color: ${INK.tone.warning.fg}; background: ${INK.tone.warning.bg}; }
  .tone-danger { color: ${INK.tone.danger.fg}; background: ${INK.tone.danger.bg}; }

  .tiles { display: flex; gap: 4mm; margin: 6mm 0 1mm; break-inside: avoid; page-break-inside: avoid; }
  .tile { flex: 1; min-width: 0; padding: 3.2mm 3.6mm; border: .6pt solid ${INK.rule}; border-radius: 2.4mm; }
  .tile:first-child { background: ${INK.accentWash}; border-color: ${INK.accentWash}; }
  .tile-label { color: ${INK.muted}; font-size: 9pt; }
  .tile-value { font-size: 14.5pt; font-weight: 700; margin-top: .6mm; }
  .tile-caption { color: ${INK.muted}; font-size: 8.8pt; margin-top: .4mm; }

  section.block { margin-top: 5.5mm; break-inside: avoid; page-break-inside: avoid; }
  h2 { font-size: 11.5pt; margin: 0 0 2mm; padding-inline-start: 2.6mm; border-inline-start: 2.4pt solid ${INK.accent};
       break-after: avoid; page-break-after: avoid; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th, td { padding: 1.4mm 0; border-bottom: .5pt solid ${INK.rule}; vertical-align: top; }
  th { text-align: start; font-weight: 400; }
  td.num, th.num { text-align: end; padding-inline-start: 4mm; white-space: nowrap; }
  thead th { color: ${INK.muted}; font-size: 8.8pt; font-weight: 600; border-bottom: .8pt solid ${INK.rule}; }
  tr.total th, tr.total td { font-weight: 700; border-top: 1pt solid ${INK.text}; border-bottom: none; }
  tr.sub th, tr.sub td { font-weight: 700; }
  tr.quiet th, tr.quiet td { color: ${INK.muted}; font-size: 9.6pt; }
  .label-cell { overflow-wrap: anywhere; }
  .note { color: ${INK.muted}; font-size: 9pt; margin: 2mm 0 0; }
  .notice { margin: 0; padding: 2.6mm 3.4mm; border-radius: 2mm; background: ${INK.tone.neutral.bg}; }
  ul.warnings { list-style: none; margin: 0; padding: 0; }
  ul.warnings li { display: flex; gap: 2.6mm; align-items: baseline; padding: 1.4mm 0; border-bottom: .5pt solid ${INK.rule}; }
  ul.warnings li .chip { margin-top: 0; flex: none; }

  /* Never a page of its own: it follows the last section onto whichever page that ends on. */
  footer { margin-top: 6mm; padding-top: 2.4mm; border-top: .5pt solid ${INK.rule}; color: ${INK.muted}; font-size: 8.6pt;
           break-inside: avoid; page-break-inside: avoid; break-before: avoid; page-break-before: avoid; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Daily ────────────────────────────────────────────────────────────────────

export function buildDailyReportHtml(doc: DailyReportDocument, ctx: ReportPdfContext, title: string): string {
  const w = writer(ctx);
  const s = doc.sales;
  const r = doc.result;
  const generated = w.fill('reportPdf.generated', { time: esc(ctx.formatDateTime(doc.generatedAt)) });

  // ── Where, when and in what state ──
  const basis =
    doc.basis.source === 'snapshot' && doc.basis.closedAt
      ? doc.basis.closedBy
        ? w.fill('dailyReport.snapshot', { time: esc(ctx.formatDateTime(doc.basis.closedAt)), name: esc(doc.basis.closedBy) })
        : w.fill('dailyReport.snapshot.noName', { time: esc(ctx.formatDateTime(doc.basis.closedAt)) })
      : doc.standing === 'inactive'
        ? w.word('closingHistory.inactive.note')
        : w.word(doc.isToday ? 'reportPdf.basis.liveToday' : 'reportPdf.basis.livePast');
  const basisExtra = [
    doc.basis.acknowledgedUnverified ? w.word('reportPdf.basis.acknowledged') : '',
    doc.basis.reason ? w.fill('dailyReport.snapshot.reason', { reason: esc(doc.basis.reason) }) : '',
  ].filter(Boolean);
  const head = `
<header class="head">
  <div class="who">
    <div class="eyebrow">${w.word('reportPdf.daily.title')}</div>
    ${identity(doc, ctx)}
  </div>
  <div class="when">
    <div class="period">${esc(ctx.formatDate(doc.date))}</div>
    ${w.chip(standingTone(doc.standing), w.word(standingKey(doc.standing)))}
    <div class="meta">${generated}</div>
  </div>
</header>
<p class="basis">${[basis, ...basisExtra].join(' · ')}</p>
<p class="basis">${w.fill('reportPdf.window', { start: esc(ctx.formatDateTime(doc.window.startsAt)), end: esc(ctx.formatDateTime(doc.window.endsAt)) })}</p>`;

  // ── The three figures that matter most ──
  const third =
    r.status === 'ok'
      ? w.tile(w.word('dailyReport.result.after'), w.result(r.resultAfterExpenses))
      : r.status === 'cannot_calculate'
        ? w.tile(w.word('dailyReport.result.after'), w.word('dailyReport.result.cannot'))
        : w.tile(w.word('dailyReport.movements.total'), w.result(doc.money.totals.net));
  const tiles = s
    ? `<div class="tiles">
  ${w.tile(w.word('dailyReport.headline'), w.money(s.invoices.value), w.fill('dailyReport.counts', { count: w.count(s.net.count), items: w.count(s.net.items) }))}
  ${w.tile(w.word('dailyReport.sales.net'), w.money(s.net.value))}
  ${third}
</div>`
    : '';

  // ── Sales ──
  const sales = s
    ? w.section(
        w.word('dailyReport.sales.title'),
        w.lines([
          w.row(w.word('dailyReport.salesDetails.invoiced'), w.money(s.invoices.value)),
          s.cancellations.count > 0
            ? w.row(w.fill('dailyReport.sales.cancelled', { count: w.count(s.cancellations.count), items: w.count(s.cancellations.items) }), w.less(s.cancellations.value))
            : '',
          s.returns.count > 0 ? w.row(w.fill('dailyReport.sales.returns', { count: w.count(s.returns.count) }), w.less(s.returns.value)) : '',
          w.row(w.word('dailyReport.sales.net'), w.money(s.net.value), 'total'),
          w.row(w.word('dailyReport.sales.collected'), w.money(s.collected), 'quiet'),
          w.row(w.word('dailyReport.sales.owed'), w.money(s.owed), 'quiet'),
        ]),
      )
    : '';

  // ── Result ──
  const result =
    r.status === 'ok'
      ? w.section(
          w.word('dailyReport.result.title'),
          w.lines([
            w.row(w.word('dailyReport.sales.net'), w.money(r.netSales)),
            w.row(w.word('dailyReport.result.cost'), w.less(r.costOfUnitsSold)),
            w.row(w.word('dailyReport.result.gross'), w.result(r.grossProfit), 'sub'),
            w.row(w.word('reportPdf.expenses.variable'), w.less(r.variableExpenses)),
            ...(r.fixedExpenses !== 0
              ? [
                  w.row(w.word('dailyReport.result.beforeFixed'), w.result(r.resultBeforeFixed), 'sub'),
                  w.row(w.word('dailyReport.expenses.fixed'), w.less(r.fixedExpenses)),
                ]
              : []),
            ...(r.maintenanceNet ? [w.row(w.word('maintenance.totalProfit'), w.result(r.maintenanceNet))] : []),
            w.row(w.word('dailyReport.result.after'), w.result(r.resultAfterExpenses), 'total'),
          ]) + w.note(w.word('dailyReport.result.scope')),
        )
      : r.status === 'cannot_calculate'
        ? w.section(
            w.word('dailyReport.result.title'),
            `<p class="notice">${w.word('dailyReport.result.cannot')} — ${w.fill('dailyReport.result.cannot.reason', { count: w.count(r.missingCostLines) })}</p>`,
          )
        : w.section(w.word('dailyReport.result.title'), `<p class="notice">${w.word('reportPdf.hidden.result')}</p>`);

  // ── Expenses ──
  const e = doc.expenses;
  const expenses = e
    ? w.section(
        w.word('dailyReport.expenses.title'),
        e.count === 0 && e.reversed === 0
          ? `<p class="notice">${w.word('dailyReport.expenses.none')}</p>`
          : w.lines([
              w.row(w.word('reportPdf.expenses.variable'), w.money(e.variable)),
              w.row(w.word('dailyReport.expenses.fixed'), w.money(e.fixed)),
              e.salaries !== 0 ? w.row(w.word('reportPdf.expenses.salaries'), w.money(e.salaries), 'quiet') : '',
              e.reversed !== 0 ? w.row(w.word('reportPdf.expenses.reversed'), w.less(e.reversed)) : '',
              w.row(w.word('dailyReport.expenses.total'), w.money(e.total), 'total'),
            ]) +
            (e.byCategory.length > 0
              ? `<table class="grid"><thead><tr><th>${w.word('reportPdf.expenses.category')}</th><th class="num">${w.word('reportPdf.expenses.count')}</th><th class="num">${w.word('dailyReport.expenses.total')}</th></tr></thead><tbody>${e.byCategory
                  .map((c) => `<tr><th scope="row" class="label-cell">${esc(c.category)}</th><td class="num">${w.count(c.count)}</td><td class="num">${w.money(c.amount)}</td></tr>`)
                  .join('')}</tbody></table>`
              : ''),
      )
    : '';

  // ── Money recorded through each channel ──
  const money = w.section(
    w.word('dailyReport.movements'),
    `<table class="grid"><thead><tr><th>${w.word('reportPdf.money.channel')}</th><th class="num">${w.word('dailyReport.money.in')}</th><th class="num">${w.word('reportPdf.money.out')}</th><th class="num">${w.word('dailyReport.money.net')}</th></tr></thead><tbody>${doc.money.channels
      .map((c) => `<tr><th scope="row" class="label-cell">${w.channel(c.kind, c.label)}</th><td class="num">${w.money(c.in)}</td><td class="num">${w.less(c.out)}</td><td class="num">${w.result(c.net)}</td></tr>`)
      .join('')}<tr class="total"><th scope="row">${w.word('dailyReport.movements.total')}</th><td class="num">${w.money(doc.money.totals.in)}</td><td class="num">${w.less(doc.money.totals.out)}</td><td class="num">${w.result(doc.money.totals.net)}</td></tr></tbody></table>` +
      (doc.money.totals.olderDebts !== 0 ? w.lines([w.row(w.word('dailyReport.movements.debtSettled'), w.money(doc.money.totals.olderDebts), 'quiet')]) : '') +
      w.note(w.word('reportPdf.money.notBalance')),
  );

  // ── Checks: each channel's expected figure against its count ──
  const checks = w.section(
    w.word('reportPdf.checks.title'),
    `<table class="grid"><thead><tr><th>${w.word('reportPdf.money.channel')}</th><th class="num">${w.word('reportPdf.checks.expected')}</th><th class="num">${w.word('reportPdf.checks.counted')}</th><th class="num">${w.word('reportPdf.checks.difference')}</th><th class="num">${w.word('reportPdf.checks.status')}</th></tr></thead><tbody>${doc.checks
      .map((c) => {
        const kind = c.kind === 'cash' ? 'cash' : 'account';
        return `<tr><th scope="row" class="label-cell">${w.channel(c.kind, c.label)}</th><td class="num">${w.result(c.expected)}</td><td class="num">${c.counted === null ? '—' : w.money(c.counted)}</td><td class="num">${c.difference === null ? '—' : w.result(c.difference)}</td><td class="num">${w.chip(verificationTone(c.verification, c.difference), w.word(verificationKey(c.verification, kind)))}</td></tr>`;
      })
      .join('')}</tbody></table>` + w.note(w.word('reportPdf.checks.note')),
  );

  // ── Refunds and what is owed ──
  const refunds = doc.refunds
    ? w.section(
        w.word('reportPdf.refunds.title'),
        w.lines([
          w.row(w.fill('reportPdf.refunds.confirmedDay', { count: w.count(doc.refunds.confirmed.count) }), w.money(doc.refunds.confirmed.amount)),
          w.row(w.fill('reportPdf.refunds.awaiting', { count: w.count(doc.refunds.awaitingConfirmation.count) }), w.money(doc.refunds.awaitingConfirmation.amount), 'quiet'),
          w.row(w.fill('reportPdf.refunds.outstanding', { count: w.count(doc.refunds.outstanding.count) }), w.money(doc.refunds.outstanding.amount), 'sub'),
        ]) + w.note(w.fill('reportPdf.now', { time: esc(ctx.formatDateTime(doc.generatedAt)) })),
      )
    : w.section(w.word('reportPdf.refunds.title'), `<p class="notice">${w.word('reportPdf.refunds.hidden')}</p>`);
  const owed = w.section(
    w.word('reportPdf.owed.title'),
    w.lines([w.row(w.fill('reportPdf.owed.sales', { count: w.count(doc.receivables.sales) }), w.money(doc.receivables.amount), 'sub')]) +
      w.note(w.fill('reportPdf.now', { time: esc(ctx.formatDateTime(doc.generatedAt)) })),
  );

  const footer = `<footer>${w.word('reportPdf.footer')} · ${generated}</footer>`;
  return page(ctx, title, [head, tiles, sales, result, expenses, money, checks, refunds, owed, w.warnings(doc.warnings, false), footer].join('\n'));
}

// ── Monthly ──────────────────────────────────────────────────────────────────

export function buildMonthlyReportHtml(doc: MonthlyReportDocument, ctx: ReportPdfContext, title: string): string {
  const w = writer(ctx);
  const s = doc.sales;
  const r = doc.result;
  const generated = w.fill('reportPdf.generated', { time: esc(ctx.formatDateTime(doc.generatedAt)) });
  const range = esc(ctx.formatDayRange(doc.from, doc.to));

  const head = `
<header class="head">
  <div class="who">
    <div class="eyebrow">${w.word('reportPdf.monthly.title')}</div>
    ${identity(doc, ctx)}
  </div>
  <div class="when">
    <div class="period">${esc(ctx.formatMonth(doc.month))}</div>
    ${w.chip(doc.complete ? 'success' : 'info', w.fill(doc.complete ? 'reportPdf.monthly.whole' : 'reportPdf.monthly.toDate', { range }))}
    <div class="meta">${generated}</div>
  </div>
</header>`;

  const counts = w.fill('dailyReport.counts', { count: w.count(s.net.count), items: w.count(s.net.items) });
  const tiles =
    r.status === 'ok'
      ? `<div class="tiles">
  ${w.tile(w.word('dailyReport.sales.net'), w.money(s.net.value), counts)}
  ${w.tile(w.word('dailyReport.result.gross'), w.result(r.grossProfit))}
  ${w.tile(w.word('reportPdf.monthly.net'), w.result(r.netOperatingProfit))}
</div>`
      : `<div class="tiles">
  ${w.tile(w.word('dailyReport.sales.net'), w.money(s.net.value), counts)}
  ${w.tile(w.word('dailyReport.salesDetails.invoiced'), w.money(s.invoices.value))}
  ${w.tile(w.word('dailyReport.expenses.title'), w.money(doc.expenses.total))}
</div>`;

  const sales = w.section(
    w.word('dailyReport.sales.title'),
    w.lines([
      w.row(w.word('dailyReport.salesDetails.invoiced'), w.money(s.invoices.value)),
      s.cancellations.count > 0
        ? w.row(w.fill('dailyReport.sales.cancelled', { count: w.count(s.cancellations.count), items: w.count(s.cancellations.items) }), w.less(s.cancellations.value))
        : '',
      s.returns.count > 0 ? w.row(w.fill('dailyReport.sales.returns', { count: w.count(s.returns.count) }), w.less(s.returns.value)) : '',
      w.row(w.word('dailyReport.sales.net'), w.money(s.net.value), 'total'),
    ]),
  );

  const result =
    r.status === 'ok'
      ? w.section(
          w.word('dailyReport.result.title'),
          w.lines([
            w.row(w.word('dailyReport.sales.net'), w.money(r.netSales)),
            w.row(w.word('dailyReport.result.cost'), w.less(r.costOfUnitsSold)),
            w.row(w.word('dailyReport.result.gross'), w.result(r.grossProfit), 'sub'),
            w.row(w.word('reportPdf.expenses.variable'), w.less(r.variableExpenses)),
            w.row(w.word('reportPdf.monthly.beforeFixed'), w.result(r.resultBeforeFixed), 'sub'),
            w.row(w.word('reportPdf.monthly.fixed'), w.less(r.fixedExpenses)),
            w.row(w.word('reportPdf.monthly.salaries'), w.less(r.salaries)),
            w.row(w.word('reportPdf.monthly.net'), w.result(r.netOperatingProfit), 'total'),
            ...(doc.maintenance?.profit ? [w.row(w.word('maintenance.totalProfit'), w.result(doc.maintenance.profit)), w.row(w.word('maintenance.netWith'), w.result(r.netOperatingProfit + doc.maintenance.profit), 'total')] : []),
          ]),
        )
      : w.section(w.word('dailyReport.result.title'), `<p class="notice">${w.word('reportPdf.hidden.result')}</p>`);

  const e = doc.expenses;
  const expenses = w.section(
    w.word('dailyReport.expenses.title'),
    w.lines([
      w.row(w.word('reportPdf.expenses.variable'), w.money(e.variable)),
      w.row(w.word('reportPdf.monthly.fixed'), w.money(e.fixedOther)),
      w.row(w.word('reportPdf.monthly.salaries'), w.money(e.salaries)),
      w.row(w.word('dailyReport.expenses.total'), w.money(e.total), 'total'),
    ]),
  );

  const now = w.note(w.fill('reportPdf.now', { time: esc(ctx.formatDateTime(doc.generatedAt)) }));
  // Money from repairs (D227), apart from sales. What it cost, and so its profit, only reach a reader with cost.view: the server sends neither otherwise.
  const repairs = doc.maintenance?.revenue
    ? w.section(
        w.word('maintenance.income'),
        w.lines([
          w.row(w.word('maintenance.customerPaid'), w.money(doc.maintenance.revenue)),
          ...(doc.maintenance.cost !== undefined ? [w.row(w.word('maintenance.repairCost'), w.less(doc.maintenance.cost))] : []),
          ...(doc.maintenance.profit !== undefined ? [w.row(w.word('maintenance.profit'), w.result(doc.maintenance.profit), 'total')] : []),
        ]) + w.note(w.word('maintenance.separate')),
      )
    : '';
  const refunds = doc.refunds
    ? w.section(
        w.word('reportPdf.refunds.title'),
        w.lines([
          w.row(w.fill('reportPdf.refunds.confirmedMonth', { count: w.count(doc.refunds.confirmed.count) }), w.money(doc.refunds.confirmed.amount)),
          w.row(w.fill('reportPdf.refunds.awaiting', { count: w.count(doc.refunds.awaitingConfirmation.count) }), w.money(doc.refunds.awaitingConfirmation.amount), 'quiet'),
          w.row(w.fill('reportPdf.refunds.outstanding', { count: w.count(doc.refunds.outstanding.count) }), w.money(doc.refunds.outstanding.amount), 'sub'),
        ]) + now,
      )
    : w.section(w.word('reportPdf.refunds.title'), `<p class="notice">${w.word('reportPdf.refunds.hidden')}</p>`);

  const o = doc.receivables;
  const owed = w.section(
    w.word('reportPdf.owed.title'),
    w.lines([
      w.row(w.fill('reportPdf.owed.sales', { count: w.count(o.sales.sales) }), w.money(o.sales.amount), 'sub'),
      w.row(w.word('reportPdf.owed.loansToUs'), w.money(o.loansReceivable)),
      w.row(w.word('reportPdf.owed.consignment'), w.money(o.consignmentReceivable)),
      w.row(w.word('reportPdf.owed.loansByUs'), w.money(o.loansPayable), 'quiet'),
    ]) +
      now +
      w.note(w.word('reportPdf.owed.wholeBusiness')),
  );

  const commissions = w.section(w.word('reportPdf.commissions.title'), `<p class="notice">${w.word('reportPdf.commissions.none')}</p>`);

  const days = w.section(
    w.word('reportPdf.days.title'),
    doc.days.length === 0
      ? `<p class="notice">${w.word('reportPdf.days.none')}</p>`
      : `<table class="grid"><thead><tr><th>${w.word('reportPdf.days.day')}</th><th class="num">${w.word('reportPdf.days.sales')}</th><th class="num">${w.word('reportPdf.days.items')}</th><th class="num">${w.word('reportPdf.days.net')}</th></tr></thead><tbody>${doc.days
          .map((d) => `<tr><th scope="row">${esc(ctx.formatDate(d.date))}</th><td class="num">${w.count(d.count)}</td><td class="num">${w.count(d.items)}</td><td class="num">${w.result(d.netSales)}</td></tr>`)
          .join('')}<tr class="total"><th scope="row">${w.word('reportPdf.days.month')}</th><td class="num">${w.count(s.net.count)}</td><td class="num">${w.count(s.net.items)}</td><td class="num">${w.result(s.net.value)}</td></tr></tbody></table>`,
    'days',
  );

  const footer = `<footer>${w.word('reportPdf.footer')} · ${generated}</footer>`;
  return page(ctx, title, [head, tiles, sales, result, expenses, repairs, refunds, owed, commissions, days, w.warnings(doc.warnings, true), footer].join('\n'));
}

// ── The file ─────────────────────────────────────────────────────────────────

/**
 * A name a phone, a mailbox and a chat app can all carry: ASCII letters and digits only.
 * Accents are folded ("Élan" → "Elan"), every other character is a word break, and the
 * words run together in capitals ("Main Store" → "MainStore"). A name with no Latin letter
 * left (an Arabic name) falls back to the next one, then to "Store".
 */
export function fileSafeName(...names: (string | null | undefined)[]): string {
  for (const name of names) {
    const words = (name ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
    const joined = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 40);
    if (joined) return joined;
  }
  return 'Store';
}

/** `DukanERP_MainStore_Daily_2026-10-01_EN.pdf`, `DukanERP_MainStore_Monthly_2026-10_AR.pdf`. */
export function reportFileName(doc: ReportDocument, lang: ReportPdfLanguage): string {
  const store = fileSafeName(doc.identity.branch, doc.identity.company);
  const period = doc.kind === 'daily' ? `Daily_${doc.date}` : `Monthly_${doc.month}`;
  return `DukanERP_${store}_${period}_${lang.toUpperCase()}.pdf`;
}

/** The page for either document; its `<title>` is the file's name, which a browser offers when saving. */
export function buildReportHtml(doc: ReportDocument, ctx: ReportPdfContext): string {
  const title = reportFileName(doc, ctx.lang).replace(/\.pdf$/, '');
  return doc.kind === 'daily' ? buildDailyReportHtml(doc, ctx, title) : buildMonthlyReportHtml(doc, ctx, title);
}
