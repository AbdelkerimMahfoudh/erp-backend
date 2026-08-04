import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * A sale line is EITHER a serialized unit (scan its `identifier` — IMEI or
 * serial) OR a quantity product (`productId` + `quantity`). The client learns
 * which from POST /scan; it never picks the tracking mode.
 */
export class SaleLineDto {
  @ApiPropertyOptional({ description: 'Serialized unit identifier (IMEI or serial)', example: '123456789012347' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  identifier?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Overrides the default price' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discount?: number;
}

export class PaymentInputDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;
}

export class CreateSaleDto {
  @ApiProperty({ type: [SaleLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines: SaleLineDto[];

  @ApiProperty({ type: [PaymentInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  payments: PaymentInputDto[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ minimum: 0, description: 'Whole-sale discount' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  saleDiscount?: number;

  @ApiPropertyOptional({ maxLength: 255, description: 'Required for below-cost / over-limit overrides' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  overrideReason?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Offline idempotency key' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;
}
