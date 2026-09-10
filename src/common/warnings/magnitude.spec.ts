import { magnitudeBucket, magnitudeWarning, MAGNITUDE_FACTOR } from './magnitude';
import { median } from './magnitude.service';
import { WarningReference } from './warning.types';

const price = (amount: number | null, sample: number | null = null): WarningReference => ({
  kind: 'configured_price',
  amount,
  sample,
});

const saleWarning = (submitted: number, reference: WarningReference | null, minSample?: number) =>
  magnitudeWarning({
    code: 'magnitude.sale_price',
    field: 'lines.0.price',
    submitted,
    reference,
    minSample,
  });

describe('order-of-magnitude detection (A1)', () => {
  describe('the threshold is the shape of the mistake', () => {
    it('warns at exactly ten times, because that is a missing zero', () => {
      const w = saleWarning(170_000, price(17_000));
      expect(w?.code).toBe('magnitude.sale_price');
      expect(w?.params.direction).toBe('high');
      expect(w?.params.factor).toBe(10);
    });

    it('warns at exactly one tenth', () => {
      const w = saleWarning(1_700, price(17_000));
      expect(w?.params.direction).toBe('low');
      expect(w?.params.factor).toBe(10);
    });

    it('says nothing just under the threshold, in either direction', () => {
      expect(saleWarning(169_999, price(17_000))).toBeNull();
      expect(saleWarning(1_701, price(17_000))).toBeNull();
    });

    it('says nothing about ordinary variation', () => {
      // Triple the usual price is unusual; it is not a decimal place.
      expect(saleWarning(51_000, price(17_000))).toBeNull();
      expect(saleWarning(8_500, price(17_000))).toBeNull();
    });
  });

  describe('silence, which is the common case', () => {
    it('says nothing when there is no reference at all', () => {
      expect(saleWarning(170_000, null)).toBeNull();
    });

    it('says nothing when the reference exists but may not be shown', () => {
      /*
       * A cost-derived reference, withheld from a caller without `cost.view`.
       * A caution whose basis cannot be shown is one the reader cannot act on,
       * and quoting the figure anyway would make the typo check a hole in the
       * cost gate.
       */
      expect(saleWarning(170_000, price(null))).toBeNull();
    });

    it('says nothing when the reference is zero', () => {
      expect(saleWarning(170_000, price(0))).toBeNull();
    });

    it('says nothing about a submitted zero', () => {
      // A giveaway or a warranty replacement. Governed by the configured-price
      // floor, which is an approval, not a typo check.
      expect(saleWarning(0, price(17_000))).toBeNull();
    });

    it('says nothing below the minimum sample', () => {
      expect(saleWarning(170_000, { kind: 'median_sale_price', amount: 17_000, sample: 4 }, 5)).toBeNull();
    });

    it('speaks once the sample is large enough', () => {
      const w = saleWarning(170_000, { kind: 'median_sale_price', amount: 17_000, sample: 5 }, 5);
      expect(w).not.toBeNull();
      expect(w?.reference?.sample).toBe(5);
    });

    it('needs no sample for a reference that is a decision rather than an observation', () => {
      // A configured price carries `sample: null`. A minimum must not silence it.
      expect(saleWarning(170_000, price(17_000), 5)).not.toBeNull();
    });
  });

  describe('the factor is a bucket, not a ratio', () => {
    it('reports 10, 100 and 1000 and nothing between', () => {
      expect(saleWarning(170_000, price(17_000))?.params.factor).toBe(10);
      expect(saleWarning(1_700_000, price(17_000))?.params.factor).toBe(100);
      expect(saleWarning(17_000_000, price(17_000))?.params.factor).toBe(1000);
    });

    it('stops at a thousand, because the sentence stops helping', () => {
      expect(magnitudeBucket(10_000_000)).toBe(1000);
    });

    it('does not move when the reference drifts by a unit', () => {
      /*
       * Load-bearing. `acknowledgement.ts` binds parameters into the
       * fingerprint and excludes the reference — which is only safe while the
       * parameters are stable. A raw ratio would change on every request and
       * force a fresh confirmation each time, which is how a warning becomes
       * noise people tap through.
       */
      const a = saleWarning(200_000, price(17_000));
      const b = saleWarning(200_000, price(17_050));
      expect(a?.params).toEqual({ direction: 'high', factor: 10 });
      expect(a?.params).toEqual(b?.params);
    });
  });

  describe('direction', () => {
    it('can be limited to "too high"', () => {
      // Paying a tenth of what is owed is an ordinary part payment.
      const low = magnitudeWarning({
        code: 'magnitude.debt_payment',
        field: 'amount',
        submitted: 100,
        reference: { kind: 'outstanding_balance', amount: 10_000, sample: null },
        directions: ['high'],
      });
      expect(low).toBeNull();

      const high = magnitudeWarning({
        code: 'magnitude.debt_payment',
        field: 'amount',
        submitted: 100_000,
        reference: { kind: 'outstanding_balance', amount: 10_000, sample: null },
        directions: ['high'],
      });
      expect(high?.params.direction).toBe('high');
    });
  });

  describe('what travels to the client', () => {
    it('carries a key and parameters, never a sentence', () => {
      const w = saleWarning(170_000, price(17_000));
      expect(w?.messageKey).toBe('warning.magnitude.salePrice.high');
      expect(typeof w?.messageKey).toBe('string');
      expect(Object.values(w?.params ?? {}).every((v) => ['string', 'number'].includes(typeof v))).toBe(true);
    });

    it('is always a caution, because it is a question to answer', () => {
      // `info` belongs to the anomaly rules, which are read rather than confirmed.
      expect(saleWarning(170_000, price(17_000))?.severity).toBe('caution');
    });

    it('echoes what was submitted and what it was compared against', () => {
      const w = saleWarning(170_000, price(17_000));
      expect(w?.submitted).toBe(170_000);
      expect(w?.reference).toEqual({ kind: 'configured_price', amount: 17_000, sample: null });
      expect(w?.field).toBe('lines.0.price');
    });
  });

  it('uses ten as the factor, stated once', () => {
    expect(MAGNITUDE_FACTOR).toBe(10);
  });
});

describe('median', () => {
  it('is the middle value for an odd count', () => {
    expect(median([1, 5, 100])).toBe(5);
  });

  it('is the mean of the middle two for an even count', () => {
    expect(median([1, 5, 7, 100])).toBe(6);
  });

  it('is zero for nothing, which callers never reach — they check first', () => {
    expect(median([])).toBe(0);
  });
});
