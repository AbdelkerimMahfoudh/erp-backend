/**
 * The written return policy: what may be stored, and what a receipt prints (D223 device QA, 2026-10-28).
 *
 * Pure, so the service, the sale and the tests apply one rule.
 */

export const POLICY_LANGUAGES = ['en', 'fr', 'ar'] as const;
export type PolicyLanguage = (typeof POLICY_LANGUAGES)[number];

/** Each language's conditions, at most this many characters once normalised. */
export const POLICY_TEXT_MAX = 1000;

export type PolicyTextProblem = 'too_long' | 'html';

/**
 * A shop's own words, normalised exactly and the same way every time.
 *
 * - line endings become `\n`; every other control character goes;
 * - runs of spaces and tabs inside a line become one space, and each line is trimmed;
 * - at most one empty line between paragraphs, none at the start or end;
 * - an empty result is `null` — "not written", never an empty string.
 *
 * Line breaks are kept: the receipt prints them as breaks. Nothing is
 * translated: a language the shop did not write stays unwritten.
 */
export function normalisePolicyText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Why a normalised text cannot be stored, or null.
 *
 * Markup is refused rather than stripped: a receipt prints exactly what the shop
 * wrote, and silently removing part of it would print something else. The
 * receipt escapes every character anyway — this keeps tags out of the record.
 */
export function policyTextProblem(text: string | null): PolicyTextProblem | null {
  if (text === null) return null;
  if (text.length > POLICY_TEXT_MAX) return 'too_long';
  if (/<\s*\/?\s*[a-z!?]/i.test(text) || /&[a-z#0-9]+;/i.test(text)) return 'html';
  return null;
}

export interface PolicyTexts {
  en: string | null;
  fr: string | null;
  ar: string | null;
  defaultLanguage: PolicyLanguage;
}

/**
 * The conditions a receipt in `language` prints: its own language's text,
 * else the shop's default language's, else none — and then the receipt says
 * the neutral sentence derived from the window. Never a translation.
 */
export function policyTextFor(texts: PolicyTexts, language: string): string | null {
  const own = (POLICY_LANGUAGES as readonly string[]).includes(language) ? texts[language as PolicyLanguage] : null;
  return own ?? texts[texts.defaultLanguage] ?? null;
}

export function isPolicyLanguage(value: unknown): value is PolicyLanguage {
  return typeof value === 'string' && (POLICY_LANGUAGES as readonly string[]).includes(value);
}
