import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RequestConnectionDto {
  /**
   * The other shop's public Store Account ID — 10 hex characters, non-secret by
   * design. Never the binary company id, which must not leave the server.
   */
  @ApiProperty({ minLength: 10, maxLength: 10, example: 'F62B8D1EEB' })
  @IsString()
  @Length(10, 10)
  publicStoreId: string;

  @ApiPropertyOptional({ maxLength: 255, description: 'A line about why you are asking' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class DecideConnectionDto {
  @ApiProperty({ description: 'true accepts, false rejects' })
  @IsBoolean()
  accept: boolean;

  @ApiPropertyOptional({ description: 'Version the request was read at' })
  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}

export class BlockConnectionDto {
  @ApiProperty({ description: 'true blocks, false lifts a block you placed' })
  @IsBoolean()
  blocked: boolean;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class CreateCounterpartyDto {
  /**
   * Never `connected_store`: that kind is created only by accepting a
   * connection, and letting it be posted directly would allow a company to
   * claim a relationship the other side never agreed to.
   */
  @ApiProperty({ enum: ['manual_store', 'manual_person'] })
  @IsIn(['manual_store', 'manual_person'])
  kind: 'manual_store' | 'manual_person';

  @ApiProperty({ minLength: 1, maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
