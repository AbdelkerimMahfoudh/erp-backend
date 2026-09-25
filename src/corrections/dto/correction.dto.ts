import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

const KINDS = ['refund_payout', 'supplier_settlement', 'sale_payment', 'sale', 'expense', 'supplier_payment', 'purchase'] as const;
type Kind = (typeof KINDS)[number];
const PLANNED_KINDS = ['sale_payment', 'sale', 'expense', 'supplier_payment', 'purchase'] as const;
type PlannedKind = (typeof PLANNED_KINDS)[number];
const ACTIONS = ['reverse', 'reclassify', 'cancel'] as const;

/**
 * Asking for a confirmed record to be corrected (Milestone B, 0078, 0079).
 *
 * The request never carries the method, the channel a payment was recorded in, a
 * sale's lines or a purchase's goods: all are read from the record itself, so a
 * correction cannot disagree with what it corrects. It carries only what the
 * person knows and the record does not: what was wrong (the action), how much of
 * it (a part of a payment or an expense), where the money really went (a move)
 * and why.
 */
export class RequestCorrectionDto {
  @ApiProperty({ enum: KINDS })
  @IsEnum(KINDS)
  targetKind!: Kind;

  /**
   * `reverse` a payment never received or an expense that was wrong; `reclassify` a
   * payment to its real channel; `cancel` a whole sale or purchase. Optional where a
   * kind has one action; a sale payment naming a destination is a move (0078).
   */
  @ApiPropertyOptional({ enum: ACTIONS })
  @IsOptional()
  @IsIn(ACTIONS)
  action?: (typeof ACTIONS)[number];

  @ApiProperty({ description: 'The confirmed record being corrected.' })
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

  /** A part of a payment or an expense; the whole of it when omitted. Never for a cancellation. */
  @ApiPropertyOptional({ description: 'The part of the payment or expense concerned; the whole when omitted' })
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

/** What a correction would do, before anybody asks for it (0078, 0079). Nothing is written. */
export class PreviewCorrectionDto {
  @ApiProperty({ enum: PLANNED_KINDS })
  @IsEnum(PLANNED_KINDS)
  targetKind!: PlannedKind;

  @ApiPropertyOptional({ enum: ACTIONS })
  @IsOptional()
  @IsIn(ACTIONS)
  action?: (typeof ACTIONS)[number];

  @ApiProperty()
  @IsUUID()
  targetId!: string;

  @ApiPropertyOptional({ enum: ['cash', 'account'] })
  @IsOptional()
  @IsIn(['cash', 'account'])
  toMethod?: 'cash' | 'account';

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
