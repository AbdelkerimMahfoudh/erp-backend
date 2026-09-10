import { readFileSync } from 'node:fs';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  isMoney,
  MONEY_MAX,
  MONEY_MAX_STRING,
  MONEY_MIN_STRING,
  MONEY_SCALE,
  parseMoney,
} from './money';
import { IsMoney } from './is-money.decorator';
import { CreateSaleDto } from '../../sales/dto/create-sale.dto';

/**
 * The monetary boundary.
 *
 * Every money column is `DECIMAL(14,2)`. Before this, that fact lived in one
 * DTO and nowhere else, so a sale line priced 1e15 passed validation and
 * reached MySQL — where the column either overflows or truncates.
 *
 * **A database overflow is not a validation mechanism.** It reports the wrong
 * thing, at the wrong layer, in the wrong language, inside a transaction that
 * has already begun.
 */

describe('the boundary matches the column exactly', () => {
  it('is DECIMAL(14,2)', () => {
    expect(MONEY_MAX_STRING).toBe('999999999999.99');
    expect(MONEY_SCALE).toBe(2);
  });

  it('agrees with every money column in the schema', () => {
    /*
     * If a migration ever widens or narrows a money column, this fails rather
     * than letting the guard and the database drift apart silently.
     *
     * One decimal column is deliberately NOT money: `Product.taxRate` is
     * `DECIMAL(6,4)` because a rate is a fraction, not an amount. It is named
     * here rather than excluded by a pattern, so adding a second non-money
     * decimal is a decision somebody has to make on purpose.
     */
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const lines = schema.split('\n').filter((l) => /@db\.Decimal\(/.test(l));
    expect(lines.length).toBeGreaterThan(100);

    const notMoney: string[] = [];
    for (const line of lines) {
      const [, precision, scale] = line.match(/@db\.Decimal\((\d+),\s*(\d+)\)/)!;
      if (`${precision},${scale}` !== '14,2') notMoney.push(line.trim());
    }

    expect(notMoney).toHaveLength(1);
    expect(notMoney[0]).toContain('taxRate');
    expect(notMoney[0]).toContain('Decimal(6, 4)');
  });
});

describe('accepting money', () => {
  it.each([
    ['the exact maximum', MONEY_MAX_STRING],
    ['the exact minimum', MONEY_MIN_STRING],
    ['zero', '0'],
    ['two decimals', '17000.55'],
    ['one decimal', '17000.5'],
    ['no decimals', '17000'],
    ['a negative amount', '-450.25'],
  ])('accepts %s', (_label, value) => {
    expect(parseMoney(value).ok).toBe(true);
  });

  it('accepts the maximum as a JSON number too', () => {
    expect(parseMoney(MONEY_MAX).ok).toBe(true);
  });

  it('keeps the value exactly, without floating point', () => {
    // `0.1 + 0.2` is the standard demonstration. The parse must not go near it.
    const r = parseMoney('999999999999.99');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decimal.toString()).toBe('999999999999.99');
  });
});

describe('refusing what the column cannot hold', () => {
  it('refuses one cent above the maximum', () => {
    // The case a float check gets wrong: 999999999999.99 * 100 is not an
    // integer in IEEE 754, so a naive scale check misjudges the edge.
    const r = parseMoney('1000000000000.00');
    expect(r).toEqual({ ok: false, reason: 'above_maximum' });
  });

  it('refuses one cent below the minimum', () => {
    expect(parseMoney('-1000000000000.00')).toEqual({ ok: false, reason: 'below_minimum' });
  });

  it.each(['17000.555', '0.001', '1.999'])('refuses excessive scale: %p', (value) => {
    expect(parseMoney(value)).toEqual({ ok: false, reason: 'too_many_decimals' });
  });

  it.each(['1e5', '1E5', '1.5e10', '-2e3'])('refuses exponent notation in a string: %p', (value) => {
    /*
     * In a spreadsheet cell "1e5" is far more likely to be a mangled export
     * than a deliberate 100 000, and accepting it silently is how a column of
     * prices becomes wrong in a way nobody can see.
     */
    expect(parseMoney(value)).toEqual({ ok: false, reason: 'exponent_notation' });
  });

  it('treats a huge JSON number as too large, not as bad spelling', () => {
    // `String(1e21)` is "1e+21". It is not a notation problem; it is a number
    // that does not fit, and saying so is the useful answer.
    expect(parseMoney(1e21)).toEqual({ ok: false, reason: 'above_maximum' });
    expect(parseMoney(Number.MAX_SAFE_INTEGER)).toEqual({ ok: false, reason: 'above_maximum' });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses the non-finite number %p',
    (value) => {
      expect(parseMoney(value).ok).toBe(false);
    },
  );

  it.each(['', '   ', 'abc', '17 000', '1,700', '17000.', '.5', '--5', '17000₣', null, undefined, {}, []])(
    'refuses the non-numeric input %p',
    (value) => {
      expect(parseMoney(value as unknown).ok).toBe(false);
    },
  );

  it('refuses whitespace-padded input only when it is not a plain number', () => {
    // Padding is trimmed; an inner space is not a number.
    expect(parseMoney('  17000.50  ').ok).toBe(true);
    expect(parseMoney('17 000.50').ok).toBe(false);
  });
});

describe('the messages name no database', () => {
  it.each(['1000000000000.00', '17000.555', '1e5', 'abc'])('for %p', (value) => {
    const r = parseMoney(value);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const { MONEY_MESSAGE } = require('./money');
    const message = MONEY_MESSAGE[r.reason];
    for (const leak of ['DECIMAL', 'decimal(', 'MySQL', 'column', 'Prisma']) {
      expect(message).not.toContain(leak);
    }
  });
});

describe('the decorator, on a real DTO', () => {
  class Fixture {
    @IsMoney({ min: 0 })
    price!: unknown;
  }

  const check = (price: unknown) =>
    validateSync(plainToInstance(Fixture, { price })).length === 0;

  it('accepts the maximum and refuses a cent more', () => {
    expect(check(MONEY_MAX)).toBe(true);
    expect(check(1_000_000_000_000)).toBe(false);
  });

  it('enforces the per-field minimum, which stays a business decision', () => {
    expect(check(0)).toBe(true);
    expect(check(-1)).toBe(false);
  });

  it('refuses three decimal places', () => {
    expect(check(17_000.555)).toBe(false);
  });
});

describe('the sale DTO, which had no ceiling at all before', () => {
  const sale = (price: number) =>
    validateSync(
      plainToInstance(CreateSaleDto, {
        lines: [{ unitId: '00000000-0000-7000-8000-000000000001', price }],
        payments: [{ method: 'cash', amount: 1 }],
      }),
      { whitelist: true },
    );

  it('now refuses a line price the column cannot hold', () => {
    const errors = sale(1e15);
    expect(JSON.stringify(errors)).toContain('isMoney');
  });

  it('still accepts an ordinary price', () => {
    const errors = sale(17_000);
    expect(JSON.stringify(errors)).not.toContain('isMoney');
  });
});

describe('CSV import reports the row instead of overflowing later', () => {
  it('every money field in the importer is bounded', () => {
    const source = readFileSync('src/imports/row-validation.ts', 'utf8');
    expect(source).toMatch(/isMoney\(cost\)/);
    expect(source).toMatch(/isMoney\(price\)/);
    expect(source).toMatch(/TOO_LARGE/);
  });

  it('the row message says what to do, not what the column is', () => {
    const source = readFileSync('src/imports/row-validation.ts', 'utf8');
    const line = source.split('\n').find((l) => l.includes('const TOO_LARGE'));
    expect(line).toBeDefined();
    expect(line).not.toContain('DECIMAL');
  });
});

describe('every money DTO shares the one boundary', () => {
  it('no money field is left without it', () => {
    /*
     * The shape of a money field in this codebase is a 2-decimal number. Any
     * such field without `@IsMoney` is one that can still reach MySQL out of
     * range — which is the whole defect this closes.
     */
    const { execSync } = require('node:child_process');
    const files = execSync('git ls-files "src/**/dto/*.ts"', { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

    const unbounded: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/@IsNumber\(\{\s*maxDecimalPlaces:\s*2\s*\}\)/.test(line)) return;
        const window = lines.slice(i, i + 4).join('\n');
        if (!window.includes('@IsMoney') && !window.includes('@Max(MONEY')) {
          unbounded.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(unbounded).toEqual([]);
  });

  it('bounds a meaningful number of fields', () => {
    const { execSync } = require('node:child_process');
    const count = execSync('git grep -c "@IsMoney(" -- "src/**/dto/*.ts" || true', {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .reduce((sum: number, line: string) => sum + Number(line.split(":").pop()), 0);
    expect(count).toBeGreaterThanOrEqual(25);
  });
});

describe('isMoney is the same answer as parseMoney', () => {
  it.each(['17000', '1e5', MONEY_MAX_STRING, '1000000000000'])('for %p', (v) => {
    expect(isMoney(v)).toBe(parseMoney(v).ok);
  });
});
