/**
 * Adaptive attribute schema — a category defines an ordered list of these, and a
 * product's `specifications` JSON is validated against them.
 *
 * Supports text / numbers / options(enum) / measurements so any electronics
 * category works without a DB change:
 *   TV            → screen_size (measurement,in), resolution (enum), refresh_rate (measurement,Hz)
 *   Power station → capacity_wh (measurement,Wh), output_w (measurement,W), charging_ports (number)
 *   Laptop        → cpu (text), ram (measurement,GB), storage (measurement,GB), gpu (text)
 */
export type AttributeType = 'text' | 'number' | 'enum' | 'measurement';

export interface AttributeDef {
  /** Machine key stored in product.specifications, e.g. "screen_size". */
  key: string;
  /** Human label for the form field, e.g. "Screen size". */
  label: string;
  type: AttributeType;
  required?: boolean;
  /** measurement/number: unit shown next to the value, e.g. "in", "Wh", "GB". */
  unit?: string;
  /** enum: the allowed options. */
  options?: string[];
  /** number/measurement: inclusive bounds. */
  min?: number;
  max?: number;
}

/** Outcome of validating a product's specifications against a category schema. */
export interface AttributeValidationResult {
  /** Hard failures (required missing / wrong type / out of range / bad option). */
  errors: { key: string; message: string }[];
  /**
   * Keys present on the product but NOT declared by the category schema. These
   * are ALLOWED (saved as-is) — electronics evolves faster than schemas — but
   * surfaced so they can be reviewed and later promoted into the schema.
   */
  extras: string[];
}
