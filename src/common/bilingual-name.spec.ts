import { plainToInstance } from 'class-transformer';
import { IsOptional, validateSync } from 'class-validator';
import {
  IsArabicName,
  IsLatinName,
  IsLatinNameOrLegacy,
  NormalizeName,
  arabicNameProblem,
  bilingual,
  latinNameProblem,
  localizedName,
  nameSearch,
  normalizeName,
} from './bilingual-name';

/**
 * Bilingual names (D225): the rules catch the obvious mistake and never a real shop's name.
 */

describe('the Latin-alphabet name', () => {
  it.each(['PS5 Center', 'Samsung-Store 2', 'Électro Kiffa', 'Ahmed Ould Mohamed', "O'Neil & Sons", '24/7 Phones', 'Boutique N°1'])(
    'accepts "%s"',
    (name) => expect(latinNameProblem(name)).toBeNull(),
  );

  it('refuses Arabic letters: the name went in the wrong field', () => {
    expect(latinNameProblem('متجر الأمل')).toBe('name_latin_has_arabic');
    expect(latinNameProblem('PS5 مركز')).toBe('name_latin_has_arabic');
  });

  it('refuses a blank, an overlong name and a name with no letter or digit', () => {
    expect(latinNameProblem('   ')).toBe('name_blank');
    expect(latinNameProblem('x'.repeat(161))).toBe('name_too_long');
    expect(latinNameProblem('---')).toBe('name_latin_needs_letter');
  });

  it('refuses control and text-direction characters, which make a name read differently from how it is stored', () => {
    expect(latinNameProblem('Shop‮evil')).toBe('name_forbidden_character');
    expect(latinNameProblem('Shop⁦x')).toBe('name_forbidden_character');
    expect(latinNameProblem('Shop\u0007')).toBe('name_forbidden_character');
  });
});

describe('the Arabic name', () => {
  it.each(['متجر الأمل', 'مركز PS5', 'سامسونج - الفرع ٢', 'محمد ولد أحمد', 'دكان 24/7'])('accepts "%s"', (name) =>
    expect(arabicNameProblem(name)).toBeNull(),
  );

  it('refuses a name without a single Arabic letter: the same mistake the other way round', () => {
    expect(arabicNameProblem('PS5 Center')).toBe('name_ar_needs_arabic');
    expect(arabicNameProblem('١٢٣')).toBe('name_ar_needs_arabic');
  });

  it('refuses a direction override in Arabic too', () => {
    expect(arabicNameProblem('متجر‭الأمل')).toBe('name_forbidden_character');
  });
});

describe('what is stored', () => {
  it('is trimmed, with one space between words', () => {
    expect(normalizeName('  PS5   Center \n')).toBe('PS5 Center');
  });

  it('validates the normalized value through the decorators', () => {
    class Dto {
      @NormalizeName()
      @IsLatinName()
      name!: string;

      @NormalizeName()
      @IsArabicName()
      nameAr!: string;
    }
    const ok = plainToInstance(Dto, { name: '  PS5  Center ', nameAr: ' مركز  PS5 ' });
    expect(validateSync(ok)).toEqual([]);
    expect(ok).toMatchObject({ name: 'PS5 Center', nameAr: 'مركز PS5' });

    const swapped = plainToInstance(Dto, { name: 'مركز', nameAr: 'Center' });
    const errors = validateSync(swapped).map((e) => Object.values(e.constraints ?? {})[0]);
    expect(errors).toEqual([
      'The Latin-alphabet name contains Arabic letters. Put the Arabic name in the Arabic field.',
      'The Arabic name needs at least one Arabic letter',
    ]);
  });
});

describe('what is shown', () => {
  it('shows the Arabic name in Arabic, and the Latin name in French and English', () => {
    const shop = { name: 'PS5 Center', nameAr: 'مركز PS5' };
    expect(localizedName(shop, 'ar')).toBe('مركز PS5');
    expect(localizedName(shop, 'fr')).toBe('PS5 Center');
    expect(localizedName(shop, 'en')).toBe('PS5 Center');
  });

  it('falls back to the existing name until an Arabic one is given, and says it is incomplete', () => {
    const legacy = { name: 'Boutique Kiffa', nameAr: null };
    expect(localizedName(legacy, 'ar')).toBe('Boutique Kiffa');
    expect(bilingual(legacy)).toEqual({ name: 'Boutique Kiffa', nameAr: null, nameIncomplete: true });
    expect(bilingual({ name: 'A', nameAr: 'أ' }).nameIncomplete).toBe(false);
  });

  it('searches both names', () => {
    expect(nameSearch('  مركز ')).toEqual({ OR: [{ name: { contains: 'مركز' } }, { nameAr: { contains: 'مركز' } }] });
  });
});

describe('a route the released app also calls', () => {
  class Legacy {
    @NormalizeName()
    @IsLatinNameOrLegacy('nameAr')
    name!: string;

    @IsOptional()
    @NormalizeName()
    @IsArabicName()
    nameAr?: string;
  }
  const errors = (body: object) => validateSync(plainToInstance(Legacy, body)).map((e) => e.property);

  it('keeps accepting the one name build 1.0.0 (1) sends, in whichever script it was typed', () => {
    expect(errors({ name: 'متجر الأمل' })).toEqual([]);
    expect(errors({ name: 'PS5 Center' })).toEqual([]);
  });

  it('still refuses a blank name or a direction override from it', () => {
    expect(errors({ name: '  ' })).toEqual(['name']);
    expect(errors({ name: 'Shop‮evil' })).toEqual(['name']);
  });

  it('holds a request that sends both names to both rules', () => {
    expect(errors({ name: 'PS5 Center', nameAr: 'مركز PS5' })).toEqual([]);
    expect(errors({ name: 'متجر الأمل', nameAr: 'متجر الأمل' })).toEqual(['name']);
  });
});
