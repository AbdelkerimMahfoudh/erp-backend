import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CodeType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
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

  /*
   * First release: no supplier, no amount paid, no due date.
   *
   * An ordinary purchase is anonymous and settled in full when it is received.
   * The server sets the amount paid to the purchase total; the client only says
   * HOW it was paid. `supplierId`, `paidAmount` and `dueDate` are no longer
   * properties of this contract, so the global `forbidNonWhitelisted` pipe
   * refuses any request that still sends them — a partial or unpaid ordinary
   * purchase cannot be expressed at all. Buying on credit from another store
   * belongs to Partners (loans and consignments), not here.
   */

  /** Where the money for this purchase came from. */
  @ApiProperty({ enum: ['cash', 'card', 'mobile', 'bank', 'other'] })
  @IsIn(['cash', 'card', 'mobile', 'bank', 'other'])
  paymentMethod!: 'cash' | 'card' | 'mobile' | 'bank' | 'other';

  /** Required for every non-cash method, refused for cash. Must be active. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  receivingAccountId?: string;

  /** A transaction reference or private note, when there is one. */
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  referenceNo?: string;

  @ApiProperty({ type: [ReceiveItemDto], description: 'Staged receiving items (client Receiving Session → one atomic commit)' })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveItemDto)
  items: ReceiveItemDto[];
}
