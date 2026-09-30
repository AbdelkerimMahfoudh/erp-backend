import { BadRequestException } from '@nestjs/common';

/**
 * The template registry (F1 Stage 4A; provider-backed since 2026-09-30).
 *
 * WhatsApp business messaging is template-based: you register text with the
 * provider, get it approved, and then send *that* by name with variables. This
 * registry mirrors it so the application can only ever send something a human
 * approved.
 *
 * It is also the validation boundary. A template declares exactly which
 * variables it needs; anything missing, extra or empty is rejected before an
 * adapter is called — so a caller cannot quietly ship an empty code or smuggle
 * a field into a message.
 *
 * **The provider's own template names live in configuration**, one variable
 * per template (`configKey`), never in source: a name is an approval the
 * operator obtained at the provider, and it differs per deployment. A template
 * whose variable is empty cannot be sent — the adapter refuses rather than
 * guesses, because an unapproved template is rejected by every provider anyway
 * and guessing would turn a configuration mistake into a silent non-delivery.
 */

export type MessageCategory = 'authentication' | 'account' | 'business_summary' | 'operational';

/**
 * Languages a message may be requested in.
 *
 * What may be *asked for*, not what may be *sent*: a template still has to
 * declare the language itself, which is the point of `assertLanguageSupported`
 * below — and every declared language must be approved at the provider before
 * the channel is enabled (docs/64).
 */
export type MessageLanguage = 'en' | 'ar' | 'fr';

/**
 * How the provider expects the template to be filled.
 *
 *  - `authentication` — Meta's AUTHENTICATION category: a fixed body with ONE
 *    parameter (the code) and a copy-code button carrying the same code. The
 *    expiry wording is part of the approved text, so `ttlMinutes` is validated
 *    here and not sent as a parameter.
 *  - `utility` — body parameters in the registry's declared order.
 */
export type ProviderKind = 'authentication' | 'utility';

export interface TemplateDefinition {
  /** Stable internal key. Never sent to a provider — see `configKey`. */
  readonly key: string;
  readonly category: MessageCategory;
  /** Variables the template requires, in the order a provider expects them. */
  readonly variables: readonly string[];
  readonly languages: readonly MessageLanguage[];
  readonly providerKind: ProviderKind;
  /** The environment variable holding the provider's approved template name. */
  readonly configKey: string;
}

/**
 * Authentication one-time code.
 *
 * `code` is the only variable a provider receives, and it is passed through the
 * delivery call — never persisted with the message, never logged. `ttlMinutes`
 * is validated so the caller states how long the code lasts; the approved
 * authentication template carries that wording itself.
 */
export const AUTH_OTP_TEMPLATE: TemplateDefinition = {
  key: 'auth.otp',
  category: 'authentication',
  variables: ['code', 'ttlMinutes'],
  languages: ['en', 'ar', 'fr'],
  providerKind: 'authentication',
  configKey: 'WHATSAPP_TEMPLATE_AUTH_OTP',
};

/**
 * The account-deletion code (docs/64).
 *
 * A UTILITY template, not an authentication one, on purpose: the approved text
 * must say what the code is for and that confirming is irreversible, and the
 * provider's authentication category allows neither. The approved copy, in all
 * three languages, is recorded in docs/64 §4.
 */
export const ACCOUNT_DELETION_TEMPLATE: TemplateDefinition = {
  key: 'account.deletion',
  category: 'account',
  variables: ['code', 'ttlMinutes'],
  languages: ['en', 'ar', 'fr'],
  providerKind: 'utility',
  configKey: 'WHATSAPP_TEMPLATE_ACCOUNT_DELETION',
};

/**
 * Told once the deletion is complete (docs/64). `what` is the localised phrase
 * for what was deleted — a login, or a business and every login in it.
 */
export const ACCOUNT_DELETED_TEMPLATE: TemplateDefinition = {
  key: 'account.deleted',
  category: 'account',
  variables: ['what'],
  languages: ['en', 'ar', 'fr'],
  providerKind: 'utility',
  configKey: 'WHATSAPP_TEMPLATE_ACCOUNT_DELETED',
};

/**
 * The Owner's closing notices (docs/50 §3.4). Operational, not authentication:
 * a day reopened after a counted close, each sale completed while it was
 * open again, and the reclose. The variables are composed by
 * `closing/closing-notices.ts`, which refuses a full identifier or a cost.
 */
export const CLOSING_REOPENED_TEMPLATE: TemplateDefinition = {
  key: 'closing.reopened',
  category: 'operational',
  variables: ['branch', 'time', 'date', 'what'],
  languages: ['en', 'ar', 'fr'],
  providerKind: 'utility',
  configKey: 'WHATSAPP_TEMPLATE_CLOSING_REOPENED',
};

export const CLOSING_SALE_TEMPLATE: TemplateDefinition = {
  key: 'closing.sale',
  category: 'operational',
  variables: ['branch', 'time', 'date', 'item', 'money'],
  languages: ['en', 'ar', 'fr'],
  providerKind: 'utility',
  configKey: 'WHATSAPP_TEMPLATE_CLOSING_SALE',
};

export const CLOSING_RECLOSED_TEMPLATE: TemplateDefinition = {
  key: 'closing.reclosed',
  category: 'operational',
  variables: ['branch', 'time', 'date', 'since', 'whole'],
  languages: ['en', 'ar', 'fr'],
  providerKind: 'utility',
  configKey: 'WHATSAPP_TEMPLATE_CLOSING_RECLOSED',
};

const REGISTRY: Record<string, TemplateDefinition> = {
  [AUTH_OTP_TEMPLATE.key]: AUTH_OTP_TEMPLATE,
  [ACCOUNT_DELETION_TEMPLATE.key]: ACCOUNT_DELETION_TEMPLATE,
  [ACCOUNT_DELETED_TEMPLATE.key]: ACCOUNT_DELETED_TEMPLATE,
  [CLOSING_REOPENED_TEMPLATE.key]: CLOSING_REOPENED_TEMPLATE,
  [CLOSING_SALE_TEMPLATE.key]: CLOSING_SALE_TEMPLATE,
  [CLOSING_RECLOSED_TEMPLATE.key]: CLOSING_RECLOSED_TEMPLATE,
};

export type TemplateKey = keyof typeof REGISTRY & string;

/** Every registered template, for configuration and documentation. */
export const ALL_TEMPLATES: readonly TemplateDefinition[] = Object.freeze(Object.values(REGISTRY));

export function getTemplate(key: string): TemplateDefinition {
  const found = REGISTRY[key];
  if (!found) {
    // Unknown key is a programming error, not user input — but it is still a
    // 400 rather than a 500 because it can only arrive from a caller.
    throw new BadRequestException(`Unknown message template "${key}"`);
  }
  return found;
}

/**
 * Validate variables against a template.
 *
 * Strict in both directions: a missing variable would send a broken message,
 * and an unexpected one means the caller believes something about this template
 * that is not true. Empty and whitespace-only values are rejected because a
 * blank code reads as a delivered message and is anything but.
 */
export function validateTemplateVariables(
  template: TemplateDefinition,
  variables: Record<string, string>,
): Record<string, string> {
  const provided = Object.keys(variables);

  for (const required of template.variables) {
    const value = variables[required];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(
        `Template "${template.key}" requires a non-empty "${required}"`,
      );
    }
  }

  const unexpected = provided.filter((k) => !template.variables.includes(k));
  if (unexpected.length > 0) {
    throw new BadRequestException(
      `Template "${template.key}" does not accept: ${unexpected.join(', ')}`,
    );
  }

  return variables;
}

export function assertLanguageSupported(
  template: TemplateDefinition,
  language: MessageLanguage,
): void {
  if (!template.languages.includes(language)) {
    throw new BadRequestException(`Template "${template.key}" has no ${language} version`);
  }
}

/**
 * Planned categories — **documented, not activated.**
 *
 * | Future template | Category | Blocked on |
 * |---|---|---|
 * | Daily Owner summary | `business_summary` | Approved copy. Content must never enter OTP tables |
 * | Monthly Owner summary | `business_summary` | Same |
 * | Inter-store consignment notice | `operational` | Approved copy |
 * | Loan / debt reminder | `operational` | Approved copy |
 *
 * Business summaries are already gated by Owner preference
 * (`CompanySettings.whatsappDailyEnabled` / `whatsappMonthlyEnabled` /
 * `whatsappIncludeAmounts`). Authentication and account messages are **not**
 * subject to those preferences: an Owner turning off nightly summaries must not
 * accidentally disable everyone's ability to sign in or to delete an account.
 */
export const PLANNED_TEMPLATES = Object.freeze([
  'summary.daily',
  'summary.monthly',
  'consignment.notice',
  'debt.reminder',
] as const);
