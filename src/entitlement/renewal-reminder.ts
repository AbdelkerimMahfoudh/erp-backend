import type { Entitlement } from './entitlement-rules';

/**
 * The in-app renewal reminder's rules (owner's brief, 2026-11-05): pure and clock-injected.
 *
 * - **When:** 3, 2 and 1 days before the access the business is on ends — the same milestones as the WhatsApp expiry
 *   message (`notices/notice-rules.ts`, 72, 48 and 24 hours): more than 48 and at most 72 hours left is 3, more than 24 is 2,
 *   the last 24 hours are 1. Before 72 hours, at the end and after it, nothing: grace and expiry have their own messages.
 * - **What ends:** a running free trial with nothing paid to follow it, or a paid period. A grant (complimentary access)
 *   is not renewed by the business, a suspended, cancelled or refused business has nothing to renew, and grace is past
 *   the milestones.
 * - **Computed by the server**, never by the phone: the phone shows the number it is given.
 */
export type ReminderDays = 1 | 2 | 3;
export type ReminderKind = 'trial' | 'paid';

const HOUR_MS = 3_600_000;

export function reminderDaysLeft(end: Date, now: Date): ReminderDays | null {
  const left = end.getTime() - now.getTime();
  if (left <= 0) return null;
  if (left <= 24 * HOUR_MS) return 1;
  if (left <= 48 * HOUR_MS) return 2;
  if (left <= 72 * HOUR_MS) return 3;
  return null;
}

/** The access that is about to end and could be renewed, or null. */
export function renewableEnd(e: Pick<Entitlement, 'state' | 'isComplimentary' | 'periodEnd' | 'trial'>): { kind: ReminderKind; end: Date } | null {
  if (e.state === 'trial_active') {
    // Paid access already waiting to start at the trial's end (C6) is renewed already.
    if (!e.trial?.endsAt || e.trial.accessAfterTrial) return null;
    return { kind: 'trial', end: new Date(e.trial.endsAt) };
  }
  if (e.state === 'active' && !e.isComplimentary && e.periodEnd) return { kind: 'paid', end: new Date(e.periodEnd) };
  return null;
}

/** The milestone's identity: one per business, Owner, access end and milestone — so at most once a day, on every device. */
export function reminderDedupeKey(companyHex: string, userHex: string, end: Date, days: ReminderDays): string {
  return `renewal:${companyHex}:${userHex}:${end.getTime().toString(36)}:${days}`;
}

/** The Owner's page for the subscription: fixed, secret-free (the portal's sign-in protects it). */
export const RENEWAL_LINK_PATH = '/subscription';
