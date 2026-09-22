import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertLookupIdentifier,
  availabilityOf,
  maskIdentifier,
  normalizeIdentifier,
  variantParts,
} from './sale-selection-rules';

/** Choosing the phone to sell: one set of rules for scan, typed IMEI and the shelf. */

const here = Buffer.from('aa', 'hex');
const there = Buffer.from('bb', 'hex');

describe('normalising what was typed or scanned', () => {
  it('removes only presentation characters', () => {
    expect(normalizeIdentifier(' 35 123-4000.0010/16 ')).toBe('351234000001016');
  });
  it('keeps letters, so a mistyped IMEI is caught and a serial survives', () => {
    expect(normalizeIdentifier('35123400000101O')).toBe('35123400000101O');
    expect(normalizeIdentifier('SN-AB12')).toBe('SNAB12');
  });
});

describe('the lookup gate lets three kinds of code through, and refuses only two things', () => {
  const code = (v: string) => {
    try {
      assertLookupIdentifier(v);
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return ((e as BadRequestException).getResponse() as { code: string }).code;
    }
  };

  it('accepts a real IMEI — 15 digits with a valid checksum', () => {
    expect(code('490154203237518')).toBeNull();
  });
  it('refuses nothing at all', () => {
    expect(code('')).toBe('identifier_missing');
  });
  it('refuses a 15-digit number with a wrong checksum as an INVALID IMEI, not a barcode', () => {
    // The one guess it must never make: a mistyped IMEI is an invalid IMEI.
    expect(code('490154203237519')).toBe('imei_checksum');
  });
  it('lets a serial number through — serial-tracked devices carry one', () => {
    expect(code('C02XK1ABJHD5')).toBeNull();
  });
  it('lets a barcode through — a shorter or longer number may be a product code', () => {
    // 13-digit EAN, 14-digit and other numeric codes are candidates for a
    // product barcode; the lookup decides, this gate does not pre-judge them.
    expect(code('6901234567890')).toBeNull();
    expect(code('49015420323751')).toBeNull();
    expect(code('4901542032375180')).toBeNull();
  });
});

describe('whether the phone can be sold here, now', () => {
  it('in stock at this branch is available', () => {
    expect(availabilityOf('in_stock', here, here)).toBe('available');
  });
  it('sold is sold, wherever it was', () => {
    expect(availabilityOf('sold', there, here)).toBe('sold');
  });
  it('faulty or returned is not for sale', () => {
    expect(availabilityOf('faulty', here, here)).toBe('faulty');
    expect(availabilityOf('returned', here, here)).toBe('faulty');
  });
  it('reserved or in transit is promised elsewhere', () => {
    expect(availabilityOf('reserved', here, here)).toBe('reserved');
    expect(availabilityOf('in_transit', here, here)).toBe('reserved');
  });
  it('in stock at another branch is not sellable here', () => {
    expect(availabilityOf('in_stock', there, here)).toBe('other_branch');
  });
  it('anything else is unavailable', () => {
    expect(availabilityOf('consigned_out', here, here)).toBe('unavailable');
  });
});

describe('storage and colour, never guessed', () => {
  it('reads a receiving-style variant', () => {
    expect(variantParts('128 GB · Midnight', null)).toEqual({ storage: '128 GB', colour: 'Midnight' });
  });
  it('prefers explicit specification fields', () => {
    expect(variantParts('128 GB · Black', { storage: '256 GB', colour: 'Blue' })).toEqual({ storage: '256 GB', colour: 'Blue' });
  });
  it('answers null for what the variant does not say', () => {
    expect(variantParts('Pro Max', null)).toEqual({ storage: null, colour: null });
    expect(variantParts(null, null)).toEqual({ storage: null, colour: null });
    expect(variantParts('64 GB', null)).toEqual({ storage: '64 GB', colour: null });
  });
});

describe('the number is shown, not given away', () => {
  it('masks all but the last four digits', () => {
    expect(maskIdentifier('490154203237518')).toBe('•••• 7518');
    expect(maskIdentifier(null)).toBeNull();
  });
});

// ── the service, by what it reads and what it never does ───────────────────

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const service = code(readFileSync(join(__dirname, 'sale-selection.service.ts'), 'utf8'));

describe('finding a phone to sell only reads', () => {
  it('never creates or changes anything', () => {
    expect(service).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });
  it('finds either IMEI, or the serial, as the same unit', () => {
    expect(service).toMatch(/imeiPrimary: identifier[\s\S]{0,60}imeiSecondary: identifier[\s\S]{0,60}serialNo: identifier/);
  });
  it('quotes the price the sale will charge, and only for a sellable phone', () => {
    expect(service).toContain("availability === 'available' ? (await this.pricing.getUnitPricing(identifier)).price : null");
  });
  it('returns no margin, history, staff or full identifier; cost is left to the gating interceptor', () => {
    // Just the unit return OBJECT — from `return {` to its close — so a query's
    // `where: { branchId }` further down the file is not mistaken for a leak.
    const from = service.indexOf('return {');
    const returned = service.slice(from, service.indexOf('\n    };', from));
    expect(returned).not.toMatch(/margin|timeline|user|imeiPrimary:|imeiSecondary:|serialNo:|branchId:/);
    expect(returned).toContain("otherBranch: disclosure === 'shown'");
    // `cost` is only in the response because the global interceptor strips it
    // for every caller without cost.view.
    const fields = readFileSync(join(__dirname, '..', 'common', 'interceptors', 'financial-fields.ts'), 'utf8');
    expect(fields).toContain("'cost'");
    expect(returned).toContain('identifierMasked');
  });
  it('is scoped to the active branch', () => {
    expect(service).toContain('requireBranchId()');
    expect(service).toContain('availabilityOf(unit.status, unit.branchId, branchId)');
  });
});
