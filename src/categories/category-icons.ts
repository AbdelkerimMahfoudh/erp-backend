/**
 * The illustrations a shop's own category may wear (D225).
 *
 * A product's picture comes from what it IS — its category — never from a fallback that assumes every
 * device is a phone: a PlayStation 5 filed under Gaming consoles shows a console, not a desktop. The
 * built-in categories are mapped by their stable key in the app (`lib/category-illustration.ts`); a
 * shop's own category stores one of these names in `product_categories.icon`, chosen by whoever may
 * manage the catalogue. NULL means "none chosen": the app then shows its built-in parent's picture, or a
 * neutral generic one — never an unrelated phone or computer.
 *
 * The list is closed and short on purpose. It is the maintainable unit (a category, not a model), and the
 * app draws exactly these; a name the app does not know would draw nothing.
 */
export const CATEGORY_ICONS = [
  'phone',
  'tablet',
  'laptop',
  'desktop',
  'monitor',
  'console',
  'controller',
  'tv',
  'earbuds',
  'headphones',
  'smartwatch',
  'speaker',
  'camera',
  'router',
  'charger',
  'cable',
  'powerbank',
  'storage',
  'sim',
  'screen_protector',
  'case',
  'printer',
  'electronics',
  'accessory',
] as const;

export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

const KNOWN: ReadonlySet<string> = new Set(CATEGORY_ICONS);

export function isCategoryIcon(value: unknown): value is CategoryIcon {
  return typeof value === 'string' && KNOWN.has(value);
}
