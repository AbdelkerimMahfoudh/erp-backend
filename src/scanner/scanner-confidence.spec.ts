import { ScannerService } from './scanner.service';
import { DefaultConfidenceScorer } from './confidence/default-confidence.scorer';

const NO_MATCH = {
  alreadyInInventory: false,
  matchedIdentifierPosition: null,
  unit: null,
  elsewhere: false,
  conflictingUnits: false,
};

/**
 * Teaching the scanner must never make it less sure.
 *
 * Reported symptom: a barcode scans at confidence 1.0, the employee confirms
 * the product (which is what teaches it), and the next scan of the same code
 * comes back at 0.333 — the system becomes *less* certain the more it is told.
 * That inverts the product promise that recognition improves with use, and it
 * is visible: the confirmation card drops from "Recognized" to "Check this is
 * right" for a product the shop has now confirmed by hand.
 *
 * These tests pin the whole sequence rather than the formula alone, because
 * the formula was never the defect — precedence was.
 */

const BARCODE = '6001234500009';
const PRODUCT_A = 'aaaaaaaa-0000-7000-8000-000000000001';
const PRODUCT_B = 'bbbbbbbb-0000-7000-8000-000000000002';

function suggestion(productId: string) {
  return {
    productId,
    brand: 'Anker',
    model: 'PowerCore 10000',
    variant: null,
    trackingType: 'quantity',
    keySpecifications: {},
    image: null,
    defaultCost: 8.5,
    defaultPrice: 15,
  };
}

/**
 * @param learned  what the recognition memory holds, or null if untaught
 * @param barcodeOwner product whose OWN barcode equals the scanned code
 */
function makeScanner(
  learned: { productId: string; confirmations: number; corrections: number } | null,
  barcodeOwner: string | null = PRODUCT_A,
) {
  const scorer = new DefaultConfidenceScorer();

  const recognition = {
    resolve: jest.fn(async () =>
      learned
        ? {
            productId: Buffer.from(learned.productId.replace(/-/g, ''), 'hex'),
            signals: {
              timesSeen: learned.confirmations,
              confirmations: learned.confirmations,
              corrections: learned.corrections,
              lastConfirmedAt: new Date(),
              sourceStats: null,
            },
          }
        : null,
    ),
    confidenceOf: jest.fn((s: never) => scorer.score(s)),
  };

  const catalog = {
    findOrSuggest: jest.fn(async (q: { productId?: string; barcode?: string }) => {
      if (q.productId) return suggestion(q.productId);
      if (q.barcode) return barcodeOwner ? suggestion(barcodeOwner) : null;
      return null;
    }),
    recognize: jest.fn(async () => ({ known: false, suggestion: null })),
  };

  const registry = { get: () => ({ recognitionKey: (c: string) => ({ codeType: 'tac', code: c.slice(0, 8) }) }) };

  /*
   * The inventory lookup is stubbed to "nothing found": these tests are about
   * CONFIDENCE in a product suggestion, which is a different question from
   * whether the handset is already on the shelf. Conflating the two is exactly
   * what the contract now keeps apart.
   */
  const inventory = { describeIdentifierConflict: jest.fn(async () => NO_MATCH) };

  return new ScannerService(
    recognition as never,
    catalog as never,
    registry as never,
    inventory as never,
  );
}

describe('scanner confidence — teaching must not reduce certainty', () => {
  it('an exact barcode match scores 1.0 before anything is taught', async () => {
    const scanner = makeScanner(null);

    const result = await scanner.scan(BARCODE);

    expect(result.recognized).toBe(true);
    expect(result.confidence).toBe(1);
  });

  it('REGRESSION: after teaching once, the same scan must not drop to 0.333', async () => {
    const scanner = makeScanner({ productId: PRODUCT_A, confirmations: 1, corrections: 0 });

    const result = await scanner.scan(BARCODE);

    // The reported defect, stated as the thing that must not happen.
    expect(result.confidence).not.toBeCloseTo(0.333, 2);
    expect(result.confidence).toBe(1);
  });

  it('repeated confirmation never decreases confidence', async () => {
    const scores: number[] = [];
    for (const confirmations of [1, 2, 3, 10, 50]) {
      const scanner = makeScanner({ productId: PRODUCT_A, confirmations, corrections: 0 });
      scores.push((await scanner.scan(BARCODE)).confidence);
    }

    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });

  it('a learned mapping is never worse than the deterministic signal it replaced', async () => {
    const untaught = await makeScanner(null).scan(BARCODE);
    const taught = await makeScanner({
      productId: PRODUCT_A,
      confirmations: 1,
      corrections: 0,
    }).scan(BARCODE);

    expect(taught.confidence).toBeGreaterThanOrEqual(untaught.confidence);
  });

  it('a genuine conflict lowers confidence and says why', async () => {
    // Memory says product A; the barcode actually belongs to product B.
    const scanner = makeScanner(
      { productId: PRODUCT_A, confirmations: 5, corrections: 0 },
      PRODUCT_B,
    );

    const result = await scanner.scan(BARCODE);

    expect(result.confidence).toBeLessThan(1);
    // Ambiguity must be explained, not presented as quiet certainty.
    expect(result.hint).toBeDefined();
    expect(result.hint?.toLowerCase()).toContain('two');
  });

  it('corrections still erode confidence — the formula keeps working', async () => {
    const clean = await makeScanner({
      productId: PRODUCT_A,
      confirmations: 10,
      corrections: 0,
    }).scan(BARCODE);
    const corrected = await makeScanner(
      { productId: PRODUCT_A, confirmations: 10, corrections: 8 },
      PRODUCT_B, // no corroboration, so the statistical score stands alone
    ).scan(BARCODE);

    expect(corrected.confidence).toBeLessThan(clean.confidence);
  });
});

describe('DefaultConfidenceScorer — unchanged behaviour', () => {
  const scorer = new DefaultConfidenceScorer();

  it('still grows with evidence and shrinks with corrections', () => {
    const s = (confirmations: number, corrections: number) =>
      scorer.score({
        timesSeen: confirmations,
        confirmations,
        corrections,
        lastConfirmedAt: new Date(),
        sourceStats: null,
      } as never);

    expect(s(1, 0)).toBeCloseTo(1 / 3, 3);
    expect(s(10, 0)).toBeGreaterThan(s(1, 0));
    expect(s(10, 5)).toBeLessThan(s(10, 0));
    expect(s(0, 0)).toBe(0);
  });
});
