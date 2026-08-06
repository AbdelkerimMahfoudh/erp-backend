import { ApiPropertyOptional } from '@nestjs/swagger';
import { TrackingType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Product METADATA edit (G1).
 *
 * **There is deliberately no price or cost field here.** `catalog.manage` is
 * catalog administration, not pricing authority, and the surest way to keep it
 * from implying `price.edit` is to give a metadata edit no field in which a
 * price could be smuggled. Selling price continues to come from its existing
 * sources (`Product.defaultPrice` as the fallback, `StockItem.price` per branch
 * for quantity stock); changing them belongs to the Pricing phase.
 *
 * `categoryId` accepts `null` to detach a product from its category. Every other
 * field is "absent means unchanged".
 */
export class UpdateProductDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  brand?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  model?: string;

  @ApiPropertyOptional({ maxLength: 120, nullable: true, description: 'Empty string clears the variant.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  variant?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'null detaches the category.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({
    enum: TrackingType,
    description: 'Rejected once any unit, stock, purchase or sale history exists.',
  })
  @IsOptional()
  @IsEnum(TrackingType)
  trackingType?: TrackingType;

  @ApiPropertyOptional({ maxLength: 64, description: 'Empty string clears the barcode. Must stay unique per company.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @ApiPropertyOptional({ description: 'Category-defined attribute values. Bounded in size and depth.' })
  @IsOptional()
  @IsObject()
  specifications?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  reorderThreshold?: number;
}
