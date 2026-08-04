import { BadRequestException } from '@nestjs/common';
import { ProductAttributesService } from './product-attributes.service';
import { AttributeDef } from './attribute-def';

describe('ProductAttributesService', () => {
  const svc = new ProductAttributesService();

  const tvSchema: AttributeDef[] = [
    { key: 'screen_size', label: 'Screen size', type: 'measurement', unit: 'in', required: true, min: 10, max: 120 },
    { key: 'resolution', label: 'Resolution', type: 'enum', options: ['HD', 'FHD', '4K', '8K'] },
    { key: 'refresh_rate', label: 'Refresh rate', type: 'measurement', unit: 'Hz' },
    { key: 'brand_note', label: 'Note', type: 'text' },
  ];

  describe('validateValues', () => {
    it('accepts a valid spec set', () => {
      const { errors, extras } = svc.validateValues(tvSchema, {
        screen_size: 55,
        resolution: '4K',
        brand_note: 'Crystal UHD',
      });
      expect(errors).toEqual([]);
      expect(extras).toEqual([]);
    });

    it('is STRICT on missing required fields', () => {
      expect(() => svc.validateValues(tvSchema, { resolution: '4K' })).toThrow(BadRequestException);
    });

    it('is STRICT on wrong data types', () => {
      expect(() => svc.validateValues(tvSchema, { screen_size: 'big' })).toThrow(BadRequestException);
    });

    it('is STRICT on out-of-range measurements and bad enum options', () => {
      expect(() => svc.validateValues(tvSchema, { screen_size: 5 })).toThrow(BadRequestException);
      expect(() => svc.validateValues(tvSchema, { screen_size: 55, resolution: '2K' })).toThrow(BadRequestException);
    });

    it('does NOT block unknown attributes — reports them as extras', () => {
      const { extras } = svc.validateValues(tvSchema, {
        screen_size: 55,
        ai_processor: 'NQ4 AI Gen3', // brand-new spec, schema not updated yet
      });
      expect(extras).toEqual(['ai_processor']);
    });

    it('treats empty/absent optional fields as OK', () => {
      const { errors } = svc.validateValues(tvSchema, { screen_size: 55, resolution: '' });
      expect(errors).toEqual([]);
    });
  });

  describe('validateSchema', () => {
    it('accepts a well-formed schema', () => {
      expect(svc.validateSchema(tvSchema)).toHaveLength(4);
    });

    it('rejects enum without options', () => {
      expect(() => svc.validateSchema([{ key: 'r', label: 'R', type: 'enum' }])).toThrow(BadRequestException);
    });

    it('rejects duplicate keys and bad types', () => {
      expect(() =>
        svc.validateSchema([
          { key: 'a', label: 'A', type: 'text' },
          { key: 'a', label: 'A2', type: 'text' },
        ]),
      ).toThrow(BadRequestException);
      expect(() => svc.validateSchema([{ key: 'a', label: 'A', type: 'bogus' as never }])).toThrow(BadRequestException);
    });

    it('rejects min greater than max', () => {
      expect(() =>
        svc.validateSchema([{ key: 'n', label: 'N', type: 'number', min: 10, max: 1 }]),
      ).toThrow(BadRequestException);
    });

    it('treats null schema as empty', () => {
      expect(svc.validateSchema(null)).toEqual([]);
    });
  });
});
