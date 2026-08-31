/**
 * Storage and colour — the two things `products.variant` has always held.
 *
 * ## What `variant` actually means here (audited, not assumed)
 *
 * The schema says it outright, in `schema.prisma` on `DeviceModel`:
 *
 * > Storage, colour, cosmetic condition and an individual IMEI are deliberately
 * > absent: `products.variant` already carries storage and colour.
 *
 * And `catalog.service.ts` calls a product row "the exact-variant identity".
 * So `variant` is **storage and colour, in one free-text box** — not a market,
 * not a region, and not a place to repeat `Pro`, `Plus` or `Ultra`, which are
 * part of the model name and already come from the model selector.
 *
 * That audit is why there is no market/region list in this file. A region
 * selector would have been a new fact about a phone that nothing in the schema,
 * the API or the shop's data has ever recorded, and inventing one would put a
 * fourth term into the `(company, brand, model, variant)` unique key —
 * multiplying product rows for a distinction nobody has made yet. If a shop
 * ever needs it, it is a decision with a migration behind it, not a dropdown.
 *
 * ## Why lists at all
 *
 * The field was free text, so one shop's shelf held `128GB`, `128 gb`,
 * `128 Go` and `128`. Four spellings of one phone: four product rows, four
 * lines in a report, and a count that had to be added up by eye. Same disease
 * the brand and model selectors already cured, same cure.
 *
 * ## Why `Other` is a real option and not an escape hatch
 *
 * A shop that stocks something these lists do not name must still be able to
 * sell it today. `Other` reveals a free-text field, the typed value is kept
 * verbatim, and a product saved before these lists existed opens, edits and
 * saves with its old value intact and visible — see `parseVariant`.
 */

/** A pickable value. `key` is stable and canonical; `label` is what is shown. */
export interface AttributeOption {
  key: string;
  label: string;
}

/**
 * Capacities, smallest first.
 *
 * The small end is not legacy padding: 4–32 GB is exactly where the cheap
 * Android stock in this market sits, and a list starting at 64 GB would send
 * half of it straight to `Other`.
 */
export const STORAGE_OPTIONS: readonly AttributeOption[] = [
  { key: '4gb', label: '4 GB' },
  { key: '8gb', label: '8 GB' },
  { key: '16gb', label: '16 GB' },
  { key: '32gb', label: '32 GB' },
  { key: '64gb', label: '64 GB' },
  { key: '128gb', label: '128 GB' },
  { key: '256gb', label: '256 GB' },
  { key: '512gb', label: '512 GB' },
  { key: '1tb', label: '1 TB' },
  { key: '2tb', label: '2 TB' },
  { key: 'other', label: 'Other' },
];

/**
 * Colours as a shopkeeper says them, not as a manufacturer markets them.
 *
 * "Deep Purple", "Sierra Blue" and "Midnight" are marketing names for purple,
 * blue and black; nobody at a counter uses them, and putting them here would
 * mean the same phone filed under three names. A shop that genuinely needs the
 * marketing name types it into `Other`.
 */
export const COLOUR_OPTIONS: readonly AttributeOption[] = [
  { key: 'black', label: 'Black' },
  { key: 'white', label: 'White' },
  { key: 'gray', label: 'Gray' },
  { key: 'silver', label: 'Silver' },
  { key: 'gold', label: 'Gold' },
  { key: 'rose_gold', label: 'Rose Gold' },
  { key: 'blue', label: 'Blue' },
  { key: 'green', label: 'Green' },
  { key: 'red', label: 'Red' },
  { key: 'purple', label: 'Purple' },
  { key: 'pink', label: 'Pink' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'orange', label: 'Orange' },
  { key: 'brown', label: 'Brown' },
  { key: 'beige', label: 'Beige' },
  { key: 'other', label: 'Other' },
];

/** What separates storage from colour inside the stored string. */
export const VARIANT_SEPARATOR = ' · ';

export interface VariantParts {
  /** A `STORAGE_OPTIONS` key, or `other`. */
  storageKey: string | null;
  /** Free text when `storageKey` is `other`. */
  storageCustom: string;
  /** A `COLOUR_OPTIONS` key, or `other`. */
  colourKey: string | null;
  /** Free text when `colourKey` is `other`. */
  colourCustom: string;
}

export const EMPTY_VARIANT: VariantParts = {
  storageKey: null,
  storageCustom: '',
  colourKey: null,
  colourCustom: '',
};

const STORAGE_BY_LABEL = new Map(STORAGE_OPTIONS.map((o) => [o.label.toLowerCase(), o]));
const COLOUR_BY_LABEL = new Map(COLOUR_OPTIONS.map((o) => [o.label.toLowerCase(), o]));

/** Everything a shop has ever typed for 128 GB, mapped to the one option. */
function matchStorage(text: string): AttributeOption | null {
  const t = text.trim().toLowerCase();
  const exact = STORAGE_BY_LABEL.get(t);
  if (exact && exact.key !== 'other') return exact;
  // `128GB`, `128 gb`, `128 Go`, `128g`, and bare `128`.
  const m = /^(\d+)\s*(gb|go|g|tb|to|t)?$/.exec(t);
  if (!m) return null;
  const unit = m[2] ?? 'gb';
  const key = `${m[1]}${unit.startsWith('t') ? 'tb' : 'gb'}`;
  return STORAGE_OPTIONS.find((o) => o.key === key) ?? null;
}

function matchColour(text: string): AttributeOption | null {
  const t = text.trim().toLowerCase();
  const exact = COLOUR_BY_LABEL.get(t);
  if (exact && exact.key !== 'other') return exact;
  // `Rose gold`, `rose-gold`, `grey`.
  const norm = t.replace(/[^a-z]+/g, '_');
  if (norm === 'grey') return COLOUR_OPTIONS.find((o) => o.key === 'gray') ?? null;
  return COLOUR_OPTIONS.find((o) => o.key === norm && o.key !== 'other') ?? null;
}

/**
 * Turn a stored `variant` string back into selections.
 *
 * The point of this function is that **no existing value is ever lost or
 * silently rewritten.** Anything the lists recognise comes back as a normal
 * selection; anything they do not comes back as `Other` with the original text
 * intact, editable, and visible in the field. A product typed by hand three
 * years ago opens exactly as its owner left it.
 */
export function parseVariant(variant: string | null | undefined): VariantParts {
  const raw = (variant ?? '').trim();
  if (!raw) return { ...EMPTY_VARIANT };

  const pieces = raw
    .split(/[·,/|]|\s+-\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const parts: VariantParts = { ...EMPTY_VARIANT };
  const unmatched: string[] = [];

  for (const piece of pieces) {
    const storage = matchStorage(piece);
    if (storage && !parts.storageKey) {
      parts.storageKey = storage.key;
      continue;
    }
    const colour = matchColour(piece);
    if (colour && !parts.colourKey) {
      parts.colourKey = colour.key;
      continue;
    }
    unmatched.push(piece);
  }

  /*
   * Leftovers go to the colour slot as a custom value rather than being
   * dropped. Colour rather than storage because a piece that is not a capacity
   * is almost never a capacity, and because whatever it is, the shop wrote it
   * on purpose and must still see it.
   */
  if (unmatched.length) {
    if (!parts.colourKey) {
      parts.colourKey = 'other';
      parts.colourCustom = unmatched.join(VARIANT_SEPARATOR);
    } else {
      parts.storageKey = parts.storageKey ?? 'other';
      parts.storageCustom = parts.storageCustom || unmatched.join(VARIANT_SEPARATOR);
    }
  }

  return parts;
}

function labelFor(
  options: readonly AttributeOption[],
  key: string | null,
  custom: string,
): string | null {
  if (!key) return null;
  if (key === 'other') return custom.trim() || null;
  return options.find((o) => o.key === key)?.label ?? null;
}

/**
 * Compose selections back into the single string the column holds.
 *
 * Storage first, then colour — the order a phone is described in, and a fixed
 * order so the same phone always produces the same string. Two shops entering
 * the same handset must land on the same product row, which is the entire
 * reason the selectors exist.
 */
export function composeVariant(parts: VariantParts): string | null {
  const pieces = [
    labelFor(STORAGE_OPTIONS, parts.storageKey, parts.storageCustom),
    labelFor(COLOUR_OPTIONS, parts.colourKey, parts.colourCustom),
  ].filter((p): p is string => Boolean(p));
  return pieces.length ? pieces.join(VARIANT_SEPARATOR) : null;
}
