import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Return a single sold unit from a sale (2B granularity). */
export class ReturnSaleDto {
  @ApiProperty({ description: 'Unit identifier (IMEI or serial)', example: '123456789012347' })
  @IsString()
  @MaxLength(64)
  identifier: string;

  @ApiPropertyOptional({ default: true, description: 'Restock to in_stock (else mark faulty)' })
  @IsOptional()
  @IsBoolean()
  restock?: boolean;

  @ApiPropertyOptional({ minimum: 0, description: 'Refund amount (defaults to the line total)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  refundAmount?: number;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
