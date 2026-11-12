import { BadRequestException } from '@nestjs/common';
/**
 * How a shop is told to pay — and, today, that it cannot be told yet.
 *
 * **Instructions, not an integration.** Nothing here talks to Bankily, Masrivi,
 * Sedad, Bimbank or Click. No provider API is called, no provider confirms
 * anything, and reading this configuration cannot create a payment, mark one
 * reported or confirmed, or move a subscription out of `pending`. A shop pays
 * out-of-band and a person confirms it.
 *
 * **Nothing is served until a real code exists (2026-10-05).** Every provider
 * below still carries the `00000` stand-in, and a stand-in that reaches a
 * screen is money sent nowhere while the shop believes it has paid. So a
 * provider is offered only once it is enabled with its real code; until then
 * the instructions answer `available: false` with no provider and no code, and
 * the website says payment is arranged with the administrator. Payment on the
 * website — Bankily included — is the website phase's work (`docs/68`), not a
 * flag flipped here.
 *
 * **One source, server-owned.** The website receives this list from the server
 * rather than carrying its own copy, so a real code later is a configuration
 * change and not a release. The mobile app never reads it (`docs/21`,
 * 2026-10-05): prices and payment belong to the website and the platform, not
 * to the customer app.
 */

export type PaymentProviderKey = 'bankily' | 'masrivi' | 'sedad' | 'bimbank' | 'click';

export interface PaymentProvider {
  /** Stable across renames and translations. The client keys off this, never the label. */
  key: PaymentProviderKey;
  /** Brand name. Deliberately NOT translated — a brand is the same word in every language. */
  label: string;
  /** Ascending. Bankily leads because it is the one most shops already use. */
  order: number;
  /** Whether it is offered at all. Disabled while the code is a stand-in. */
  enabled: boolean;
  /** What the shopkeeper types into their payment app. */
  code: string;
  /** 0138 (owner, 2026-11-12): every number this service receives on — `code` is the first, for older pages and the app. */
  codes?: readonly string[];
  /**
   * True while `code` is a stand-in rather than a real destination.
   *
   * Kept apart from `enabled` so that offering a provider is an explicit act
   * that has to come with its real code: {@link assertPaymentInstructionsSafeForProduction}
   * refuses to let a production deployment start while any OFFERED provider
   * is still a placeholder.
   */
  placeholder: boolean;
}

/**
 * The placeholder every provider currently carries.
 *
 * Temporary configuration, not a business constant. No real code has been
 * issued to us for any of these providers, and inventing one would be worse
 * than showing an obvious stand-in: a plausible-looking wrong code is money
 * sent somewhere nobody is watching.
 */
export const PLACEHOLDER_CODE = '00000';

/** Where an Owner pays by Bankily or Sedad (owner, 2026-11-05). A merchant number for customers to see, not a secret. */
export const PAYMENT_NUMBER = '36963839';
/** 0138: the second receiving number; the owner confirmed both receive Bankily and Sedad (2026-11-12). */
export const PAYMENT_NUMBER_2 = '37676827';

/**
 * The catalogue, in the order a shop would see it. None is offered: each still
 * carries the stand-in, and a stand-in is never served.
 */
export const PAYMENT_PROVIDER_CATALOGUE: readonly PaymentProvider[] = [
  // The owner's real merchant number (2026-11-05), the same for both; shown without the country code, as the apps take it.
  { key: 'bankily', label: 'Bankily', order: 1, enabled: true, code: PAYMENT_NUMBER, codes: [PAYMENT_NUMBER, PAYMENT_NUMBER_2], placeholder: false },
  { key: 'masrivi', label: 'Masrivi', order: 2, enabled: false, code: PLACEHOLDER_CODE, placeholder: true },
  { key: 'sedad', label: 'Sedad', order: 3, enabled: true, code: PAYMENT_NUMBER, codes: [PAYMENT_NUMBER, PAYMENT_NUMBER_2], placeholder: false },
  { key: 'bimbank', label: 'Bimbank', order: 4, enabled: false, code: PLACEHOLDER_CODE, placeholder: true },
  { key: 'click', label: 'Click', order: 5, enabled: false, code: PLACEHOLDER_CODE, placeholder: true },
];

/** The default selection, once it is offered. Bankily, until somebody decides otherwise. */
export const DEFAULT_PROVIDER: PaymentProviderKey = 'bankily';

export interface PaymentInstructions {
  /** False until at least one provider is offered with a real code. */
  available: boolean;
  /** Only the providers that are offered. Never a stand-in. */
  providers: PaymentProvider[];
  /** Null while nothing is offered. */
  defaultProvider: PaymentProviderKey | null;
  /** True while ANY offered provider is a stand-in, so a client can mark itself clearly. */
  placeholder: boolean;
}

export function paymentInstructions(catalogue: readonly PaymentProvider[] = PAYMENT_PROVIDER_CATALOGUE): PaymentInstructions {
  const providers = catalogue.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
  const available = providers.length > 0;
  return {
    available,
    providers,
    defaultProvider: available ? (providers.find((p) => p.key === DEFAULT_PROVIDER) ?? providers[0]).key : null,
    placeholder: providers.some((p) => p.placeholder),
  };
}

/** Production, by either label; staging keeps its own name and is not production. */
function isProduction(env: NodeJS.ProcessEnv): boolean {
  const appEnv = (env.APP_ENV ?? '').toLowerCase();
  if (appEnv === 'production') return true;
  if (appEnv === 'staging') return false;
  return (env.NODE_ENV ?? '').toLowerCase() === 'production';
}

/**
 * Refuse to start a production deployment that would offer a stand-in code.
 *
 * The failure this prevents is quiet and expensive: a shop reads `00000`,
 * pays nothing anywhere, and waits for an activation that is never coming —
 * while believing they have paid. Better that the deployment stops. Called at
 * boot (`main.ts`); with nothing offered it passes, and it fails the moment a
 * provider is enabled without its real code.
 */
export function assertPaymentInstructionsSafeForProduction(
  env: NodeJS.ProcessEnv = process.env,
  catalogue: readonly PaymentProvider[] = PAYMENT_PROVIDER_CATALOGUE,
): void {
  if (!isProduction(env)) return;

  const stubs = catalogue.filter((p) => p.enabled && p.placeholder);
  if (stubs.length > 0) {
    throw new Error(
      'Payment instructions would offer placeholder codes for: ' +
        stubs.map((p) => p.key).join(', ') +
        '. Give each offered provider its real payment code before running in production.',
    );
  }
}

/**
 * 0138: the service and receiving number the Owner chose, if it is one the server offers — null when none was named.
 * A pairing not offered (a number that does not receive that service) is refused, never recorded.
 */
export function receiverOf(service: string | undefined, number: string | undefined, catalogue: readonly PaymentProvider[] = PAYMENT_PROVIDER_CATALOGUE): { service: PaymentProviderKey; number: string } | null {
  const svc = service?.trim().toLowerCase() ?? '';
  const num = (number ?? '').replace(/\D/g, '').replace(/^222(?=\d{8}$)/, '');
  if (!svc && !num) return null;
  const p = catalogue.find((x) => x.enabled && !x.placeholder && x.key === svc);
  const codes = p ? (p.codes ?? [p.code]) : [];
  if (!p || !codes.includes(num)) {
    throw new BadRequestException({ code: 'receiver_invalid', message: 'Choose the service and number you sent the money to.' });
  }
  return { service: p.key, number: num };
}
