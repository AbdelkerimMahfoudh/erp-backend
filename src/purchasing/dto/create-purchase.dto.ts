import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CodeType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

/** A learning-map key echoed back from a prior POST /scan (teach-on-confirm). */
export class RecognitionKeyDto {
  @ApiProperty({ enum: CodeType })
  @IsEnum(CodeType)
  codeType: CodeType;

  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MaxLength(64)
  code: string;
}

/**
 * One physical serialized unit, with the second IMEI of a dual-SIM phone.
 *
 * `identifiers[]` stays the short form for single-identifier units. A unit
 * listed here is the same unit as one listed there — the two are merged, and
 * a primary appearing in both is a duplicate in the delivery.
 */
export class ReceiveUnitDto {
  @ApiProperty({ description: 'IMEI 1 (imei products) or serial number', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  identifier: string;

  @ApiPropertyOptional({ description: 'IMEI 2 of the SAME phone. IMEI products only; optional.', example: '490154203237518' })
  @IsOptional()
  @Matches(/^\d{15}$/, { message: 'imeiSecondary must be 15 digits' })
  imeiSecondary?: string;
}

/**
 * One receiving line — PRODUCT-FIRST. The product's tracking type decides the
 * workflow; the client never labels a line "phone" or "accessory":
 *   imei/serial → `identifiers[]` and/or `units[]` (one unit per entry)
 *   quantity    → `quantity` (bulk, no identifiers)
 */
export class ReceiveItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId: string;

  @ApiProperty({ minimum: 0.01, description: 'Per-unit (imei/serial) or per-item (quantity) purchase cost' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  unitCost: number;

  @ApiPropertyOptional({ type: [String], description: 'Serialized products: one IMEI/serial per physical unit' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  identifiers?: string[];

  @ApiPropertyOptional({ type: [ReceiveUnitDto], description: 'Serialized products: units carrying an optional IMEI 2' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveUnitDto)
  units?: ReceiveUnitDto[];

  @ApiPropertyOptional({ minimum: 1, description: 'Quantity-tracked products: bulk count' })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Selling price for quantity stock (else product default)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  price?: number;

  @ApiPropertyOptional({ type: RecognitionKeyDto, description: 'Echoed from POST /scan to teach recognition on confirm' })
  @IsOptional()
  @ValidateNested()
  @Type(() => RecognitionKeyDto)
  recognitionKey?: RecognitionKeyDto;
}

export class CreatePurchaseDto {
  /**
   * REQUIRED. Client-generated request identity, created ONCE per receiving session and
   * reused across every retry — including an offline replay. Retrying with the
   * same key returns the original purchase instead of receiving the delivery
   * twice. Same convention as CreateSaleDto.clientUuid.
   */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientUuid!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  supplierId: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  referenceNo?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  paidAmount?: number;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiProperty({ type: [ReceiveItemDto], description: 'Staged receiving items (client Receiving Session → one atomic commit)' })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveItemDto)
  items: ReceiveItemDto[];
}
