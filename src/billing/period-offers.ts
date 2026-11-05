import type { Activity } from '../entitlement/activity';

/**
 * What the Owner chooses on the portal, and what it costs (owner's decision, 2026-11-05).
 *
 * - **Durations:** 1, 3 or 12 months — nothing else is offered.
 * - **Per store**, so two stores are two prices in one payment:
 *   - an electronics store: 600 for 1 month, 1 500 for 3, 5 000 for 12;
 *   - a money services agent: 300 a month, times the months;
 *   - a store doing both: 800 a month, times the months;
 *   - each additional seat the store holds and pays for: 100 a month, times the months.
 * - **Integer MRU**, as every amount here (`pricing-rules.ts`).
 *
 * Shown on the portal only — never in the app — and computed here, so the page shows the server's figure and the
 * administrator's approval finds the same one.
 */
export const OFFER_MONTHS = [1, 3, 12] as const;
export type OfferMonths = (typeof OFFER_MONTHS)[number];

export const ELECTRONICS_PRICE: Readonly<Record<OfferMonths, number>> = { 1: 600, 3: 1500, 12: 5000 };
export const MONTHLY_PRICE: Readonly<Record<Exclude<Activity, 'electronics'>, number>> = { money_agent: 300, both: 800 };
export const SEAT_MONTHLY = 100;

export function isOfferMonths(n: unknown): n is OfferMonths {
  return (OFFER_MONTHS as readonly unknown[]).includes(n);
}

export interface QuoteStore {
  branchId: string;
  name: string;
  activity: Activity;
  /** Seats bought for this store: the ones that cost 100 a month. Granted and included seats cost nothing. */
  paidSeats: number;
  /** 0130: a branch added in the app, waiting for activation: priced like any store, activated by this payment. */
  pending?: boolean;
}

export interface QuoteLine {
  branchId: string;
  name: string;
  activity: Activity;
  storeAmount: number;
  paidSeats: number;
  seatAmount: number;
  amount: number;
  pending?: boolean;
}

export interface Quote {
  months: OfferMonths;
  lines: QuoteLine[];
  total: number;
}

export function storePrice(activity: Activity, months: OfferMonths): number {
  return activity === 'electronics' ? ELECTRONICS_PRICE[months] : MONTHLY_PRICE[activity] * months;
}

export function quote(stores: readonly QuoteStore[], months: OfferMonths): Quote {
  const lines = stores.map((s) => {
    const storeAmount = storePrice(s.activity, months);
    const paidSeats = Math.max(0, Math.trunc(s.paidSeats));
    const seatAmount = paidSeats * SEAT_MONTHLY * months;
    return { branchId: s.branchId, name: s.name, activity: s.activity, storeAmount, paidSeats, seatAmount, amount: storeAmount + seatAmount, ...(s.pending ? { pending: true } : {}) };
  });
  return { months, lines, total: lines.reduce((sum, l) => sum + l.amount, 0) };
}

/** Every offer for these stores, in the order the portal shows them. */
export function offers(stores: readonly QuoteStore[]): Quote[] {
  return OFFER_MONTHS.map((m) => quote(stores, m));
}
