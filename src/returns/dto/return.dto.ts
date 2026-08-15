import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * The return workflow's request shapes.
 *
 * Nothing here accepts money the server can compute, an eligibility the server
 * decides, or a deadline the server owns. What the client may say is what only
 * a person at the counter knows: which phone, what is wrong with it, whether it
 * is physically here, and why a charge is being withheld.
 */

export class CreateReturnRequestDto {
  /** The sale line being returned. Serialized phones only in I2. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  saleItemId: string;

  /**
   * The identifier read off the PHONE ITSELF — scanned, or typed as a fallback.
   * The server checks it resolves to the exact unit on that sale line, so a
   * request cannot be raised against a phone nobody looked at.
   */
  @ApiProperty({ example: '353285110000015', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  identifier: string;

  @ApiProperty({ maxLength: 255, description: 'What the customer says is wrong' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  requestReason: string;

  @ApiPropertyOptional({ description: 'Condition of the phone as received or described' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  conditionNotes?: string;

  /**
   * Whether the phone is physically here. `store_holds` performs the custody
   * intake in the same transaction as the request, because at a counter those
   * are one action.
   */
  @ApiProperty({ enum: ['customer_holds', 'store_holds'] })
  @IsEnum({ customer_holds: 'customer_holds', store_holds: 'store_holds' })
  custody: 'customer_holds' | 'store_holds';

  /** Mandatory. An offline retry must not create a second claim. */
  @ApiProperty({ format: 'uuid', description: 'Idempotency key' })
  @IsUUID()
  clientUuid: string;
}

export class ReceiveCustodyDto {
  /**
   * Re-read from the phone at intake. Confirming the identifier again is the
   * point of this endpoint: it is what proves the device in the drawer is the
   * device on the sale line.
   */
  @ApiProperty({ example: '353285110000015', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  identifier: string;

  @ApiProperty({ description: 'The version last seen, so a stale write is refused' })
  @IsInt()
  @Min(0)
  expectedVersion: number;
}

export class InvestigateDto {
  @ApiPropertyOptional({ enum: ['pending_investigation', 'store_or_product_fault', 'customer_damage', 'other'] })
  @IsOptional()
  @IsEnum({
    pending_investigation: 'pending_investigation',
    store_or_product_fault: 'store_or_product_fault',
    customer_damage: 'customer_damage',
    other: 'other',
  })
  responsibility?: 'pending_investigation' | 'store_or_product_fault' | 'customer_damage' | 'other';

  /** Mandatory when responsibility is `other` — "other" explains nothing alone. */
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  responsibilityNotes?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  conditionNotes?: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion: number;
}

export class AdjustmentDto {
  @ApiProperty({ enum: ['screen_protector', 'accessory_retained', 'restocking_fee', 'other'] })
  @IsEnum({
    screen_protector: 'screen_protector',
    accessory_retained: 'accessory_retained',
    restocking_fee: 'restocking_fee',
    other: 'other',
  })
  kind: 'screen_protector' | 'accessory_retained' | 'restocking_fee' | 'other';

  @ApiProperty({ maxLength: 160, description: 'What is being withheld, in words a customer can be told' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  label: string;

  @ApiProperty({ minimum: 1, default: 1 })
  @IsInt()
  @Min(1)
  @Max(9999)
  quantity: number;

  /** Per-unit. The server multiplies and sums; the client never sends a total. */
  @ApiProperty({ minimum: 0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitAmount: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion: number;
}

export class ListReturnsDto {
  /** Comma-separated lifecycle states. */
  @ApiPropertyOptional({ example: 'pending_investigation,under_review' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  status?: string;

  @ApiPropertyOptional({ example: 'customer_damage' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  responsibility?: string;

  /** `eligible` / `ineligible`, from the snapshot taken when the request was raised. */
  @ApiPropertyOptional({ enum: ['eligible', 'ineligible'] })
  @IsOptional()
  @IsEnum({ eligible: 'eligible', ineligible: 'ineligible' })
  eligibility?: 'eligible' | 'ineligible';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  requestedBy?: string;

  @ApiPropertyOptional({ example: '2026-08-14', description: 'A bare date means the whole day' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-14' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  /** Invoice, IMEI, serial, product or who raised it. Matched in SQL. */
  @ApiPropertyOptional({ example: '353285110000015' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;

  /**
   * A query parameter arrives as a STRING and the global pipe runs with
   * `enableImplicitConversion: false`, so `@IsInt()` alone would reject every
   * value a client could send — the `?limit=` defect from H1.3.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class ApproveReturnDto {
  @ApiProperty({ description: 'The version last seen. Approve and reject race; one wins.' })
  @IsInt()
  @Min(0)
  expectedVersion: number;

  /**
   * Mandatory when the return is outside the policy the sale was sold under, or
   * when the investigation found the damage was the customer's. Both are Owner
   * decisions, and both are departures from what was promised — so the reason
   * is recorded while somebody still remembers it.
   */
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  exceptionReason?: string;
}

export class RejectReturnDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion: number;

  /** Mandatory. A refusal nobody can explain is the one a customer argues with. */
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
