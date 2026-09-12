import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Max, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Finding a customer at the counter.
 *
 * One `search` box covers name and phone, because that is how a shopkeeper
 * thinks: they know who it is, or they have the number. `id` is separate and
 * exact — it is what the app sends back when a customer was already chosen for
 * this sale, and an exact lookup must never be a fuzzy one.
 */
export class ListCustomersDto {
  @ApiPropertyOptional({ description: 'Matches name or phone. Trimmed; empty means "everyone".' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Exact customer, by id.' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Keyset cursor from a previous page.' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

/**
 * Creating a customer from the till.
 *
 * Name only is deliberate. A shop taking a phone number it does not need is
 * collecting personal data for nothing, and the sale must not stall because
 * somebody would rather not give one. Everything else about the customer is
 * managed elsewhere.
 */
export class CreateCustomerDto {
  @ApiProperty({ maxLength: 160 })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'A customer needs a name to be found by later' })
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
