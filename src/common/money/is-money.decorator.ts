import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { MONEY_MAX, MONEY_MAX_STRING, MONEY_MESSAGE, parseMoney } from './money';

/**
 * One decorator for every monetary input.
 *
 * Replaces the scattered `@IsNumber({maxDecimalPlaces:2}) @Min(x)` pairs, which
 * were consistent about the minimum and silent about the maximum everywhere
 * except one file. The *minimum* stays per-field, because it is a business
 * question — a payment must be at least 0.01, a discount may be 0, a correction
 * may be negative — but the *ceiling* is a property of the column and is the
 * same everywhere.
 */

@ValidatorConstraint({ name: 'isMoney', async: false })
class IsMoneyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const result = parseMoney(value);
    if (!result.ok) return false;

    const { min } = (args.constraints[0] ?? {}) as MoneyOptions;
    if (min !== undefined && result.decimal.lessThan(min)) return false;
    return true;
  }

  /**
   * Say the specific thing that is wrong.
   *
   * "amount must be a valid amount" tells a shopkeeper nothing. "amount may
   * have at most 2 decimal places" tells them what to change.
   */
  defaultMessage(args: ValidationArguments): string {
    const result = parseMoney(args.value);
    if (!result.ok) return `${args.property} ${MONEY_MESSAGE[result.reason]}`;

    const { min } = (args.constraints[0] ?? {}) as MoneyOptions;
    return `${args.property} may not be less than ${min}`;
  }
}

export interface MoneyOptions {
  /** The business floor for THIS field. Omit when any in-range value is legal. */
  min?: number;
}

/** The validation half, usable on its own where Swagger metadata is separate. */
export function IsMoney(options: MoneyOptions = {}, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isMoney',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [options],
      options: validationOptions,
      validator: IsMoneyConstraint,
    });
  };
}

/**
 * A required monetary field: validated, and documented with the real bound so
 * the API reference and the runtime cannot drift apart.
 */
export function MoneyField(options: MoneyOptions & { description?: string } = {}) {
  return applyDecorators(
    ApiProperty({
      type: Number,
      minimum: options.min ?? undefined,
      maximum: MONEY_MAX,
      description: options.description,
      example: 17000,
    }),
    IsMoney(options),
  );
}

/** The optional counterpart. `@IsOptional()` is still the caller's to add. */
export function OptionalMoneyField(options: MoneyOptions & { description?: string } = {}) {
  return applyDecorators(
    ApiPropertyOptional({
      type: Number,
      minimum: options.min ?? undefined,
      maximum: MONEY_MAX,
      description: options.description,
      example: 17000,
    }),
    IsMoney(options),
  );
}

export { MONEY_MAX, MONEY_MAX_STRING };
