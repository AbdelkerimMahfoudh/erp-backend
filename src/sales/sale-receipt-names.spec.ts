import { readFileSync } from 'node:fs';
import { receiptNamesOf } from './sales.service';

/**
 * Who a receipt says issued it (0111, D225): the business, the store and the seller as named when the sale was
 * confirmed, in both scripts. A rename later never rewrites an old receipt.
 */

const LIVE = {
  company: { name: 'PS5 Center', nameAr: 'مركز PS5' },
  branch: { name: 'Tevragh Zeina', nameAr: 'تفرغ زينة' },
  user: { name: 'Aminetou', nameAr: 'أمينتو' },
};

const none = {
  businessNameSnapshot: null,
  businessNameArSnapshot: null,
  branchNameSnapshot: null,
  branchNameArSnapshot: null,
  sellerNameSnapshot: null,
  sellerNameArSnapshot: null,
};

describe('the names a receipt prints', () => {
  it('are the snapshot, not the names given since', () => {
    const sold = {
      ...LIVE,
      businessNameSnapshot: 'Game Center',
      businessNameArSnapshot: null,
      branchNameSnapshot: 'Centre',
      branchNameArSnapshot: 'المركز',
      sellerNameSnapshot: 'Aminetou',
      sellerNameArSnapshot: null,
    };
    expect(receiptNamesOf(sold)).toEqual({
      business: { name: 'Game Center', nameAr: null },
      branch: { name: 'Centre', nameAr: 'المركز' },
      seller: { name: 'Aminetou', nameAr: null },
      snapshot: true,
    });
  });

  it('a sale before 0111 names the live records, as its receipt always did', () => {
    expect(receiptNamesOf({ ...none, ...LIVE })).toEqual({
      business: LIVE.company,
      branch: LIVE.branch,
      seller: LIVE.user,
      snapshot: false,
    });
  });

  it('a sale with nobody to name says nothing rather than inventing a name', () => {
    expect(receiptNamesOf({ ...none, company: null, branch: null, user: null })).toEqual({
      business: null,
      branch: null,
      seller: null,
      snapshot: false,
    });
  });
});

describe('the sale writes the snapshot when it is confirmed', () => {
  const source = readFileSync('src/sales/sales.service.ts', 'utf8');
  const create = source.slice(source.indexOf('await tx.sale.create({'), source.indexOf('for (const p of prepared)'));

  it.each([
    'businessNameSnapshot: business?.name',
    'businessNameArSnapshot: business?.nameAr',
    'branchNameSnapshot: store?.name',
    'branchNameArSnapshot: store?.nameAr',
    'sellerNameSnapshot: seller?.name',
    'sellerNameArSnapshot: seller?.nameAr',
  ])('%s', (field) => expect(create).toContain(field));

  it('reads the names inside the sale transaction, so the snapshot is what the sale was confirmed under', () => {
    const lookup = source.slice(source.indexOf('const [business, store, seller]'), source.indexOf('await tx.sale.create({'));
    expect(lookup).toContain('tx.company.findUnique');
    expect(lookup).toContain('tx.branch.findUnique');
    expect(lookup).toContain('tx.user.findUnique');
  });
});
