import { ScannerService } from './scanner.service';

/**
 * Every hint the scanner gives has a stable code a client can translate.
 *
 * The English `hint` used to be shown verbatim on French and Arabic screens —
 * "Unknown IMEI — create a new product template." in the middle of a French
 * sheet. The English text is kept for older clients; staff-facing screens
 * translate `hintCode`.
 */

const NO_MATCH = {
  alreadyInInventory: false,
  matchedIdentifierPosition: null,
  unit: null,
  elsewhere: false,
  conflictingUnits: false,
};

function scanner(opts: { tacKnown?: boolean; barcodeProduct?: boolean } = {}) {
  return new ScannerService(
    { resolve: jest.fn(async () => null), confidenceOf: jest.fn() } as never,
    {
      findOrSuggest: jest.fn(async () => (opts.barcodeProduct ? { productId: 'p', brand: 'A', model: 'B' } : null)),
      recognize: jest.fn(async () => ({ known: Boolean(opts.tacKnown), suggestion: null })),
    } as never,
    { get: () => ({ recognitionKey: (c: string) => ({ codeType: 'tac', code: c.slice(0, 8) }) }) } as never,
    { describeIdentifierConflict: jest.fn(async () => NO_MATCH) } as never,
  );
}

describe('scanner hint codes', () => {
  it('an unknown IMEI', async () => {
    const r = await scanner().scan('991000001234567');
    expect(r.hintCode).toBe('unknown_imei');
    expect(r.suggestion).toBeNull();
  });

  it('a device whose TAC is known but not in this catalog', async () => {
    expect((await scanner({ tacKnown: true }).scan('991000001234567')).hintCode).toBe('recognized_device');
  });

  it('a new barcode', async () => {
    expect((await scanner().scan('6001234500009')).hintCode).toBe('new_barcode');
  });

  it('a serial number', async () => {
    expect((await scanner().scan('SN-ABC-12345')).hintCode).toBe('serial_manual');
  });

  it('never leaves a hint without a code', async () => {
    for (const code of ['991000001234567', '6001234500009', 'SN-ABC-12345', '!!']) {
      const r = await scanner().scan(code);
      if (r.hint) expect(r.hintCode).toBeDefined();
    }
  });
});
