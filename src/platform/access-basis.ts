import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumberString, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

/**
 * Why an administrator-created business has access (D227, the owner's option A): a payment actually received, or a
 * no-payment grant. Required, and checked before anything is created. Never a silent trial or free access.
 */
export class AccessBasisDto {
  @IsIn(['payment', 'grant']) kind: 'payment' | 'grant';

  /** A string, so no float ever rounds somebody's money on the way in. */
  @ValidateIf((o: AccessBasisDto) => o.kind === 'payment') @IsNumberString() amount?: string;
  @ValidateIf((o: AccessBasisDto) => o.kind === 'payment') @IsString() @MaxLength(40) paidAt?: string;
  @ValidateIf((o: AccessBasisDto) => o.kind === 'payment') @IsString() @MinLength(3) @MaxLength(120) reference?: string;
  @IsOptional() @IsIn(['manual', 'bank_transfer', 'mobile_money']) channel?: 'manual' | 'bank_transfer' | 'mobile_money';
  /** The period the payment covers. */
  @ValidateIf((o: AccessBasisDto) => o.kind === 'payment') @Type(() => Number) @IsInt() @Min(1) @Max(60) months?: number;

  /** Required for a business (`parseBasis`). A store's grant runs until renewal, so it names no days. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) days?: number;
  @ValidateIf((o: AccessBasisDto) => o.kind === 'grant') @IsString() @MinLength(3) @MaxLength(255) reason?: string;
}

export type ParsedBasis =
  | { kind: 'payment'; amount: string; paidAt: Date; reference: string; channel?: AccessBasisDto['channel']; months: number }
  | { kind: 'grant'; days?: number; reason: string };

/** Everything refusable, before anything is written. A test business is never paid for (D217). */
export function parseBasis(basis: AccessBasisDto | undefined, isTest: boolean, now: Date, scope: { store?: boolean } = {}): ParsedBasis {
  if (!basis) throw new BadRequestException({ code: 'access_basis_required', message: 'Say why this business has access: a payment received, or a no-payment grant.' });
  if (basis.kind === 'grant') {
    if (!scope.store && !basis.days) throw new BadRequestException({ code: 'grant_days_required', message: 'Say how many days the grant lasts.' });
    return { kind: 'grant', days: basis.days, reason: basis.reason!.trim() };
  }
  if (isTest) throw new BadRequestException({ code: 'test_business_no_payment', message: 'A test business is never paid for. Use a no-payment grant.' });
  const amount = Number(basis.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException({ code: 'amount_invalid', message: 'Enter the amount that was actually paid.' });
  const paidAt = new Date(basis.paidAt ?? '');
  if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new BadRequestException({ code: 'paid_at_invalid', message: 'The payment date cannot be in the future.' });
  }
  return { kind: 'payment', amount: basis.amount!, paidAt, reference: basis.reference!.trim(), channel: basis.channel, months: basis.months! };
}
