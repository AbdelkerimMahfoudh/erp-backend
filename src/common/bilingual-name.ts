import { Transform } from 'class-transformer';
import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * Bilingual names for businesses, stores and people (D225, 0111).
 *
 * `name` is the Latin-alphabet name, read by the French and English interfaces. `nameAr` is the Arabic name, read
 * by the Arabic interface. A record without an Arabic name keeps working: every screen shows `name` meanwhile, and
 * the record is marked for completion. Nothing is ever transliterated by a machine.
 *
 * The rules catch the obvious mistake, never a real shop's name. "PS5 Center", "Samsung-Store 2", "Électro Kiffa"
 * and "متجر PS5" are all valid. What is refused:
 *  - Arabic letters in the Latin name: the field was filled in the wrong language;
 *  - an Arabic name with no Arabic letter: the same mistake the other way round;
 *  - control and bidirectional-override characters, in either. An override can make a name read differently on
 *    screen from how it is stored, which is how a name impersonates another.
 */

export const NAME_MAX = 160;

/** The first store's names when none is given: "Main Store" and its Arabic twin. */
export const DEFAULT_STORE_NAME = 'Main Store';
export const DEFAULT_STORE_NAME_AR = 'المتجر الرئيسي';

/** Arabic script letters: the Arabic, Arabic Supplement, Extended-A and presentation-form blocks. */
const ARABIC_LETTER = /[ؠ-يٮ-ۓەۮۯۺ-ۼۿݐ-ݿࢠ-ࣉﭐ-ﷻﹰ-ﻼ]/u;
/** A Latin letter (basic, Latin-1 and Extended-A/B: é, ç, ñ…) or a digit. */
const LATIN_LETTER_OR_DIGIT = /[A-Za-z0-9À-ÖØ-öø-ɏ]/u;
/** C0/C1 controls, and the bidirectional embeddings, overrides and isolates. */
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/u;

export type NameProblem = 'name_blank' | 'name_too_long' | 'name_forbidden_character' | 'name_latin_has_arabic' | 'name_latin_needs_letter' | 'name_ar_needs_arabic';

/** One space between words, nothing around them, composed form — "  PS5   Center " is "PS5 Center". */
export function normalizeName(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function common(value: string): NameProblem | null {
  if (!value) return 'name_blank';
  if (value.length > NAME_MAX) return 'name_too_long';
  if (FORBIDDEN.test(value)) return 'name_forbidden_character';
  return null;
}

export function latinNameProblem(raw: string): NameProblem | null {
  const value = normalizeName(raw);
  const problem = common(value);
  if (problem) return problem;
  if (ARABIC_LETTER.test(value)) return 'name_latin_has_arabic';
  if (!LATIN_LETTER_OR_DIGIT.test(value)) return 'name_latin_needs_letter';
  return null;
}

export function arabicNameProblem(raw: string): NameProblem | null {
  const value = normalizeName(raw);
  const problem = common(value);
  if (problem) return problem;
  if (!ARABIC_LETTER.test(value)) return 'name_ar_needs_arabic';
  return null;
}

/** Plain words for each refusal, in English as every validation message of this API is. */
const MESSAGES: Record<NameProblem, string> = {
  name_blank: 'A name cannot be blank',
  name_too_long: `A name is at most ${NAME_MAX} characters`,
  name_forbidden_character: 'A name cannot contain control or text-direction characters',
  name_latin_has_arabic: 'The Latin-alphabet name contains Arabic letters. Put the Arabic name in the Arabic field.',
  name_latin_needs_letter: 'The Latin-alphabet name needs at least one letter or digit',
  name_ar_needs_arabic: 'The Arabic name needs at least one Arabic letter',
};

export function nameProblemMessage(problem: NameProblem): string {
  return MESSAGES[problem];
}

/** Trims and collapses spaces before validation, so what is checked is what is stored. */
export const NormalizeName = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? normalizeName(value) : value));

export function IsLatinName(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isLatinName',
      validator: {
        validate: (value) => typeof value === 'string' && latinNameProblem(value) === null,
        defaultMessage: (args) =>
          typeof args?.value === 'string' ? nameProblemMessage(latinNameProblem(args.value) ?? 'name_blank') : 'A name must be text',
      },
    },
    options,
  );
}

/**
 * The Latin name on a route the released app (1.0.0 (1), D225) also calls. That build has one name field, and an
 * Arabic-speaking shopkeeper typed an Arabic name into it, so its requests — which carry no `pairedWith` field — are
 * held to the rule they always were: not blank, not too long, nothing forbidden. A request from a build that knows
 * both names sends the Arabic one too, and its Latin name is then held to the Latin rule.
 */
export function IsLatinNameOrLegacy(pairedWith: string, options?: ValidationOptions) {
  const problem = (value: string, object: object) =>
    (object as Record<string, unknown>)[pairedWith] === undefined ? common(normalizeName(value)) : latinNameProblem(value);
  return ValidateBy(
    {
      name: 'isLatinNameOrLegacy',
      validator: {
        validate: (value, args) => typeof value === 'string' && problem(value, args?.object ?? {}) === null,
        defaultMessage: (args) =>
          typeof args?.value === 'string'
            ? nameProblemMessage(problem(args.value, args.object ?? {}) ?? 'name_blank')
            : 'A name must be text',
      },
    },
    options,
  );
}

export function IsArabicName(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isArabicName',
      validator: {
        validate: (value) => typeof value === 'string' && arabicNameProblem(value) === null,
        defaultMessage: (args) =>
          typeof args?.value === 'string' ? nameProblemMessage(arabicNameProblem(args.value) ?? 'name_blank') : 'A name must be text',
      },
    },
    options,
  );
}

export type NameLocale = 'en' | 'fr' | 'ar';

export interface BilingualName {
  name: string;
  nameAr?: string | null;
}

/** The name an interface in `locale` shows: the Arabic one in Arabic when there is one, the Latin one otherwise. */
export function localizedName(named: BilingualName, locale: NameLocale | string | null | undefined): string {
  if (locale === 'ar' && named.nameAr) return named.nameAr;
  return named.name;
}

/** A record created before 0111, or since without its Arabic name: shown, never blocked, marked to complete. */
export function nameNeedsCompletion(named: BilingualName): boolean {
  return !named.nameAr;
}

/** Both names and whether one is missing, the shape every response that names somebody sends (D225). */
export function bilingual(named: BilingualName): { name: string; nameAr: string | null; nameIncomplete: boolean } {
  return { name: named.name, nameAr: named.nameAr ?? null, nameIncomplete: nameNeedsCompletion(named) };
}

/** Search on either name: what a `where` matches when somebody types part of one. */
export function nameSearch(term: string): { OR: ({ name: { contains: string } } | { nameAr: { contains: string } })[] } {
  const q = normalizeName(term);
  return { OR: [{ name: { contains: q } }, { nameAr: { contains: q } }] };
}
