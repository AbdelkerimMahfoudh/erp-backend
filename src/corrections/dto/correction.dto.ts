import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

/**
 * Asking for a confirmed payment to be corrected.
 *
 * The request carries no amount and no method. Both are copied from the target
 * at approval, so a compensating movement cannot disagree with the payment it
 * reverses — there is no field here through which a wrong figure could enter.
 */
export class RequestCorrectionDto {
  @ApiProperty({ enum: ['refund_payout', 'supplier_settlement'] })
  @IsEnum(['refund_payout', 'supplier_settlement'])
  targetKind!: 'refund_payout' | 'supplier_settlement';

  @ApiProperty({ description: 'The confirmed refund payout or supplier settlement being corrected.' })
  @IsUUID()
  targetId!: string;

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
