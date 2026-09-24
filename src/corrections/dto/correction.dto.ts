import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/**
 * Asking for a confirmed payment to be corrected.
 *
 * The request carries no amount and no method. Both are copied from the target
 * at approval, so a compensating movement cannot disagree with the payment it
 * reverses — there is no field here through which a wrong figure could enter.
 */
export class RequestCorrectionDto {
  @ApiProperty({ enum: ['refund_payout', 'supplier_settlement', 'sale_payment'] })
  @IsEnum(['refund_payout', 'supplier_settlement', 'sale_payment'])
  targetKind!: 'refund_payout' | 'supplier_settlement' | 'sale_payment';

  @ApiProperty({ description: 'The confirmed refund payout, supplier settlement or sale payment being corrected.' })
  @IsUUID()
  targetId!: string;

  /**
   * `sale_payment` only (0078): the channel the money really reached. A payout or a
   * settlement correction carries no destination — its movement is the exact
   * opposite of what was paid.
   */
  @ApiPropertyOptional({ enum: ['cash', 'account'], description: 'sale_payment only: where the money really went' })
  @IsOptional()
  @IsIn(['cash', 'account'])
  toMethod?: 'cash' | 'account';

  @ApiPropertyOptional({ format: 'uuid', description: 'sale_payment only: the account the money really reached' })
  @IsOptional()
  @IsUUID()
  toAccountId?: string;

  /** `sale_payment` only: how much of the payment went elsewhere; the whole payment when omitted. */
  @ApiPropertyOptional({ description: 'sale_payment only: the part of the payment that went elsewhere' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsMoney({ min: 0.01 })
  amount?: number;

  @ApiProperty({
    description:
      'Why. Mandatory — a correction to confirmed money with no stated reason is indistinguishable from a mistake months later.',
  })
  @IsString()
  @Length(1, 255)
  reason!: string;

  @ApiPropertyOptional({ description: 'A receipt number, message or anything that supports the claim.' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  supportingReference?: string;

  @ApiProperty({ description: 'Idempotency key. An offline retry must not record two corrections.' })
  @IsUUID()
  clientUuid!: string;
}

/** What a reclassification would do, before anybody asks for it (0078). */
export class PreviewCorrectionDto {
  @ApiProperty({ enum: ['sale_payment'] })
  @IsEnum(['sale_payment'])
  targetKind!: 'sale_payment';

  @ApiProperty()
  @IsUUID()
  targetId!: string;

  @ApiProperty({ enum: ['cash', 'account'] })
  @IsIn(['cash', 'account'])
  toMethod!: 'cash' | 'account';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  toAccountId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsMoney({ min: 0.01 })
  amount?: number;
}

/**
 * Approving or rejecting. `expectedVersion` is what makes two owners deciding
 * the same request produce one winner rather than two decisions.
 */
export class DecideCorrectionDto {
  @ApiProperty({ description: 'The version the caller last read. A stale one is a 409.' })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional({ description: 'Why it was rejected. Ignored on approval.' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  note?: string;
}

export class ListCorrectionsDto {
  @ApiPropertyOptional({ enum: ['requested', 'approved', 'rejected'] })
  @IsOptional()
  @IsEnum(['requested', 'approved', 'rejected'])
  status?: 'requested' | 'approved' | 'rejected';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  // `enableImplicitConversion` is off, so a query param arrives as a string.
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  limit?: number;
}
