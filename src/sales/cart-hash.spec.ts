import { cartHash } from './cart-hash';

/** What makes a cart the same cart (D227). The approval flow through a real sale is held by the sale specs and the journey. */
describe('a cart’s hash', () => {
  const phone = { identifier: '356938035643809', price: 4000 };
  const other = { identifier: '490154203237518', price: 3000 };
  const case_ = { productId: 'p-1', quantity: 2, price: 150 };

  it('does not depend on the order of the lines', () => {
    expect(cartHash([phone, other, case_])).toBe(cartHash([case_, other, phone]));
  });

  it('changes with any item, quantity, price or discount', () => {
    const base = cartHash([phone, case_]);
    expect(cartHash([phone])).not.toBe(base);
    expect(cartHash([phone, case_, other])).not.toBe(base);
    expect(cartHash([{ ...phone, price: 3999 }, case_])).not.toBe(base);
    expect(cartHash([phone, { ...case_, quantity: 3 }])).not.toBe(base);
    expect(cartHash([phone, case_], 10)).not.toBe(base);
  });

  it('treats no discount and a zero discount as the same, and 4000 and 4000.00 as the same price', () => {
    expect(cartHash([phone], 0)).toBe(cartHash([phone]));
    expect(cartHash([{ ...phone, price: 4000.0 }])).toBe(cartHash([phone]));
  });
});
