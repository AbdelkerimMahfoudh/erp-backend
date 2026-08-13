import { BadRequestException } from '@nestjs/common';
import { countLines, normalizeLines, transferFingerprint } from './transfer-lines';
import { CreateTransferDto } from './dto/transfer.dto';

/**
 * The line rules, tested directly.
 *
 * These are the two places a quantity transfer can go wrong quietly: a
 * duplicate that hides an over-request, and a fingerprint that either treats a
 * reorder as a new request or treats a genuinely different request as a replay.
 */

const FROM = Buffer.from('11111111111111111111111111111111', 'hex');
const TO = '22222222-2222-7222-8222-222222222222';
const CABLE = '33333333-3333-7333-8333-333333333333';
const CASE_ = '44444444-4444-7444-8444-444444444444';

const dto = (over: Partial<CreateTransferDto>): CreateTransferDto =>
  ({ clientUuid: 'c0000000-0000-7000-8000-000000000000', toBranchId: TO, ...over }) as CreateTransferDto;

describe('normalizeLines', () => {
  it('reads a serialized-only request', () => {
    const out = normalizeLines(
      dto({ lines: [{ kind: 'unit', identifier: '356938035643809' }] }),
    );
    expect(out.identifiers).toEqual(['356938035643809']);
    expect(out.quantities).toEqual([]);
  });

  it('reads a quantity-only request', () => {
    const out = normalizeLines(dto({ lines: [{ kind: 'stock', productId: CABLE, quantity: 10 }] }));
    expect(out.identifiers).toEqual([]);
    expect(out.quantities).toEqual([{ productId: CABLE, quantity: 10 }]);
  });

  it('reads a mixed request', () => {
    const out = normalizeLines(
      dto({
        lines: [
          { kind: 'unit', identifier: '356938035643809' },
          { kind: 'stock', productId: CABLE, quantity: 10 },
          { kind: 'unit', identifier: '356938035643810' },
        ],
      }),
    );
    expect(out.identifiers).toHaveLength(2);
    expect(out.quantities).toHaveLength(1);
  });

  it('still accepts the serialized-only shape earlier clients send', () => {
    const out = normalizeLines(dto({ identifiers: [' 356938035643809 '] }));
    expect(out.identifiers).toEqual(['356938035643809']);
  });

  it('prefers `lines` when a client sends both', () => {
    const out = normalizeLines(
      dto({ identifiers: ['999999999999999'], lines: [{ kind: 'stock', productId: CABLE, quantity: 2 }] }),
    );
    expect(out.identifiers).toEqual([]);
    expect(out.quantities).toEqual([{ productId: CABLE, quantity: 2 }]);
  });

  it('refuses an empty request', () => {
    expect(() => normalizeLines(dto({ lines: [] }))).toThrow(BadRequestException);
  });

  it('REPORTS a phone scanned twice rather than quietly merging it', () => {
    expect(() =>
      normalizeLines(
        dto({
          lines: [
            { kind: 'unit', identifier: '356938035643809' },
            { kind: 'unit', identifier: '356938035643809' },
          ],
        }),
      ),
    ).toThrow(/listed more than once/i);
  });

  it('REPORTS the same product on two lines — the over-request hiding place', () => {
    // 6 + 6 against 10 available: each line passes on its own, and together
    // they promise 12. Merging them would have made that invisible.
    try {
      normalizeLines(
        dto({
          lines: [
            { kind: 'stock', productId: CABLE, quantity: 6 },
            { kind: 'stock', productId: CABLE, quantity: 6 },
          ],
        }),
      );
      throw new Error('should have thrown');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as { problems: { productId: string }[] };
      expect(body.problems[0].productId).toBe(CABLE);
    }
  });

  it('allows two different products', () => {
    const out = normalizeLines(
      dto({
        lines: [
          { kind: 'stock', productId: CABLE, quantity: 6 },
          { kind: 'stock', productId: CASE_, quantity: 6 },
        ],
      }),
    );
    expect(out.quantities).toHaveLength(2);
  });

  it('refuses a blank identifier instead of looking one up', () => {
    expect(() => normalizeLines(dto({ lines: [{ kind: 'unit', identifier: '   ' }] }))).toThrow(
      BadRequestException,
    );
  });
});

describe('transferFingerprint', () => {
  const fp = (lines: Parameters<typeof normalizeLines>[0]) =>
    transferFingerprint(normalizeLines(lines), FROM, TO);

  it('does not change when quantity lines are reordered', () => {
    const a = fp(
      dto({
        lines: [
          { kind: 'stock', productId: CABLE, quantity: 10 },
          { kind: 'stock', productId: CASE_, quantity: 4 },
        ],
      }),
    );
    const b = fp(
      dto({
        lines: [
          { kind: 'stock', productId: CASE_, quantity: 4 },
          { kind: 'stock', productId: CABLE, quantity: 10 },
        ],
      }),
    );
    expect(a).toBe(b);
  });

  it('does not change when phones are scanned in another order', () => {
    const a = fp(
      dto({ lines: [{ kind: 'unit', identifier: 'A' }, { kind: 'unit', identifier: 'B' }] }),
    );
    const b = fp(
      dto({ lines: [{ kind: 'unit', identifier: 'B' }, { kind: 'unit', identifier: 'A' }] }),
    );
    expect(a).toBe(b);
  });

  it('CHANGES when the quantity changes — 10 cables is not 4 cables', () => {
    const a = fp(dto({ lines: [{ kind: 'stock', productId: CABLE, quantity: 10 }] }));
    const b = fp(dto({ lines: [{ kind: 'stock', productId: CABLE, quantity: 4 }] }));
    expect(a).not.toBe(b);
  });

  it('CHANGES when the product changes', () => {
    const a = fp(dto({ lines: [{ kind: 'stock', productId: CABLE, quantity: 10 }] }));
    const b = fp(dto({ lines: [{ kind: 'stock', productId: CASE_, quantity: 10 }] }));
    expect(a).not.toBe(b);
  });

  it('CHANGES when a line is added', () => {
    const a = fp(dto({ lines: [{ kind: 'stock', productId: CABLE, quantity: 10 }] }));
    const b = fp(
      dto({
        lines: [
          { kind: 'stock', productId: CABLE, quantity: 10 },
          { kind: 'unit', identifier: 'A' },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  it('CHANGES when the source branch changes — same key, different goods', () => {
    const lines = normalizeLines(dto({ lines: [{ kind: 'stock', productId: CABLE, quantity: 10 }] }));
    const other = Buffer.from('99999999999999999999999999999999', 'hex');
    expect(transferFingerprint(lines, FROM, TO)).not.toBe(transferFingerprint(lines, other, TO));
  });

  it('CHANGES when the destination changes', () => {
    const lines = normalizeLines(dto({ lines: [{ kind: 'stock', productId: CABLE, quantity: 10 }] }));
    expect(transferFingerprint(lines, FROM, TO)).not.toBe(
      transferFingerprint(lines, FROM, '55555555-5555-7555-8555-555555555555'),
    );
  });

  it('is case-insensitive about uuids, which clients format differently', () => {
    const lower = fp(dto({ lines: [{ kind: 'stock', productId: CABLE.toLowerCase(), quantity: 3 }] }));
    const upper = fp(dto({ lines: [{ kind: 'stock', productId: CABLE.toUpperCase(), quantity: 3 }] }));
    expect(lower).toBe(upper);
  });

  it('does not confuse a serialized line with a quantity line of the same text', () => {
    const a = fp(dto({ lines: [{ kind: 'unit', identifier: CABLE }] }));
    const b = fp(dto({ lines: [{ kind: 'stock', productId: CABLE, quantity: 1 }] }));
    expect(a).not.toBe(b);
  });
});

describe('countLines', () => {
  const unit = () => ({ unitId: Buffer.alloc(1), quantity: 1 });

  it('counts 2 phones and 10 accessories as 12 things', () => {
    expect(countLines([unit(), unit(), { unitId: null, quantity: 10 }])).toEqual({
      unitCount: 2,
      quantityLineCount: 1,
      totalQuantity: 12,
    });
  });

  it('never calls ten chargers one item', () => {
    const counts = countLines([{ unitId: null, quantity: 10 }]);
    expect(counts.totalQuantity).toBe(10);
    expect(counts.quantityLineCount).toBe(1);
  });

  it('is zero for an empty transfer rather than throwing', () => {
    expect(countLines([])).toEqual({ unitCount: 0, quantityLineCount: 0, totalQuantity: 0 });
  });
});
