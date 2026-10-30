/**
 * Where a notification leads (D225): one typed destination per event, never a free address.
 *
 * Every notification stores an `actionLink` written by its emitter. Only the shapes below are destinations; anything
 * else — an older row, a malformed link, an address — leads to the notification centre and nothing else. The app
 * receives the destination's KIND and id, never a path to follow, and maps the kind to its own screen.
 *
 * Opening one is re-authorised on the server at the moment it is opened (`NotificationTargetService`): the
 * notification must still be the person's to see, the record must still exist, and the person must hold the
 * permission that screen requires — today, not when the event happened. A push delivered to a person since demoted
 * opens "no longer available to you", not the record.
 */

export type TargetKind =
  | 'sale'
  | 'return'
  | 'approval'
  | 'transfer'
  | 'loan'
  | 'consignment'
  | 'discrepancy'
  | 'expense'
  | 'closing_day'
  | 'stock'
  | 'product'
  | 'analytics'
  | 'staff'
  | 'acting_owner';

export interface NotificationTarget {
  kind: TargetKind;
  /** The record's id, for a destination that is one record. */
  id: string | null;
  /** A second id the screen needs: the unit of a product, the business day of a closing. */
  detail: string | null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The only link shapes that lead anywhere. Each names its kind; the id is captured, never trusted beyond its shape. */
const SHAPES: readonly { kind: TargetKind; pattern: RegExp }[] = [
  { kind: 'sale', pattern: new RegExp(`^/sales/(${UUID})$`) },
  { kind: 'return', pattern: new RegExp(`^/returns/(${UUID})$`) },
  { kind: 'approval', pattern: new RegExp(`^/approvals/(${UUID})$`) },
  { kind: 'transfer', pattern: new RegExp(`^/transfers/(${UUID})$`) },
  { kind: 'loan', pattern: new RegExp(`^/loans/(${UUID})$`) },
  { kind: 'consignment', pattern: new RegExp(`^/consignments/(${UUID})$`) },
  { kind: 'discrepancy', pattern: new RegExp(`^/discrepancies/(${UUID})$`) },
  { kind: 'expense', pattern: new RegExp(`^/expenses/(${UUID})$`) },
  { kind: 'closing_day', pattern: /^\/closing(?:\?date=(\d{4}-\d{2}-\d{2}))?$/ },
  { kind: 'stock', pattern: /^\/stock$/ },
  { kind: 'product', pattern: new RegExp(`^/catalog/(${UUID})(?:\\?unit=(${UUID}))?$`) },
  { kind: 'analytics', pattern: /^\/analytics$/ },
  { kind: 'staff', pattern: new RegExp(`^/staff/(${UUID})$`) },
  { kind: 'acting_owner', pattern: /^\/acting-owner$/ },
];

export function targetOf(actionLink: string | null | undefined): NotificationTarget | null {
  if (!actionLink) return null;
  const link = actionLink.toLowerCase();
  for (const { kind, pattern } of SHAPES) {
    const m = pattern.exec(link);
    if (!m) continue;
    if (kind === 'closing_day') return { kind, id: null, detail: m[1] ?? null };
    if (kind === 'stock' || kind === 'analytics' || kind === 'acting_owner') return { kind, id: null, detail: null };
    return { kind, id: m[1], detail: m[2] ?? null };
  }
  return null;
}

/** The link each emitter writes, so the shape is written in one place. */
export const links = {
  sale: (id: string) => `/sales/${id}`,
  return: (id: string) => `/returns/${id}`,
  approval: (id: string) => `/approvals/${id}`,
  transfer: (id: string) => `/transfers/${id}`,
  loan: (id: string) => `/loans/${id}`,
  consignment: (id: string) => `/consignments/${id}`,
  discrepancy: (id: string) => `/discrepancies/${id}`,
  expense: (id: string) => `/expenses/${id}`,
  closingDay: (date: string) => `/closing?date=${date}`,
  stock: () => '/stock',
  product: (id: string, unitId?: string | null) => (unitId ? `/catalog/${id}?unit=${unitId}` : `/catalog/${id}`),
  analytics: () => '/analytics',
  staff: (id: string) => `/staff/${id}`,
  actingOwner: () => '/acting-owner',
} as const;

/**
 * What each destination's screen requires — the same keys its API routes require. Any one of them suffices. `[]`: any
 * member of the store (stock and the catalogue are read by everybody who works there). `null`: nobody but the person
 * the record is about. The person's own record (their role change, their appointment) always opens for them.
 */
export const REQUIRES: Record<TargetKind, readonly string[] | null> = {
  sale: ['sale.view'],
  return: ['return.view'],
  approval: ['sale.create'],
  transfer: ['transfer.view'],
  loan: ['loan.view'],
  consignment: ['consignment.view'],
  discrepancy: ['closing.perform'],
  expense: ['expense.submit'],
  closing_day: ['closing.perform', 'report.view'],
  stock: [],
  product: [],
  analytics: ['report.view'],
  staff: ['user.manage'],
  acting_owner: null,
};
