/**
 * Matching a file's labels to the catalogue — and refusing to guess.
 *
 * A file says "Apple / iPhone 12 / 128 / Black". The catalogue holds products
 * with a brand, a model and a variant. This decides which product a row means,
 * and when it will not decide it says so instead: an ambiguous row goes to
 * review, an unknown one waits for a person to choose or to create the product
 * through the existing authorised flow. **Nothing here creates a product or a
 * category**, and a TAC never fills in a model.
 */

export interface CatalogueProduct {
  id: string;
  brand: string;
  model: string;
  variant: string | null;
  trackingType: 'imei' | 'serial' | 'quantity';
}

export interface MatchInput {
  brand: string | null;
  model: string | null;
  storage: string | null;
  colour: string | null;
}

export type MatchOutcome =
  | { kind: 'matched'; productId: string; exact: boolean }
  | { kind: 'ambiguous'; candidates: CatalogueProduct[] }
  | { kind: 'unknown' };

/** Letters and digits, lower-cased: "128 GB" and "128GB" are the same variant. */
export function fold(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]/g, '');
}

/** The variant a row describes, as the catalogue would write it. */
export function variantLabel(storage: string | null, colour: string | null): string | null {
  const parts: string[] = [];
  if (storage) parts.push(/\d$/.test(storage.trim()) ? `${storage.trim()} GB` : storage.trim());
  if (colour) parts.push(colour.trim());
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Only phones are matched by IMEI: a row carrying an IMEI must not land on a
 * quantity-tracked accessory, whatever its labels say.
 */
export function matchProduct(input: MatchInput, catalogue: readonly CatalogueProduct[]): MatchOutcome {
  const model = fold(input.model);
  if (!model) return { kind: 'unknown' };

  const byModel = catalogue.filter(
    (p) => fold(p.model) === model && (!input.brand || fold(p.brand) === fold(input.brand)),
  );
  if (byModel.length === 0) return { kind: 'unknown' };

  const wanted = fold(variantLabel(input.storage, input.colour));
  if (wanted) {
    const exact = byModel.filter((p) => fold(p.variant) === wanted);
    if (exact.length === 1) return { kind: 'matched', productId: exact[0].id, exact: true };
    if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };

    // Same model, different variant wording: a person decides, we do not.
    const storage = fold(input.storage);
    const colour = fold(input.colour);
    const near = byModel.filter((p) => {
      const v = fold(p.variant);
      return (!storage || v.includes(storage)) && (!colour || v.includes(colour));
    });
    if (near.length === 1) return { kind: 'matched', productId: near[0].id, exact: false };
    if (near.length > 1) return { kind: 'ambiguous', candidates: near };
    return { kind: 'ambiguous', candidates: byModel };
  }

  if (byModel.length === 1) return { kind: 'matched', productId: byModel[0].id, exact: false };
  return { kind: 'ambiguous', candidates: byModel };
}
