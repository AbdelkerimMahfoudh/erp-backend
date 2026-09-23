import { ApiPropertyOptional } from '@nestjs/swagger';
import { TrackingType, UnitStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class InventoryQueryDto {
  @ApiPropertyOptional({ enum: UnitStatus })
  @IsOptional()
  @IsEnum(UnitStatus)
  status?: UnitStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({
    enum: TrackingType,
    description:
      'Only stock of this tracking type (0076). `imei` is the Stock screen’s “Phones”; with `imei` or ' +
      '`serial` no quantity rows are returned. Ordering is unchanged — newest received first — so the ' +
      'first three phones here are the three Home shows as latest received.',
  })
  @IsOptional()
  @IsEnum(TrackingType)
  trackingType?: TrackingType;

  @ApiPropertyOptional({
    description:
      'Free text matched server-side against product name, variant, barcode, ' +
      'IMEI (both) and serial number. Searches the whole branch, not just the ' +
      'current page.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({
    description:
      'Opaque cursor from a previous response’s `nextCursor`. Pass it back ' +
      'verbatim; do not construct one.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
