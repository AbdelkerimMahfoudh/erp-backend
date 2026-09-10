import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TrackingType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';

export class CreateProductDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MaxLength(80)
  brand: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  model: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  variant?: string;

  @ApiPropertyOptional({
    enum: TrackingType,
    description: 'How units are tracked. Defaults to the category default, else imei.',
  })
  @IsOptional()
  @IsEnum(TrackingType)
  trackingType?: TrackingType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Category-defined attribute values (e.g. { storage: 256, color: "black" })' })
  @IsOptional()
  @IsObject()
  specifications?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  defaultCost?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  defaultPrice?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  reorderThreshold?: number;
}
