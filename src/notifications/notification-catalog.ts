/**
 * Every notification the server writes, classified once (D225, the owner's TestFlight feedback of 2026-10-29).
 *
 * `category` is the notification centre's filter (All · Approvals · Sales · Stock · Money; staff and security show
 * under All). `importance` decides push under each person's level:
 *
 *  - **All activity** — every authorized event;
 *  - **Important** (the default for Owners and Managers) — returns and refunds, expenses and withdrawals, loans,
 *    below-cost sales, large adjustments, reconciliation discrepancies, staff and account changes, approval requests
 *    and outcomes, security and subscription problems. Routine sales and receiving stay in the centre and reports;
 *  - **Approvals only** (the default for Employees) — only what waits for this person's decision, and critical
 *    security events.
 *
 * Push never widens access: a person is told only of events they could already open, and never of their own action.
 * The centre keeps every authorized event, whatever the level. An unknown type is `other` / `routine`: shown, never
 * pushed except under All activity — so a new event cannot start pushing unreviewed.
 */

export type NotificationCategory = 'approvals' | 'sales' | 'stock' | 'money' | 'staff' | 'security' | 'other';
export type Importance = 'routine' | 'important' | 'approval' | 'critical';
export type NotificationLevel = 'all' | 'important' | 'approvals';

export const NOTIFICATION_LEVELS: readonly NotificationLevel[] = ['all', 'important', 'approvals'];

interface Entry {
  category: NotificationCategory;
  importance: Importance;
}

const EXACT: Record<string, Entry> = {
  'sale.recorded': { category: 'sales', importance: 'routine' },
  'stock.received': { category: 'stock', importance: 'routine' },
  'price.changed': { category: 'stock', importance: 'routine' },
  'closing.completed': { category: 'money', importance: 'routine' },
  'closing.reopened': { category: 'money', importance: 'important' },
  'closing.reclosed': { category: 'money', importance: 'important' },
  'closing.sale': { category: 'money', importance: 'important' },
  'debt.charged': { category: 'money', importance: 'important' },
  'loan.proposed': { category: 'approvals', importance: 'approval' },
  'consignment.requested': { category: 'approvals', importance: 'approval' },
  'discount_approval.requested': { category: 'approvals', importance: 'approval' },
  'discount_approval.approved': { category: 'approvals', importance: 'important' },
  'discount_approval.rejected': { category: 'approvals', importance: 'important' },
  'return.requested': { category: 'approvals', importance: 'approval' },
  'return.custody_received': { category: 'sales', importance: 'important' },
  'return.under_review': { category: 'approvals', importance: 'approval' },
  'return.approved': { category: 'sales', importance: 'important' },
  'return.rejected': { category: 'sales', importance: 'important' },
  'return.refund_reported': { category: 'approvals', importance: 'approval' },
  'return.refund_corrected': { category: 'money', importance: 'important' },
  'return.refund_confirmed': { category: 'money', importance: 'important' },
  'transfer.requested': { category: 'approvals', importance: 'approval' },
  'transfer.created_approved': { category: 'stock', importance: 'important' },
  'transfer.approved': { category: 'stock', importance: 'important' },
  'transfer.rejected': { category: 'stock', importance: 'important' },
  'transfer.shipped': { category: 'stock', importance: 'important' },
  'transfer.received': { category: 'stock', importance: 'routine' },
  'transfer.cancelled': { category: 'stock', importance: 'important' },
  'anomaly.overdue_debt': { category: 'money', importance: 'important' },
  'anomaly.cash_shortfall': { category: 'money', importance: 'important' },
  'anomaly.below_cost_cluster': { category: 'sales', importance: 'important' },
  'staff.role_changed': { category: 'staff', importance: 'important' },
  'acting_owner.appointed': { category: 'security', importance: 'critical' },
  'acting_owner.revoked': { category: 'security', importance: 'critical' },
};

export function classify(type: string): Entry {
  return EXACT[type] ?? { category: 'other', importance: 'routine' };
}

/** Every type in a filter, for the centre's query. `other`, `staff` and `security` appear under All only. */
export function typesIn(category: Exclude<NotificationCategory, 'other'>): string[] {
  return Object.entries(EXACT)
    .filter(([, e]) => e.category === category)
    .map(([type]) => type);
}

export function knownTypes(): string[] {
  return Object.keys(EXACT);
}

/** The level a person has until they choose: Important for Owners and Managers, Approvals only for everyone else. */
export function defaultLevel(roles: readonly string[]): NotificationLevel {
  return roles.some((r) => r === 'owner' || r === 'store_manager' || r === 'branch_manager') ? 'important' : 'approvals';
}

/**
 * Whether this event is pushed to this person — never to the person who did it (it stays in their centre), and only
 * as their level allows. Critical security events reach everyone they concern.
 */
export function shouldPush(input: { type: string; level: NotificationLevel; recipientId: string; actorId: string | null }): boolean {
  if (input.actorId !== null && input.actorId === input.recipientId) return false;
  const { importance } = classify(input.type);
  if (importance === 'critical') return true;
  if (input.level === 'all') return true;
  if (input.level === 'important') return importance === 'important' || importance === 'approval';
  return importance === 'approval';
}
