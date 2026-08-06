import { ApiPropertyOptional } from '@nestjs/swagger';
import { TrackingType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** `?active=` — three states, because "either" is a real, useful choice. */
export type ActiveFilter = 'active' | 'inactive' | 'all';

export class ListProductsDto {
  @ApiPropertyOptional({ description: 'Free text over brand, model, variant, barcode and specifications.' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: TrackingType })
  @IsOptional()
  @IsEnum(TrackingType)
  trackingType?: TrackingType;

  @ApiPropertyOptional({
    enum: ['active', 'inactive', 'all'],
    default: 'active',
    description: 'Archived products are `inactive`. Default hides them, matching the receiving selectors.',
  })
  @IsOptional()
  @IsIn(['active', 'inactive', 'all'])
  active?: ActiveFilter;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 30 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
