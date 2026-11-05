import { isOfferMonths, offers, quote, storePrice } from './period-offers';

/* The portal's prices (owner, 2026-11-05): per store; 1, 3 or 12 months; seats 100 a month times the months. */
describe('what each store costs', () => {
  it('an electronics store: 600, 1 500 or 5 000', () => {
    expect([1, 3, 12].map((m) => storePrice('electronics', m as 1))).toEqual([600, 1500, 5000]);
  });
  it('a money services agent: 300 a month; a store doing both: 800 a month — no duration price', () => {
    expect([1, 3, 12].map((m) => storePrice('money_agent', m as 1))).toEqual([300, 900, 3600]);
    expect([1, 3, 12].map((m) => storePrice('both', m as 1))).toEqual([800, 2400, 9600]);
  });
  it('only 1, 3 and 12 months are offered', () => {
    expect([0, 1, 2, 3, 6, 12, 24, '3'].map(isOfferMonths)).toEqual([false, true, false, true, false, true, false, false]);
  });
});

describe('a business’s quote', () => {
  const stores = [
    { branchId: 'a', name: 'Tevragh Zeina', activity: 'electronics' as const, paidSeats: 2 },
    { branchId: 'b', name: 'Ksar', activity: 'both' as const, paidSeats: 0 },
    { branchId: 'c', name: 'Sebkha', activity: 'money_agent' as const, paidSeats: 1 },
  ];
  it('two stores are two prices; seats are 100 a month times the months', () => {
    const q = quote(stores, 3);
    expect(q.lines.map((l) => [l.name, l.storeAmount, l.seatAmount, l.amount])).toEqual([
      ['Tevragh Zeina', 1500, 600, 2100],
      ['Ksar', 2400, 0, 2400],
      ['Sebkha', 900, 300, 1200],
    ]);
    expect(q.total).toBe(5700);
  });
  it('every offer, in order', () => {
    expect(offers(stores).map((q) => [q.months, q.total])).toEqual([[1, 600 + 200 + 800 + 300 + 100], [3, 5700], [12, 5000 + 2400 + 9600 + 3600 + 1200]]);
  });
  it('a business with one electronics store and no seats pays exactly the list price', () => {
    expect(offers([{ branchId: 'x', name: 'S', activity: 'electronics', paidSeats: 0 }]).map((q) => q.total)).toEqual([600, 1500, 5000]);
  });
});
