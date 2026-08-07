import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Price write payloads.
 *
 * There is deliberately **no `branchId`, `companyId`, `permission`, `model` or
 * `field`** in any of these. The branch comes from the request's active branch
 * context, which the guard has already proven the caller may act in; accepting
 * one in the body would let a caller aim an authorized write at a branch they
 * were never granted. Everything else is addressed by URL, so there is no
 * endpoint that can be pointed at an arbitrary table or permission.
 */

/** Money accepted from clients: 2 decimals, non-negative, and bounded. */
const MONEY = {
  min: 0,
  // DECIMAL(14,2) — stay inside the column rather than let MySQL truncate.
  max: 999_999_999_999.99,
};

export class SetPriceDto {
  @ApiProperty({ minimum: MONEY.min, maximum: MONEY.max, example: 17000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MONEY.min)
  @Max(MONEY.max)
  price!: number;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Version of the row being replaced. Required when a price already exists; omit only when creating the first one.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Required when the new price is below cost. Recorded in history.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RemovePriceDto {
  @ApiProperty({ minimum: 0, description: 'Version of the row being removed.' })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Quantity stock has no "remove" — the price is a column, not a row. */
export class SetQuantityPriceDto extends SetPriceDto {
  @ApiProperty({ minimum: 0, description: 'Version of the stock row (0029).' })
  @IsInt()
  @Min(0)
  declare expectedVersion: number;
}

export class PriceHistoryQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Keyset cursor: the last id seen.' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
