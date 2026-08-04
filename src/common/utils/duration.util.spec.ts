import { parseDurationSeconds } from './duration.util';

describe('parseDurationSeconds', () => {
  it.each([
    ['900s', 900],
    ['15m', 900],
    ['1h', 3600],
    ['30d', 2_592_000],
    ['45', 45],
  ])('parses %s -> %i seconds', (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });

  it('throws on invalid input', () => {
    expect(() => parseDurationSeconds('abc')).toThrow();
  });
});
