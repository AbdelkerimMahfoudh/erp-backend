import { binToUuid } from '../common/utils/uuid.util';

/**
 * What the app draws a product's picture from (D225): its category's built-in key or chosen icon, and its
 * parent's. Sent with every row that shows a product — Stock, a sale's lines, what the sale scanner found —
 * so the same category always draws the same picture. Never a guess from the tracking type: a PlayStation
 * is serial-tracked, and that does not make it a computer.
 */
export interface CategoryVisual {
  categoryId: string;
  key: string | null;
  icon: string | null;
  parentKey: string | null;
  parentIcon: string | null;
}

/** The columns `categoryVisualOf` reads, for a `product.category` select. */
export const CATEGORY_VISUAL_SELECT = {
  select: { id: true, key: true, icon: true, parent: { select: { key: true, icon: true } } },
} as const;

export type CategoryVisualSource = {
  id: Buffer;
  key: string | null;
  icon: string | null;
  parent: { key: string | null; icon: string | null } | null;
} | null;

export function categoryVisualOf(category: CategoryVisualSource | undefined): CategoryVisual | null {
  if (!category) return null;
  return {
    categoryId: binToUuid(category.id),
    key: category.key,
    icon: category.icon,
    parentKey: category.parent?.key ?? null,
    parentIcon: category.parent?.icon ?? null,
  };
}
