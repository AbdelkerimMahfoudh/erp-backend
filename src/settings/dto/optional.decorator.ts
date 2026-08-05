import { ValidateIf } from 'class-validator';

/**
 * "Optional" meaning absent — not `null`.
 *
 * `@IsOptional()` skips validation for `undefined` **and** `null`, so
 * `{"autoLockMaxSeconds": null}` would pass every rule and then be written to a
 * NOT NULL column: a 500 for what is plainly a bad request. Here `null` is
 * validated like any other value, and fails.
 */
export const Optional = () => ValidateIf((_object, value) => value !== undefined);
