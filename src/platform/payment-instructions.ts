/**
 * How a shop is told to pay.
 *
 * **Instructions, not an integration.** Nothing here talks to Bankily, Masrivi,
 * Sedad, Bimbank or Click. No provider API is called, no provider confirms
 * anything, and reading this configuration cannot create a payment, mark one
 * reported or confirmed, or move a subscription out of `pending`. A shop pays
 * out-of-band and a person confirms it.
 *
 * **One source, server-owned.** The mobile app and the website both receive
 * this list from the server rather than carrying their own copy, so changing a
 * real code later is a configuration change and not a mobile release. That
 * matters more than it looks: an app store round-trip is days, and a wrong
 * payment code is money going to the wrong place for all of them.
 */

export type PaymentProviderKey = 'bankily' | 'masrivi' | 'sedad' | 'bimbank' | 'click';

export interface PaymentProvider {
  /** Stable across renames and translations. The client keys off this, never the label. */
  key: PaymentProviderKey;
  /** Brand name. Deliberately NOT translated — a brand is the same word in every language. */
  label: string;
  /** Ascending. Bankily leads because it is the one most shops already use. */
  order: number;
  enabled: boolean;
  /** What the shopkeeper types into their payment app. */
  code: string;
  /**
   * True while `code` is a stand-in rather than a real destination.
   *
   * The website shows a visible test marking when this is set, and
   * {@link assertPaymentInstructionsSafeForProduction} refuses to let a
   * production deployment start while any provider is still a placeholder.
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

const PROVIDERS: readonly PaymentProvider[] = [
  { key: 'bankily', label: 'Bankily', order: 1, enabled: true, code: PLACEHOLDER_CODE, placeholder: true },
  { key: 'masrivi', label: 'Masrivi', order: 2, enabled: true, code: PLACEHOLDER_CODE, placeholder: true },
  { key: 'sedad', label: 'Sedad', order: 3, enabled: true, code: PLACEHOLDER_CODE, placeholder: true },
  { key: 'bimbank', label: 'Bimbank', order: 4, enabled: true, code: PLACEHOLDER_CODE, placeholder: true },
  { key: 'click', label: 'Click', order: 5, enabled: true, code: PLACEHOLDER_CODE, placeholder: true },
];

/** The default selection. Bankily, until somebody decides otherwise. */
export const DEFAULT_PROVIDER: PaymentProviderKey = 'bankily';

export interface PaymentInstructions {
  providers: PaymentProvider[];
  defaultProvider: PaymentProviderKey;
  /** True while ANY provider is a stand-in, so the client can mark itself clearly. */
  placeholder: boolean;
}

export function paymentInstructions(): PaymentInstructions {
  const providers = [...PROVIDERS].sort((a, b) => a.order - b.order);
  return {
    providers,
    defaultProvider: DEFAULT_PROVIDER,
    placeholder: providers.some((p) => p.placeholder),
  };
}

/**
 * Refuse to start a production deployment on placeholder codes.
 *
 * The failure this prevents is quiet and expensive: a shop reads `00000`,
 * pays nothing anywhere, and waits for an activation that is never coming —
 * while believing they have paid. Better that the deployment stops.
 */
export function assertPaymentInstructionsSafeForProduction(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const appEnv = (env.APP_ENV ?? '').toLowerCase();
  if (appEnv !== 'production') return;

  const stubs = paymentInstructions().providers.filter((p) => p.enabled && p.placeholder);
  if (stubs.length > 0) {
    throw new Error(
      'Payment instructions still carry placeholder codes for: ' +
        stubs.map((p) => p.key).join(', ') +
        '. Replace them with the real payment codes before running in production.',
    );
  }
}
