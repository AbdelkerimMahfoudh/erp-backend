import { classifyCode } from './code-classifier';

describe('classifyCode', () => {
  it('classifies a Luhn-valid 15-digit code as imei (tolerating spaces/dashes)', () => {
    expect(classifyCode('123456789012347')).toEqual({ kind: 'imei', normalized: '123456789012347' });
    expect(classifyCode('12-3456 789012347')).toEqual({ kind: 'imei', normalized: '123456789012347' });
  });

  it('classifies 8..14 digit codes as barcodes (EAN/UPC)', () => {
    expect(classifyCode('6001234567890').kind).toBe('barcode'); // EAN-13
    expect(classifyCode('036000291452').kind).toBe('barcode'); // UPC-A
    expect(classifyCode('96385074').kind).toBe('barcode'); // EAN-8
  });

  it('classifies alphanumerics as serials and uppercases them', () => {
    expect(classifyCode('sn-abc123')).toEqual({ kind: 'serial', normalized: 'SN-ABC123' });
  });

  it('classifies empty/garbage as unknown', () => {
    expect(classifyCode('').kind).toBe('unknown');
    expect(classifyCode('   ').kind).toBe('unknown');
    expect(classifyCode('!!').kind).toBe('unknown');
  });

  it('does not treat a 15-digit non-Luhn as imei', () => {
    expect(classifyCode('123456789012340').kind).not.toBe('imei');
  });
});
