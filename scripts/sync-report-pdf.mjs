#!/usr/bin/env node
/**
 * Copies the app's report PDF page (erp-mobile lib/report-pdf-html.ts and the pure helpers it imports) into
 * src/reports/pdf/vendor/, with the words it prints in EN/FR/AR, so the PDF WhatsApp carries is the PDF the app
 * makes. Run from erp-backend:  node scripts/sync-report-pdf.mjs ../erp-mobile
 *
 * Nothing is rewritten but import paths (".ts" dropped) and, for receipt-html, only `esc` is taken. The copies
 * are generated: change the app's files and sync again, never edit them here.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const mobile = resolve(process.argv[2] ?? '../erp-mobile');
const out = resolve('src/reports/pdf/vendor');
mkdirSync(out, { recursive: true });
const sha = execFileSync('git', ['-C', mobile, 'rev-parse', '--short', 'HEAD']).toString().trim();
const header = (from) =>
  `// GENERATED from erp-mobile ${from} at ${sha} by scripts/sync-report-pdf.mjs — do not edit; sync again.\n/* eslint-disable */\n// @ts-nocheck\n`;
const read = (f) => readFileSync(join(mobile, 'lib', f), 'utf8').replace(/\r\n/g, '\n');
const fixImports = (s) => s.replace(/(from\s+'\.\/[^']+)\.ts'/g, "$1'");

for (const f of ['report-pdf-html.ts', 'report-document.ts', 'home-day.ts', 'closing-report-view.ts', 'money-format.ts', 'day-range.ts', 'date-locale.ts']) {
  writeFileSync(join(out, f), header(`lib/${f}`) + fixImports(read(f)));
}
const esc = /export function esc\([\s\S]*?\n}\n/.exec(read('receipt-html.ts'));
if (!esc) throw new Error('esc() not found in receipt-html.ts');
writeFileSync(join(out, 'receipt-html.ts'), header('lib/receipt-html.ts (esc only)') + esc[0]);

// The words: every key the page may print, in each language.
const html = read('report-pdf-html.ts');
const list = /REPORT_PDF_KEYS = \[([\s\S]*?)\] as const/.exec(html)[1];
const keys = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const prefixes = [.../REPORT_PDF_DYNAMIC_PREFIXES = \[([^\]]*)\]/.exec(html)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const catalogue = (lang) => {
  const src = read(`i18n/${lang}.ts`);
  const map = {};
  for (const m of src.matchAll(/^\s*'([^']+)':\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"),?\s*$/gm)) {
    map[m[1]] = Function(`return ${m[2]}`)();
  }
  const pick = {};
  for (const [k, v] of Object.entries(map)) if (keys.includes(k) || prefixes.some((p) => k.startsWith(p))) pick[k] = v;
  const missing = keys.filter((k) => !(k in pick));
  if (missing.length) throw new Error(`${lang}: missing ${missing.join(', ')}`);
  return pick;
};
const words = { en: catalogue('en'), fr: catalogue('fr'), ar: catalogue('ar') };
writeFileSync(
  join(out, 'report-pdf-words.ts'),
  header('lib/i18n/{en,fr,ar}.ts (report PDF keys)') +
    `export const REPORT_PDF_WORDS: Record<'en' | 'fr' | 'ar', Record<string, string>> = ${JSON.stringify(words, null, 2)};\n`,
);
console.log(`synced ${keys.length} keys (+ ${prefixes.length} prefixes) from erp-mobile ${sha} → ${out}`);
