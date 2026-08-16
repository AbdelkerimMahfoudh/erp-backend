/**
 * How a TAC becomes a product suggestion (Milestone C).
 *
 * Two layers of evidence with different authority, and the whole point is that
 * they never merge:
 *
 *   `tac_catalog`         GLOBAL, platform-controlled, generic manufacturer and
 *                         model only. **No store user writes to it**, and it can
 *                         never point at one tenant's Product — it has neither a
 *                         `company_id` nor a `product_id`.
 *
 *   `product_recognition` COMPANY-scoped. Maps a TAC to *that company's own*
 *                         Product, learned from explicit confirmation. One
 *                         company's mapping cannot change another's result,
 *                         because every read is scoped by the tenant extension.
 *
 * The ladder below is deterministic and ordered. It is a pure function of the
 * evidence so it can be reasoned about and tested without a database.
 */

export type SuggestionSource =
  | 'company_confirmed'
  | 'company_proposed'
  | 'global_catalog'
  | 'none';

export interface CompanyMapping {
  productId: string;
  status: 'proposed' | 'confirmed' | 'superseded';
  /** Only meaningful where the recognition system already computes it. */
  confidence?: number;
}

export interface GlobalEntry {
  brand: string | null;
  model: string | null;
  defaultVariant: string | null;
}

export interface TacSuggestion {
  source: SuggestionSource;
  /** The company's own Product — set ONLY by a confirmed company mapping. */
  productId: string | null;
  /** Generic identity. Never storage, colour, condition, cost or price. */
  brand: string | null;
  model: string | null;
  variant: string | null;
  /**
   * True when a human must decide before anything is selected. Set by a pending
   * proposal, and by conflicting evidence.
   */
  needsReview: boolean;
  /** Why review is needed, when it is. */
  reviewReason: 'unconfirmed_proposal' | 'conflicting_mappings' | null;
}

const UNKNOWN: TacSuggestion = {
  source: 'none',
  productId: null,
  brand: null,
  model: null,
  variant: null,
  needsReview: false,
  reviewReason: null,
};

/** Exactly eight digits. Anything else is not a TAC. */
export function isValidTac(tac: string): boolean {
  return /^\d{8}$/.test(tac);
}

/** The first eight digits of a 15-digit IMEI. */
export function tacFromImei(imei: string): string | null {
  return /^\d{15}$/.test(imei) ? imei.slice(0, 8) : null;
}

/**
 * Resolve a TAC to a suggestion.
 *
 * The order is the specification, and each rung exists for a reason:
 *
 * 1. **A confirmed company mapping wins outright.** Somebody with authority in
 *    this shop said this TAC is this product. Nothing generic outranks that.
 * 2. **A pending proposal is shown but never auto-selected.** An Employee's
 *    suggestion is evidence, not a decision — it is returned with
 *    `needsReview`, and `productId` stays null so no caller can treat it as
 *    authoritative by accident.
 * 3. **Otherwise the global catalogue gives manufacturer and model only.** It
 *    has no product to point at, and never gains one.
 * 4. **Otherwise unknown**, and a human chooses.
 *
 * Rule 7 of the brief — "exact confirmed evidence must not be weakened by a
 * lower learned score" — falls out of rung 1 being unconditional: confidence is
 * reported, never used to demote a confirmed mapping.
 */
export function resolveTac(input: {
  tac: string;
  companyMappings: CompanyMapping[];
  globalEntry: GlobalEntry | null;
}): TacSuggestion {
  if (!isValidTac(input.tac)) return UNKNOWN;

  const confirmed = input.companyMappings.filter((m) => m.status === 'confirmed');

  /**
   * More than one confirmed mapping should be impossible — the database refuses
   * it. Checked anyway: if it ever happens, the honest answer is to stop and
   * ask, not to pick one and hope.
   */
  if (confirmed.length > 1) {
    return {
      ...UNKNOWN,
      source: 'company_confirmed',
      needsReview: true,
      reviewReason: 'conflicting_mappings',
    };
  }

  if (confirmed.length === 1) {
    return {
      source: 'company_confirmed',
      productId: confirmed[0].productId,
      // Generic identity still comes from the global layer when it has it; the
      // exact product is the company's.
      brand: input.globalEntry?.brand ?? null,
      model: input.globalEntry?.model ?? null,
      variant: null,
      needsReview: false,
      reviewReason: null,
    };
  }

  const proposed = input.companyMappings.filter((m) => m.status === 'proposed');
  if (proposed.length > 0) {
    return {
      source: 'company_proposed',
      /**
       * Null on purpose. A proposal must never be auto-selected, and the surest
       * way to guarantee that is to give the caller nothing to select — the
       * suggestion is carried in `needsReview`, not in a product id.
       */
      productId: null,
      brand: input.globalEntry?.brand ?? null,
      model: input.globalEntry?.model ?? null,
      variant: null,
      needsReview: true,
      reviewReason: 'unconfirmed_proposal',
    };
  }

  if (input.globalEntry && (input.globalEntry.brand || input.globalEntry.model)) {
    return {
      source: 'global_catalog',
      // The global layer never names a tenant's product.
      productId: null,
      brand: input.globalEntry.brand,
      model: input.globalEntry.model,
      variant: input.globalEntry.defaultVariant,
      needsReview: false,
      reviewReason: null,
    };
  }

  return UNKNOWN;
}

/**
 * A dual-SIM phone has two TACs, and they describe **one** device.
 *
 * Both are resolved and then reconciled:
 *   - agreeing on a product is the strongest evidence there is;
 *   - one resolving and the other not is still usable — the phone is the one
 *     that resolved;
 *   - **disagreeing blocks automatic selection.** Two TACs naming different
 *     products means the read is wrong, the phone is unusual, or the mappings
 *     are. Any of those is a question for a human, and picking one would create
 *     an inventory record for a device that does not exist.
 */
export function reconcileDualSim(
  primary: TacSuggestion,
  secondary: TacSuggestion | null,
): TacSuggestion {
  if (!secondary) return primary;

  const a = primary.productId;
  const b = secondary.productId;

  if (a && b && a !== b) {
    return {
      ...UNKNOWN,
      source: 'company_confirmed',
      needsReview: true,
      reviewReason: 'conflicting_mappings',
    };
  }

  // One resolved, the other did not: use the one that did.
  if (a && !b) return primary;
  if (b && !a) return secondary;

  // Both agree, or neither resolved — either way the primary reading stands,
  // and it already carries any review flag of its own.
  return primary.source !== 'none' ? primary : secondary;
}
