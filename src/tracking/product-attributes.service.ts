import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AttributeDef,
  AttributeType,
  AttributeValidationResult,
} from './attribute-def';

const ATTRIBUTE_TYPES: AttributeType[] = ['text', 'number', 'enum', 'measurement'];

/**
 * Validates adaptive product attributes against a category's attribute schema,
 * and validates the schema itself when a category is created/edited.
 *
 * Policy (per product-vision refinement): required fields and wrong data types
 * are STRICT (rejected), but UNKNOWN attribute keys are NOT blocked — they are
 * saved as-is and reported as `extras` for review, so a new spec (e.g. a TV's
 * "ai_processor") never stops an employee from adding stock.
 */
@Injectable()
export class ProductAttributesService {
  /** Parse a category's stored `attribute_schema` JSON into typed defs. */
  parseSchema(raw: unknown): AttributeDef[] {
    if (raw == null) return [];
    if (!Array.isArray(raw)) return [];
    return raw as AttributeDef[];
  }

  /**
   * Validate a product's specifications against the category schema.
   * Throws 400 on hard errors; otherwise returns the (non-blocking) extras.
   */
  validateValues(
    schema: AttributeDef[],
    specifications: Record<string, unknown> | undefined,
  ): AttributeValidationResult {
    const specs = specifications ?? {};
    const errors: { key: string; message: string }[] = [];
    const declared = new Set<string>();

    for (const def of schema) {
      declared.add(def.key);
      const value = specs[def.key];
      const empty = value === undefined || value === null || value === '';

      if (empty) {
        if (def.required) errors.push({ key: def.key, message: `${def.label} is required` });
        continue;
      }
      this.checkValue(def, value, errors);
    }

    const extras = Object.keys(specs).filter((k) => !declared.has(k));

    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Invalid product attributes', errors });
    }
    return { errors, extras };
  }

  private checkValue(
    def: AttributeDef,
    value: unknown,
    errors: { key: string; message: string }[],
  ): void {
    switch (def.type) {
      case 'text':
        if (typeof value !== 'string') errors.push({ key: def.key, message: `${def.label} must be text` });
        break;
      case 'enum':
        if (!def.options?.includes(String(value))) {
          errors.push({ key: def.key, message: `${def.label} must be one of: ${(def.options ?? []).join(', ')}` });
        }
        break;
      case 'number':
      case 'measurement': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push({ key: def.key, message: `${def.label} must be a number` });
          break;
        }
        if (def.min != null && value < def.min) errors.push({ key: def.key, message: `${def.label} must be ≥ ${def.min}` });
        if (def.max != null && value > def.max) errors.push({ key: def.key, message: `${def.label} must be ≤ ${def.max}` });
        break;
      }
    }
  }

  /**
   * Validate a category's own attribute schema at create/update time, so a bad
   * definition can never poison later product validation.
   */
  validateSchema(schema: unknown): AttributeDef[] {
    if (schema == null) return [];
    if (!Array.isArray(schema)) {
      throw new BadRequestException('attributeSchema must be an array of attribute definitions');
    }
    const seen = new Set<string>();
    for (const [i, def] of (schema as AttributeDef[]).entries()) {
      const at = `attributeSchema[${i}]`;
      if (!def || typeof def.key !== 'string' || !def.key.trim()) {
        throw new BadRequestException(`${at}.key is required`);
      }
      if (seen.has(def.key)) throw new BadRequestException(`${at}.key "${def.key}" is duplicated`);
      seen.add(def.key);
      if (typeof def.label !== 'string' || !def.label.trim()) {
        throw new BadRequestException(`${at}.label is required`);
      }
      if (!ATTRIBUTE_TYPES.includes(def.type)) {
        throw new BadRequestException(`${at}.type must be one of: ${ATTRIBUTE_TYPES.join(', ')}`);
      }
      if (def.type === 'enum' && (!Array.isArray(def.options) || def.options.length === 0)) {
        throw new BadRequestException(`${at}.options is required for enum attributes`);
      }
      if (def.min != null && def.max != null && def.min > def.max) {
        throw new BadRequestException(`${at}.min cannot exceed max`);
      }
    }
    return schema as AttributeDef[];
  }
}
