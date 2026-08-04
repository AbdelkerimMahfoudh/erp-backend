import { isValidImei, luhnValid, tacOf } from './imei.util';

describe('imei.util', () => {
  it('accepts a Luhn-valid 15-digit IMEI', () => {
    expect(isValidImei('123456789012347')).toBe(true); // Luhn check digit = 7
  });

  it('rejects wrong length or bad checksum or non-digits', () => {
    expect(isValidImei('12345')).toBe(false);
    expect(isValidImei('123456789012340')).toBe(false); // bad check digit
    expect(isValidImei('12345678901234x')).toBe(false);
  });

  it('extracts the 8-digit TAC', () => {
    expect(tacOf('123456789012347')).toBe('12345678');
  });

  it('luhnValid basic sanity', () => {
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('79927398710')).toBe(false);
  });
});
