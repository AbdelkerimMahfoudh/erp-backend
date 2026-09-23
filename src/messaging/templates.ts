import { BadRequestException } from '@nestjs/common';

/**
 * The template registry (F1 Stage 4A).
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
 * **Only the authentication OTP template is active.** The future categories at
 * the bottom are recorded so nobody re-derives them, and deliberately not
 * implemented: activating one means approving copy with a provider, and this
 * stage has no provider.
 */

export type MessageCategory = 'authentication' | 'business_summary' | 'operational';

/**
 * Languages a message may be requested in.
 *
 * Widened to include French with the French app catalogue (milestone M). Note
 * that this says what may be *asked for*, not what may be *sent* — a template
 * still has to declare the language itself, which is the point of
 * `assertLanguageSupported` below.
 */
export type MessageLanguage = 'en' | 'ar' | 'fr';

export interface TemplateDefinition {
  /** Stable internal key. Never sent to a provider — see `providerTemplateName`. */
  readonly key: string;
  readonly category: MessageCategory;
  /** Variables the template requires, in the order a provider expects them. */
  readonly variables: readonly string[];
  readonly languages: readonly MessageLanguage[];
  /**
   * The provider's own template name, from configuration.
   *
   * Null until a provider exists and the template is approved there. Sending
   * with a null name must fail loudly rather than guess — an unapproved
   * template is rejected by every provider anyway, and guessing would turn a
   * configuration mistake into a silent non-delivery.
   */
  readonly providerTemplateName: string | null;
}

/**
 * Authentication one-time code.
 *
 * `code` is the only variable, and it is passed through the delivery call —
 * never persisted with the message, never logged. `ttlMinutes` lets the message
 * say how long the code lasts, which measurably cuts "it stopped working"
 * support questions.
 */
export const AUTH_OTP_TEMPLATE: TemplateDefinition = {
  key: 'auth.otp',
  category: 'authentication',
  variables: ['code', 'ttlMinutes'],
  // Deliberately NOT 'fr', even though the app now speaks French. This registry
  // mirrors what a provider has approved, and no French one-time-code template
  // has been approved anywhere — claiming it here would let the app try to send
  // a message that does not exist. `assertLanguageSupported` refuses it until
  // there is a real approval to mirror.
  languages: ['en', 'ar'],
  // Set from configuration once a provider is chosen (Stage 4B).
  providerTemplateName: null,
};

/**
 * The Owner's closing notices (docs/50 §3.4). Operational, not authentication:
 * a day reopened after a counted close, each sale completed while it was
 * open again, and the reclose. The variables are composed by
 * `closing/closing-notices.ts`, which refuses a full identifier or a cost.
 *
 * Registered in all three app languages because the shop chooses its Owner's
 * language in Settings; like the OTP template, `providerTemplateName` stays
 * null until a provider has approved the copy, and a send through the
 * `disabled` channel reports `channel_unavailable` rather than pretending.
 */
export const CLOSING_REOPENED_TEMPLATE: TemplateDefinition = {
  key: 'closing.reopened',
  category: 'operational',
  variables: ['branch', 'time', 'date', 'what'],
  languages: ['en', 'ar', 'fr'],
  providerTemplateName: null,
};

export const CLOSING_SALE_TEMPLATE: TemplateDefinition = {
  key: 'closing.sale',
  category: 'operational',
  variables: ['branch', 'time', 'date', 'item', 'money'],
  languages: ['en', 'ar', 'fr'],
  providerTemplateName: null,
};

export const CLOSING_RECLOSED_TEMPLATE: TemplateDefinition = {
  key: 'closing.reclosed',
  category: 'operational',
  variables: ['branch', 'time', 'date', 'since', 'whole'],
  languages: ['en', 'ar', 'fr'],
  providerTemplateName: null,
};

const REGISTRY: Record<string, TemplateDefinition> = {
  [AUTH_OTP_TEMPLATE.key]: AUTH_OTP_TEMPLATE,
  [CLOSING_REOPENED_TEMPLATE.key]: CLOSING_REOPENED_TEMPLATE,
  [CLOSING_SALE_TEMPLATE.key]: CLOSING_SALE_TEMPLATE,
  [CLOSING_RECLOSED_TEMPLATE.key]: CLOSING_RECLOSED_TEMPLATE,
};

export type TemplateKey = keyof typeof REGISTRY & string;

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
 * | Daily Owner summary | `business_summary` | Provider choice + approved copy. Content must never enter OTP tables |
 * | Monthly Owner summary | `business_summary` | Same |
 * | Inter-store consignment notice | `operational` | The Consignment module does not exist |
 * | Loan / debt reminder | `operational` | The Money & reconciliation module does not exist |
 *
 * Business summaries are already gated by Owner preference
 * (`CompanySettings.whatsappDailyEnabled` / `whatsappMonthlyEnabled` /
 * `whatsappIncludeAmounts`). Authentication messages are **not** subject to
 * those preferences: an Owner turning off nightly summaries must not
 * accidentally disable everyone's ability to sign in.
 */
export const PLANNED_TEMPLATES = Object.freeze([
  'summary.daily',
  'summary.monthly',
  'consignment.notice',
  'debt.reminder',
] as const);
