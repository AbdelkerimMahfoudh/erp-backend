import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';

/**
 * Quick "Add Stock" for one product. The product's tracking type decides which
 * fields matter — the client never picks a mode:
 *   imei/serial → `identifier` (one unit)
 *   quantity    → `quantity` (+ optional `price`)
 */
export class QuickAddUnitDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId: string;

  @ApiPropertyOptional({ description: 'Per-unit identifier for imei/serial products', example: '123456789012347' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  identifier?: string;

  @ApiPropertyOptional({ description: 'Secondary IMEI (dual-SIM)', example: '123456789012354' })
  @IsOptional()
  @Matches(/^\d{15}$/, { message: 'imeiSecondary must be 15 digits' })
  imeiSecondary?: string;

  @ApiPropertyOptional({ minimum: 1, description: 'Quantity for quantity-tracked products' })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiProperty({ minimum: 0.01, description: 'Per-unit / per-item purchase cost' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  cost: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Selling price for quantity stock (else product default)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;
}
